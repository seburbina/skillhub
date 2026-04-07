/**
 * Voyage AI embedding client.
 *
 * Used server-side to embed skill descriptions at publish time and to embed
 * search queries at discovery time. Stored in pgvector's `vector(1024)`.
 *
 * Keep output dim in sync with the `vector(1024)` column in schema.ts.
 */

const VOYAGE_API = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY ?? "";
const VOYAGE_MODEL = process.env.VOYAGE_MODEL ?? "voyage-3";
const EXPECTED_DIM = 1024;

/** Input mode: "query" for search queries, "document" for indexing. */
export type EmbeddingInputType = "query" | "document";

export async function embed(
  text: string,
  inputType: EmbeddingInputType = "document",
): Promise<number[]> {
  if (!VOYAGE_API_KEY) {
    throw new Error("VOYAGE_API_KEY is not configured.");
  }
  const body = {
    input: [text],
    model: VOYAGE_MODEL,
    input_type: inputType,
  };
  const res = await fetch(VOYAGE_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Voyage API error (${res.status}): ${errText}`);
  }
  const json = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
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
