/**
 * Admin API — operator-only maintenance endpoints.
 *
 * Mounted at /v1/admin. Gated by a bearer token equal to env.ADMIN_TOKEN
 * (set via `wrangler secret put ADMIN_TOKEN`). Kept separate from the
 * host-based admin UI (src/routes/admin.ts, Cloudflare-Access-gated) so
 * these endpoints can be curled directly from a laptop without spawning
 * a browser session.
 */
import { Hono } from "hono";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { makeDb } from "@/db";
import { skills } from "@/db/schema";
import { embedSkill } from "@/jobs/embed-skill";
import { clientIp, errorResponse } from "@/lib/http";
import { LIMITS, checkRateLimit, rateLimitKey } from "@/lib/ratelimit";
import type { Env } from "@/types";

export const adminApi = new Hono<Env>();

// Rate limit — caps the blast radius if ADMIN_TOKEN leaks (60/min/ip).
// Also stops a misconfigured operator script from running away with
// Workers AI quota. Runs BEFORE the bearer check so an unauthed attacker
// can't probe for the token through the gate.
adminApi.use("*", async (c, next) => {
  const ip = clientIp(c);
  const db = makeDb(c.env);
  const rl = await checkRateLimit(db, rateLimitKey("ip", ip, "admin"), LIMITS.admin);
  if (!rl.allowed) {
    return errorResponse(c, "rate_limited", "Admin rate limit exceeded.", {
      retryAfterSeconds: rl.retryAfterSeconds,
    });
  }
  await next();
});

// Bearer-token gate. Constant-time compare to avoid trivial timing leaks.
adminApi.use("*", async (c, next) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token) {
    return errorResponse(c, "server_error", "ADMIN_TOKEN is not configured on the Worker.");
  }
  const header = c.req.header("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (presented.length !== token.length || !timingSafeEqual(presented, token)) {
    return errorResponse(c, "forbidden", "Invalid admin token.");
  }
  await next();
});

/**
 * POST /v1/admin/reembed-all
 *
 * Re-embeds every skill (or just the ones missing an embedding, via
 * ?only_missing=true). Embeddings happen inside this Worker, so they run
 * against env.AI (Workers AI) for free.
 *
 * Because Workers invocations have per-request CPU/time limits, we fan out
 * the work via ctx.waitUntil in small batches and return immediately with
 * the enqueued count. Run repeatedly until `embedded_count == total_count`.
 *
 * Query params:
 *   only_missing=true|false  (default true)
 *   batch_size=N              (default 25, max 100)
 */
adminApi.post("/reembed-all", async (c) => {
  const db = makeDb(c.env);
  const onlyMissing = (c.req.query("only_missing") ?? "true") !== "false";
  const batchSize = Math.min(100, Math.max(1, Number(c.req.query("batch_size") ?? "25")));

  const rowsQuery = db.select({ id: skills.id }).from(skills);
  const rows = onlyMissing
    ? await rowsQuery.where(sql`embedding IS NULL AND deleted_at IS NULL`).limit(batchSize)
    : await rowsQuery.where(isNotNull(skills.id)).limit(batchSize);

  const total = await db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(skills)
    .where(
      onlyMissing
        ? sql`embedding IS NULL AND deleted_at IS NULL`
        : sql`deleted_at IS NULL`,
    );

  // Fire-and-forget per-skill embed. Each call is independent, so failures
  // in one don't break the batch.
  for (const row of rows) {
    c.executionCtx.waitUntil(
      embedSkill(c.env, row.id).catch((e) =>
        console.warn("[reembed-all]", row.id, (e as Error).message),
      ),
    );
  }

  return c.json({
    ok: true,
    enqueued: rows.length,
    batch_size: batchSize,
    only_missing: onlyMissing,
    remaining_before_batch: total[0]?.c ?? null,
    note: "Re-run this endpoint until `remaining_before_batch` reaches 0.",
  });
});

/**
 * GET /v1/admin/embed-status
 * Quick counts for monitoring a re-embed pass.
 */
adminApi.get("/embed-status", async (c) => {
  const db = makeDb(c.env);
  const [row] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      embedded: sql<number>`COUNT(embedding)::int`,
      mirrored_missing: sql<number>`COUNT(*) FILTER (WHERE mirrored_from IS NOT NULL AND embedding IS NULL)::int`,
    })
    .from(skills)
    .where(sql`deleted_at IS NULL`);
  return c.json(row ?? { total: 0, embedded: 0, mirrored_missing: 0 });
});

// ---------------------------------------------------------------------------
// POST /v1/admin/yank-mirrored
//
// Soft-deletes every mirrored skill sourced from the given upstream repo
// (e.g. after a DMCA / author-opt-out request). Sets `deleted_at = NOW()`
// on the skills row — the row is retained for audit, but visibility
// predicates exclude it everywhere (search, profile, well-known). R2
// objects are NOT deleted automatically; purge via `wrangler r2 object
// delete` once the soft-delete has propagated.
//
// Body: { upstream_url: string, reason?: string }
// ---------------------------------------------------------------------------

const YankBody = z.object({
  upstream_url: z.string().url(),
  reason: z.string().max(500).optional(),
});

adminApi.post("/yank-mirrored", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = YankBody.safeParse(body);
  if (!parsed.success) {
    return errorResponse(c, "invalid_input", "upstream_url (required) and optional reason.", {
      details: parsed.error.issues,
    });
  }
  const { upstream_url, reason } = parsed.data;
  const db = makeDb(c.env);

  const yanked = await db
    .update(skills)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(skills.upstreamUrl, upstream_url),
        sql`${skills.deletedAt} IS NULL`,
        isNotNull(skills.mirroredFrom),
      ),
    )
    .returning({ id: skills.id, slug: skills.slug, originalAuthor: skills.originalAuthor });

  return c.json({
    ok: true,
    upstream_url,
    reason: reason ?? null,
    yanked_count: yanked.length,
    yanked_slugs: yanked.map((s) => s.slug),
    note: "Soft-deleted. R2 objects retained — purge via `wrangler r2 object delete` per slug.",
  });
});

// ---------------------------------------------------------------------------
// POST /v1/admin/classify-mirrored
//
// Uses Workers AI (Llama 3 instruct) to populate `category` + `tags` for
// mirrored skills that lack them. Fan-out is capped via batch_size; the
// enqueued LLM calls run inside ctx.waitUntil.
//
// Query params:
//   batch_size=N   (default 10, max 50)
// ---------------------------------------------------------------------------

const CLASSIFY_PROMPT = `You are a skill classifier for a developer-tools registry.
Given the title and description of a skill, output strict JSON:
{"category": "<one of: frontend, backend, database, devops, testing, design, marketing, content, ai-ml, mobile, data, security, other>", "tags": ["<tag>", ...up to 5 lowercase kebab-case tags]}
No prose. No code fences. JSON only.`;

adminApi.post("/classify-mirrored", async (c) => {
  const db = makeDb(c.env);
  const batchSize = Math.min(50, Math.max(1, Number(c.req.query("batch_size") ?? "10")));

  const rows = await db
    .select({
      id: skills.id,
      displayName: skills.displayName,
      shortDesc: skills.shortDesc,
    })
    .from(skills)
    .where(
      sql`${skills.mirroredFrom} IS NOT NULL
          AND ${skills.category} IS NULL
          AND (${skills.tags} IS NULL OR array_length(${skills.tags}, 1) IS NULL)
          AND ${skills.deletedAt} IS NULL`,
    )
    .limit(batchSize);

  const [{ remaining } = { remaining: 0 }] = await db
    .select({ remaining: sql<number>`COUNT(*)::int` })
    .from(skills)
    .where(
      sql`${skills.mirroredFrom} IS NOT NULL
          AND ${skills.category} IS NULL
          AND (${skills.tags} IS NULL OR array_length(${skills.tags}, 1) IS NULL)
          AND ${skills.deletedAt} IS NULL`,
    );

  if (!c.env.AI) {
    return errorResponse(
      c,
      "server_error",
      "Workers AI binding (env.AI) is required for classification. Add [ai] binding in wrangler.toml.",
    );
  }

  for (const row of rows) {
    c.executionCtx.waitUntil(classifyOne(c.env, row).catch((e) =>
      console.warn("[classify-mirrored]", row.id, (e as Error).message),
    ));
  }

  return c.json({
    ok: true,
    enqueued: rows.length,
    batch_size: batchSize,
    remaining_before_batch: remaining,
    note: "Re-run until remaining reaches 0.",
  });
});

async function classifyOne(
  env: Env["Bindings"],
  row: { id: string; displayName: string; shortDesc: string },
): Promise<void> {
  const input = `Title: ${row.displayName}\nDescription: ${row.shortDesc}`;
  const result = (await env.AI.run("@cf/meta/llama-3.1-8b-instruct" as never, {
    messages: [
      { role: "system", content: CLASSIFY_PROMPT },
      { role: "user", content: input },
    ],
    max_tokens: 200,
  } as never)) as { response?: string };
  if (!result?.response) return;
  // Extract the first {...} block from the response — models sometimes
  // still wrap in code fences or add stray whitespace.
  const match = /\{[\s\S]*\}/.exec(result.response);
  if (!match) return;
  let parsed: { category?: string; tags?: string[] };
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return;
  }
  if (!parsed.category || !Array.isArray(parsed.tags)) return;

  // Sanitize: lowercase, enforce tag shape, cap at 5.
  const category = String(parsed.category).toLowerCase().slice(0, 64);
  const tags = parsed.tags
    .filter((t) => typeof t === "string")
    .map((t) => t.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 32))
    .filter(Boolean)
    .slice(0, 5);

  const db = makeDb(env);
  await db
    .update(skills)
    .set({ category, tags, updatedAt: new Date() })
    .where(eq(skills.id, row.id));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
