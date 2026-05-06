/**
 * HMAC-signed claim tokens for the email-claim flow (T-017).
 *
 * A token is `<base64url(payload)>.<base64url(signature)>`. The payload
 * binds (agent_id, email, nonce, exp) so a leaked token can't be
 * replayed for a different email or after expiry, and can't be forged
 * without the server-side HMAC secret.
 *
 * Defense layers:
 *   - HMAC-SHA256 over payload bytes using API_KEY_HASH_SECRET — a
 *     leaked-but-not-stolen-with-secret token can't be modified.
 *   - `email` is in the payload, so a stolen token can't be replayed
 *     for a different email.
 *   - `exp` (unix seconds) — TTL.
 *   - `nonce` — caller stores nonce in DB and refuses second use,
 *     making tokens one-shot.
 *
 * Uses Web Crypto, runs in Cloudflare Workers and Node 20+.
 */

const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
export const CLAIM_TOKEN_TTL_MINUTES = TOKEN_TTL_SECONDS / 60;

export interface ClaimPayload {
  agent_id: string; // uuid
  email: string;
  nonce: string;    // 16+ random base62 chars
  exp: number;      // unix seconds
}

/**
 * Sign a claim payload, returning `<b64u(payload)>.<b64u(signature)>`.
 *
 * The payload is JSON-serialized with stable key ordering so that
 * verification reconstructs the exact same byte sequence.
 */
export async function signClaimToken(
  payload: ClaimPayload,
  secret: string,
): Promise<string> {
  const payloadJson = canonicalJson(payload);
  const payloadBytes = new TextEncoder().encode(payloadJson);
  const sigBytes = await hmacSign(secret, payloadBytes);
  return `${base64UrlEncode(payloadBytes)}.${base64UrlEncode(sigBytes)}`;
}

/**
 * Verify a claim token. Returns the parsed payload on success, or
 * null on bad signature, malformed token, or expired.
 *
 * @param token  the signed token from the magic link
 * @param secret API_KEY_HASH_SECRET
 * @param now    current time, unix seconds (injected for testability)
 */
export async function verifyClaimToken(
  token: string,
  secret: string,
  now: number,
): Promise<ClaimPayload | null> {
  if (typeof token !== "string" || token.length === 0) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts as [string, string];
  if (!payloadB64 || !sigB64) return null;

  let payloadBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    payloadBytes = base64UrlDecode(payloadB64);
    sigBytes = base64UrlDecode(sigB64);
  } catch {
    return null;
  }

  const ok = await hmacVerify(secret, sigBytes, payloadBytes);
  if (!ok) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (!isClaimPayload(payload)) return null;

  if (payload.exp <= now) return null;

  return payload;
}

/**
 * Generate a 16-char base62 nonce. Uses Web Crypto for entropy.
 * Roughly 95 bits of entropy — plenty for one-shot replay protection.
 */
export function generateNonce(): string {
  const alphabet =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % 62];
  return out;
}

/** Convenience: returns the unix-seconds expiry for a freshly-issued token. */
export function defaultExpiry(now: number = Math.floor(Date.now() / 1000)): number {
  return now + TOKEN_TTL_SECONDS;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isClaimPayload(v: unknown): v is ClaimPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.agent_id === "string" &&
    typeof o.email === "string" &&
    typeof o.nonce === "string" &&
    typeof o.exp === "number" &&
    Number.isFinite(o.exp)
  );
}

/**
 * JSON.stringify with a fixed key order so signing+verifying produce
 * the same bytes regardless of how the caller built the object.
 */
function canonicalJson(p: ClaimPayload): string {
  return JSON.stringify({
    agent_id: p.agent_id,
    email: p.email,
    nonce: p.nonce,
    exp: p.exp,
  });
}

async function hmacSign(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return new Uint8Array(sig);
}

async function hmacVerify(
  secret: string,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, data);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  // Reject any non-b64url chars to fail fast on malformed input.
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("invalid base64url");
  let normalized = s.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";
  const bin = atob(normalized);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
