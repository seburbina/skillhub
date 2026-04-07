/**
 * Stateless magic-link claim tokens for the email-based agent claim flow.
 *
 * Token shape:  <expires_ms>.<base64url(payload)>.<hex(HMAC)>
 *   payload: JSON({agent_id, email})
 *   HMAC:    HMAC-SHA256(API_KEY_HASH_SECRET, "agent_id|email|expires_ms")
 *
 * No DB row needed. The first time the link is clicked, the server checks
 * the HMAC + expiry, then sets agents.owner_user_id (if not already set)
 * and marks the user verified. Idempotent on second click — first wins.
 *
 * TTL: 60 minutes.
 */

const TOKEN_TTL_MINUTES = 60;
const TOKEN_TTL_MS = TOKEN_TTL_MINUTES * 60 * 1000;

export const CLAIM_TOKEN_TTL_MINUTES = TOKEN_TTL_MINUTES;

export interface ClaimTokenPayload {
  agent_id: string;
  email: string;
}

interface ClaimTokenEnv {
  API_KEY_HASH_SECRET: string;
}

/** Generate a magic-link token. Returns the token string. */
export async function generateClaimToken(
  payload: ClaimTokenPayload,
  env: ClaimTokenEnv,
): Promise<string> {
  const expiresMs = Date.now() + TOKEN_TTL_MS;
  const payloadB64 = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const sig = await sign(payload, expiresMs, env);
  return `${expiresMs}.${payloadB64}.${sig}`;
}

export interface ClaimTokenVerifyResult {
  ok: true;
  agent_id: string;
  email: string;
}
export interface ClaimTokenError {
  ok: false;
  reason: "malformed" | "expired" | "bad_signature";
}

/** Verify a magic-link token. Returns the parsed payload on success. */
export async function verifyClaimToken(
  token: string,
  env: ClaimTokenEnv,
): Promise<ClaimTokenVerifyResult | ClaimTokenError> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [expiresMsStr, payloadB64, gotSig] = parts as [string, string, string];

  const expiresMs = Number(expiresMsStr);
  if (!Number.isFinite(expiresMs)) return { ok: false, reason: "malformed" };
  if (Date.now() > expiresMs) return { ok: false, reason: "expired" };

  let payload: ClaimTokenPayload;
  try {
    const decoded = new TextDecoder().decode(base64UrlDecode(payloadB64));
    payload = JSON.parse(decoded);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload.agent_id || !payload.email) {
    return { ok: false, reason: "malformed" };
  }

  const expectedSig = await sign(payload, expiresMs, env);
  if (expectedSig !== gotSig) {
    return { ok: false, reason: "bad_signature" };
  }

  return { ok: true, agent_id: payload.agent_id, email: payload.email };
}

// ---------------------------------------------------------------------------
// Crypto helpers (Web Crypto)
// ---------------------------------------------------------------------------

async function sign(
  payload: ClaimTokenPayload,
  expiresMs: number,
  env: ClaimTokenEnv,
): Promise<string> {
  const enc = new TextEncoder();
  const message = `${payload.agent_id}|${payload.email}|${expiresMs}`;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(env.API_KEY_HASH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bufferToHex(sig);
}

function bufferToHex(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf);
  let hex = "";
  for (const b of arr) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
