/**
 * API key authentication for agent-to-service calls.
 *
 * Token shape: `skh_live_<32 base62>`.
 *
 * On registration we generate a raw key, return it to the client ONCE, and
 * store an HMAC-SHA256 hash (keyed by `API_KEY_HASH_SECRET`) in
 * `agents.api_key_hash`. Lookups are O(1) on the hash column.
 *
 * HMAC instead of plain SHA-256 so that a DB leak alone isn't enough to
 * brute-force valid keys — the attacker would also need the server secret.
 */
import { createHmac, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import type { Agent } from "@/db/schema";
import { errorResponse } from "@/lib/http";

const KEY_PREFIX = process.env.AGENT_KEY_PREFIX ?? "skh_live_";
const HASH_SECRET = process.env.API_KEY_HASH_SECRET ?? "";

if (!HASH_SECRET && process.env.NODE_ENV === "production") {
  console.error("[auth] API_KEY_HASH_SECRET is not set in production");
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

const BASE62 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Generate a fresh API key. Returns { raw, hash, prefix }. */
export function generateApiKey(): {
  raw: string;
  hash: string;
  prefix: string;
} {
  const randomPart = randomBase62(32);
  const raw = `${KEY_PREFIX}${randomPart}`;
  return {
    raw,
    hash: hashApiKey(raw),
    prefix: raw.slice(0, 12), // "skh_live_" + first 3 random chars = safe to display
  };
}

export function hashApiKey(rawKey: string): string {
  return createHmac("sha256", HASH_SECRET).update(rawKey).digest("hex");
}

function randomBase62(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += BASE62[bytes[i]! % 62];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface AuthedAgent {
  agent: Agent;
  rawKey: string;
}

/**
 * Extract the bearer token from a Request. Returns null on missing/malformed.
 */
export function extractBearer(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) return null;
  const token = match[1]!.trim();
  return token.length > 0 ? token : null;
}

/**
 * Look up an agent by API key. Returns null if no match or if the agent has
 * been revoked.
 */
export async function agentFromKey(rawKey: string): Promise<Agent | null> {
  if (!rawKey.startsWith(KEY_PREFIX)) return null;
  const hash = hashApiKey(rawKey);
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.apiKeyHash, hash))
    .limit(1);
  const agent = rows[0];
  if (!agent) return null;
  if (agent.revokedAt) return null;
  return agent;
}

/**
 * Route helper: require an authenticated agent. Returns either the agent
 * or a ready-to-return 401/403 response.
 */
export async function requireAgent(
  request: Request,
): Promise<{ agent: Agent } | { response: Response }> {
  const token = extractBearer(request);
  if (!token) {
    return {
      response: errorResponse(
        "unauthorized",
        "Missing bearer token.",
        { hint: "Send `Authorization: Bearer skh_live_...`." },
      ),
    };
  }
  const agent = await agentFromKey(token);
  if (!agent) {
    return {
      response: errorResponse("unauthorized", "Invalid or revoked API key.", {
        hint: "Run `identity.py rotate` or re-register.",
      }),
    };
  }
  return { agent };
}
