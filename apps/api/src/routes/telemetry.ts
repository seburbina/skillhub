import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { makeDb } from "@/db";
import { invocations, ratings, skills } from "@/db/schema";
import { getAgent, requireAgent } from "@/lib/auth";
import { isNewUnverifiedAgent } from "@/lib/challenge";
import { errorResponse } from "@/lib/http";
import { LIMITS, checkRateLimit, rateLimitKey } from "@/lib/ratelimit";
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

telemetry.post("/invocations/start", async (c) => {
  const agent = getAgent(c);
  const db = makeDb(c.env);

  const rl = await checkRateLimit(
    db,
    rateLimitKey("agent", agent.id, "telemetry", agent.tenantId),
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

  const [invocation] = await db
    .insert(invocations)
    .values({
      skillId: body.skill_id,
      versionId: body.version_id,
      invokingAgentId: agent.id,
      sessionHash: body.session_hash ?? null,
      clientMeta: body.client_meta ?? null,
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
