import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { makeDb } from "@/db";
import { invocations, ratings, skills } from "@/db/schema";
import { getAgent, requireAgent } from "@/lib/auth";
import { isNewUnverifiedAgent } from "@/lib/challenge";
import { errorResponse } from "@/lib/http";
import { LIMITS, checkRateLimit } from "@/lib/ratelimit";
import type { Env } from "@/types";

export const telemetry = new Hono<Env>();

telemetry.use("/*", requireAgent);

// ---------------------------------------------------------------------------
// POST /v1/telemetry/invocations/start
// ---------------------------------------------------------------------------

const StartBody = z.object({
  skill_id: z.string().uuid(),
  version_id: z.string().uuid(),
  session_hash: z.string().min(1).max(128).optional(),
  client_meta: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// client_meta hardening — anti-exfiltration filter
//
// Telemetry is an anonymous authenticated endpoint that any installed skill
// can call. Without filtering, a rogue skill could use client_meta as a
// covert channel to smuggle secrets out of the session (API keys, tokens,
// cookies, file contents) and stash them in the DB for later retrieval.
//
// Rules:
//   - Reject top-level keys that name credential fields outright.
//   - Cap depth (≤4) and total serialized size (≤8 KiB).
//   - Strip values that look like secrets (long high-entropy strings or
//     anything matching the existing regex scrub's block-tier patterns).
//
// The function returns `null` if client_meta cannot be sanitized at all
// (too large, too deep), otherwise returns the sanitized clone.
// ---------------------------------------------------------------------------

const FORBIDDEN_META_KEY =
  /token|secret|password|api[_-]?key|authorization|cookie|session/i;

const MAX_META_DEPTH = 4;
const MAX_META_BYTES = 8 * 1024;

// Very long string values — drop them regardless of entropy. Paired with
// the forbidden-key filter this covers the "long token in a bland key" case.
const MAX_META_STRING_LEN = 512;

const SECRETISH_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{36}\b/,
  /\bgho_[A-Za-z0-9]{36}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

function looksLikeSecret(s: string): boolean {
  if (s.length > MAX_META_STRING_LEN) return true;
  for (const rx of SECRETISH_PATTERNS) {
    if (rx.test(s)) return true;
  }
  return false;
}

type SanitizeOutcome =
  | { ok: true; value: Record<string, unknown> | null }
  | { ok: false; reason: string };

function sanitizeClientMeta(raw: unknown): SanitizeOutcome {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "client_meta must be an object" };
  }

  const serializedLen = (() => {
    try {
      return JSON.stringify(raw).length;
    } catch {
      return Infinity;
    }
  })();
  if (serializedLen > MAX_META_BYTES) {
    return {
      ok: false,
      reason: `client_meta exceeds ${MAX_META_BYTES} byte limit (${serializedLen})`,
    };
  }

  const walk = (node: unknown, depth: number): unknown => {
    if (depth > MAX_META_DEPTH) return "<depth_limit>";
    if (node === null) return null;
    if (typeof node === "string") {
      return looksLikeSecret(node) ? "<redacted>" : node;
    }
    if (typeof node === "number" || typeof node === "boolean") return node;
    if (Array.isArray(node)) {
      return node.slice(0, 64).map((item) => walk(item, depth + 1));
    }
    if (typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (FORBIDDEN_META_KEY.test(key)) continue;
        out[key] = walk(value, depth + 1);
      }
      return out;
    }
    return undefined;
  };

  const cleaned = walk(raw, 1) as Record<string, unknown>;
  return { ok: true, value: cleaned };
}

telemetry.post("/invocations/start", async (c) => {
  const agent = getAgent(c);
  const db = makeDb(c.env);

  const rl = await checkRateLimit(
    db,
    `agent:${agent.id}:telemetry`,
    LIMITS.telemetry,
    isNewUnverifiedAgent(agent),
  );
  if (!rl.allowed) {
    return errorResponse(c, "rate_limited", "Telemetry rate limit exceeded.", {
      retryAfterSeconds: rl.retryAfterSeconds,
    });
  }

  const parsed = StartBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(c, "invalid_input", "Invalid invocation start body.", {
      details: parsed.error.issues,
    });
  }
  const body = parsed.data;

  // Anti-exfiltration: telemetry client_meta is an authenticated endpoint
  // any installed skill can call. Strip credential-shaped values before
  // persisting so it can't be abused as a covert exfiltration channel.
  const sanitized = sanitizeClientMeta(body.client_meta);
  if (!sanitized.ok) {
    return errorResponse(c, "invalid_input", sanitized.reason);
  }

  const [invocation] = await db
    .insert(invocations)
    .values({
      skillId: body.skill_id,
      versionId: body.version_id,
      invokingAgentId: agent.id,
      sessionHash: body.session_hash ?? null,
      clientMeta: sanitized.value,
    })
    .returning();

  if (!invocation) {
    return errorResponse(c, "server_error", "Failed to create invocation.");
  }

  await db
    .update(skills)
    .set({ installCount: sql`${skills.installCount} + 1` })
    .where(eq(skills.id, body.skill_id));

  return c.json({ invocation_id: invocation.id });
});

// ---------------------------------------------------------------------------
// POST /v1/telemetry/invocations/:id/end
// ---------------------------------------------------------------------------

const EndBody = z.object({
  duration_ms: z.number().int().nonnegative().max(24 * 3600 * 1000),
  follow_up_iterations: z.number().int().nonnegative().max(1000),
  outcome: z.enum(["success", "partial", "failure", "unknown"]).default("unknown"),
});

telemetry.post("/invocations/:id/end", async (c) => {
  const agent = getAgent(c);
  const db = makeDb(c.env);
  const id = c.req.param("id");

  const parsed = EndBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(c, "invalid_input", "Invalid invocation end body.", {
      details: parsed.error.issues,
    });
  }
  const body = parsed.data;

  const rows = await db
    .update(invocations)
    .set({
      endedAt: new Date(),
      durationMs: body.duration_ms,
      followUpIterations: body.follow_up_iterations,
      outcome: body.outcome,
    })
    .where(
      and(eq(invocations.id, id), eq(invocations.invokingAgentId, agent.id)),
    )
    .returning();

  if (rows.length === 0) {
    return errorResponse(
      c,
      "not_found",
      "Invocation not found (or not owned by this agent).",
    );
  }

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /v1/telemetry/invocations/:id/rate
// ---------------------------------------------------------------------------

const RateBody = z.object({
  value: z.union([z.literal(-1), z.literal(1)]),
  comment: z.string().max(500).optional(),
});

telemetry.post("/invocations/:id/rate", async (c) => {
  const agent = getAgent(c);
  const db = makeDb(c.env);
  const id = c.req.param("id");

  const parsed = RateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(c, "invalid_input", "Invalid rating body.", {
      details: parsed.error.issues,
    });
  }
  const { value, comment } = parsed.data;

  const invocationRows = await db
    .select({
      id: invocations.id,
      skillId: invocations.skillId,
      invokingAgentId: invocations.invokingAgentId,
      authorAgentId: skills.authorAgentId,
    })
    .from(invocations)
    .innerJoin(skills, eq(skills.id, invocations.skillId))
    .where(eq(invocations.id, id))
    .limit(1);

  const row = invocationRows[0];
  if (!row) return errorResponse(c, "not_found", "Invocation not found.");
  if (row.authorAgentId === agent.id) {
    return errorResponse(c, "forbidden", "Cannot rate a skill you authored.");
  }
  if (row.invokingAgentId !== agent.id) {
    return errorResponse(c, "forbidden", "Cannot rate an invocation you didn't make.");
  }

  await db
    .insert(ratings)
    .values({
      invocationId: id,
      raterAgentId: agent.id,
      value,
      comment: comment ?? null,
    })
    .onConflictDoUpdate({
      target: ratings.invocationId,
      set: { value, comment: comment ?? null },
    });

  await db
    .update(invocations)
    .set({ rating: value })
    .where(eq(invocations.id, id));

  return c.json({ ok: true });
});
