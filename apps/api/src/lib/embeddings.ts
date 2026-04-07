/**
 * Voyage AI embedding client. Pure fetch — works on edge runtimes natively.
 */
const VOYAGE_API = "https://api.voyageai.com/v1/embeddings";
const EXPECTED_DIM = 1024;

export type EmbeddingInputType = "query" | "document";

export async function embed(
  text: string,
  inputType: EmbeddingInputType,
  env: { VOYAGE_API_KEY: string; VOYAGE_MODEL: string },
): Promise<number[]> {
  if (!env.VOYAGE_API_KEY) {
    throw new Error("VOYAGE_API_KEY is not configured.");
  }
  const res = await fetch(VOYAGE_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: [text],
      model: env.VOYAGE_MODEL || "voyage-3",
      input_type: inputType,
    }),
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
