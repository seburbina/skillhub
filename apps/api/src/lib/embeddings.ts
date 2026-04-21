/**
 * Embedding client — prefers Cloudflare Workers AI, falls back to Voyage.
 *
 * Workers AI (@cf/baai/bge-large-en-v1.5) returns 1024-dim vectors, which
 * matches the `skills.embedding vector(1024)` column exactly. It's a Worker
 * binding (env.AI), no API key management, and the free tier covers our
 * traffic (10K neurons/day; ~130 calls/day free).
 *
 * Voyage is retained as a fallback so that:
 *   - Local/offline tooling (scripts/embed-mirror-batch.mjs) can still run
 *     by setting VOYAGE_API_KEY and pointing at the prod DB.
 *   - A future switch back is one code change, not a schema migration.
 *
 * Dimension is fixed at 1024 for both backends (bge-large-en-v1.5 for CF,
 * voyage-3 for Voyage — same shape).
 */

import { readEmbeddingCache, writeEmbeddingCache } from "./embedding-cache";

const EXPECTED_DIM = 1024;
const DEFAULT_CF_MODEL = "@cf/baai/bge-large-en-v1.5";
const VOYAGE_API = "https://api.voyageai.com/v1/embeddings";

export type EmbeddingInputType = "query" | "document";

export interface EmbeddingEnv {
  AI?: Ai;
  VOYAGE_API_KEY?: string;
  VOYAGE_MODEL?: string;
  CF_AI_EMBEDDING_MODEL?: string;
}

/**
 * Embed text. For `inputType === "query"` we consult a per-colo cache
 * first (24h TTL, keyed by SHA-256 of lowercased-trimmed text) so that
 * repeat searches for the same terms skip the Workers-AI hop entirely.
 * Document embeddings are NOT cached — they're one-shot work that
 * happens at publish / reembed time, not per-request.
 */
export async function embed(
  text: string,
  inputType: EmbeddingInputType,
  env: EmbeddingEnv,
): Promise<number[]> {
  const model = resolveModel(env);

  if (inputType === "query") {
    const hit = await readEmbeddingCache(text, "query", model);
    if (hit) return hit;
  }

  const vec = await embedUncached(text, inputType, env);

  if (inputType === "query") {
    // Fire-and-forget — cache write must not block the hot path.
    void writeEmbeddingCache(text, "query", model, vec);
  }

  return vec;
}

function resolveModel(env: EmbeddingEnv): string {
  if (env.AI) return env.CF_AI_EMBEDDING_MODEL || DEFAULT_CF_MODEL;
  return env.VOYAGE_MODEL || "voyage-3";
}

async function embedUncached(
  text: string,
  inputType: EmbeddingInputType,
  env: EmbeddingEnv,
): Promise<number[]> {
  if (env.AI) {
    return embedViaWorkersAI(text, env);
  }
  if (env.VOYAGE_API_KEY) {
    return embedViaVoyage(text, inputType, env.VOYAGE_API_KEY, env.VOYAGE_MODEL);
  }
  throw new Error(
    "No embedding backend configured — add an [ai] binding to wrangler.toml (preferred) or set VOYAGE_API_KEY.",
  );
}

async function embedViaWorkersAI(text: string, env: EmbeddingEnv): Promise<number[]> {
  const model = env.CF_AI_EMBEDDING_MODEL || DEFAULT_CF_MODEL;
  // Workers AI's embeddings output is `{ shape, data: number[][] }` where
  // each inner array is one embedding. Type casts because the `Ai` binding
  // returns a loose `AiTextEmbeddingsOutput` from @cloudflare/workers-types.
  const res = (await env.AI!.run(model as never, { text: [text] } as never)) as {
    shape?: number[];
    data?: number[][];
  };
  const vec = res?.data?.[0];
  if (!vec || vec.length !== EXPECTED_DIM) {
    throw new Error(
      `Workers AI returned unexpected shape: got length ${vec?.length ?? "undefined"}, expected ${EXPECTED_DIM} (model=${model})`,
    );
  }
  return vec;
}

async function embedViaVoyage(
  text: string,
  inputType: EmbeddingInputType,
  apiKey: string,
  model: string | undefined,
): Promise<number[]> {
  const res = await fetch(VOYAGE_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: [text],
      model: model || "voyage-3",
      input_type: inputType,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Voyage API error (${res.status}): ${errText}`);
  }
  const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const embedding = json.data?.[0]?.embedding;
  if (!embedding || embedding.length !== EXPECTED_DIM) {
    throw new Error(
      `Voyage returned unexpected shape: got length ${embedding?.length ?? "undefined"}, expected ${EXPECTED_DIM}`,
    );
  }
  return embedding;
}

/** Serialize a number[] as the pgvector literal `[1,2,3]`. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
