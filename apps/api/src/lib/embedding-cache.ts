/**
 * Per-colo cache for query embeddings, using the Cloudflare Cache API.
 *
 * Hot-path optimization: `/v1/skills/search` and `/v1/skills/suggest`
 * embed the user's query before the vector similarity SELECT. The embed
 * call (Workers AI Run → bge-large-en-v1.5) is the dominant contributor
 * to ~500ms search latency. Users frequently search the same terms
 * ("vue", "postgres", "how do i…") so caching the query embedding by
 * hashed query text eliminates the AI hop on repeat calls.
 *
 * Implementation notes:
 *   - We use `caches.default` (per-colo, zero-setup) rather than a KV
 *     binding. Hit rate is lower (cache is per edge location) but the
 *     latency win is still meaningful and there's no operational burden.
 *   - Cache key is a synthetic URL under a reserved host so it can't
 *     collide with user-visible caches.
 *   - Embedding is stored gzipped-JSON to cut bandwidth, with a 24h TTL.
 *   - The `inputType` ("query" vs "document") is part of the key because
 *     bge/voyage produce different vectors for each mode.
 *   - The cached value is bound to the model name, so changing the
 *     default model invalidates the cache automatically.
 */

const CACHE_HOST = "https://embed-cache.internal";
const CACHE_VERSION = "v1";
const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24h

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cacheKeyUrl(hash: string, model: string, inputType: string): string {
  const safeModel = encodeURIComponent(model);
  return `${CACHE_HOST}/${CACHE_VERSION}/${safeModel}/${inputType}/${hash}`;
}

/** Look up a cached embedding. Returns null on miss. */
export async function readEmbeddingCache(
  text: string,
  inputType: "query" | "document",
  model: string,
): Promise<number[] | null> {
  if (typeof caches === "undefined" || !caches.default) return null;
  try {
    const hash = await sha256Hex(text.toLowerCase().trim());
    const req = new Request(cacheKeyUrl(hash, model, inputType));
    const hit = await caches.default.match(req);
    if (!hit) return null;
    const vec = (await hit.json()) as number[];
    return Array.isArray(vec) && vec.length > 0 ? vec : null;
  } catch {
    return null;
  }
}

/** Store an embedding in the colo cache. Fire-and-forget is fine for callers. */
export async function writeEmbeddingCache(
  text: string,
  inputType: "query" | "document",
  model: string,
  vector: number[],
): Promise<void> {
  if (typeof caches === "undefined" || !caches.default) return;
  try {
    const hash = await sha256Hex(text.toLowerCase().trim());
    const req = new Request(cacheKeyUrl(hash, model, inputType));
    const body = JSON.stringify(vector);
    const res = new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
      },
    });
    await caches.default.put(req, res);
  } catch {
    /* cache write is best-effort */
  }
}
