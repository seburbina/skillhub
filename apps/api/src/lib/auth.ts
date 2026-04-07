/**
 * API key generation, hashing, and authentication — Web Crypto edition.
 *
 * Token shape: `skh_live_<32 base62>`. We store an HMAC-SHA256 hash
 * (keyed by `API_KEY_HASH_SECRET`) in `agents.api_key_hash`. HMAC instead
 * of plain SHA-256 so a DB leak alone isn't enough to brute-force keys.
 *
 * Web Crypto's `crypto.subtle.sign('HMAC', ...)` is the edge equivalent
 * of `createHmac` from `node:crypto`. Same algorithm, different API.
 */
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { makeDb } from "@/db";
import { agents, type Agent } from "@/db/schema";
import type { Env } from "@/types";
import { errorResponse } from "@/lib/http";

const BASE62 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

/** Generate a fresh API key. Returns { raw, hash, prefix }. */
export async function generateApiKey(
  hashSecret: string,
  prefix: string,
): Promise<{ raw: string; hash: string; prefix: string }> {
  const random = randomBase62(32);
  const raw = `${prefix}${random}`;
  return {
    raw,
    hash: await hashApiKey(raw, hashSecret),
    prefix: raw.slice(0, 12),
  };
}

/** HMAC-SHA256 of `rawKey` with `hashSecret` as the HMAC key, hex-encoded. */
export async function hashApiKey(
  rawKey: string,
  hashSecret: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(hashSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawKey));
  return bufferToHex(sig);
}

function randomBase62(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += BASE62[bytes[i]! % 62];
  }
  return out;
}

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** Extract bearer token from a request. Returns null if missing/malformed. */
export function extractBearer(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match?.[1]?.trim() || null;
}

/** Look up an agent by API key. Returns null if no match or revoked. */
export async function agentFromKey(
  rawKey: string,
  env: { DATABASE_URL: string; API_KEY_HASH_SECRET: string; AGENT_KEY_PREFIX: string },
): Promise<Agent | null> {
  if (!rawKey.startsWith(env.AGENT_KEY_PREFIX)) return null;
  const hash = await hashApiKey(rawKey, env.API_KEY_HASH_SECRET);
  const db = makeDb(env);
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.apiKeyHash, hash))
    .limit(1);
  const agent = rows[0];
  if (!agent || agent.revokedAt) return null;
  return agent;
}

/**
 * Hono middleware: require an authenticated agent. On success, sets
 * `c.set('agent', agent)`. On failure, returns 401.
 *
 * Use as: `app.use('/v1/agents/me/*', requireAgent)`
 */
export async function requireAgent(c: Context<Env>, next: () => Promise<void>) {
  const token = extractBearer(c.req.raw);
  if (!token) {
    return errorResponse(c, "unauthorized", "Missing bearer token.", {
      hint: "Send `Authorization: Bearer skh_live_...`.",
    });
  }
  const agent = await agentFromKey(token, c.env);
  if (!agent) {
    return errorResponse(c, "unauthorized", "Invalid or revoked API key.", {
      hint: "Run `identity.py rotate` or re-register.",
    });
  }
  c.set("agent", agent);
  await next();
}

/** Helper to read the authenticated agent from a route handler. */
export function getAgent(c: Context<Env>): Agent {
  const agent = c.get("agent");
  if (!agent) {
    throw new Error("getAgent called without requireAgent middleware");
  }
  return agent;
}
