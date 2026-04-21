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
import { isNotNull, sql } from "drizzle-orm";
import { makeDb } from "@/db";
import { skills } from "@/db/schema";
import { embedSkill } from "@/jobs/embed-skill";
import { errorResponse } from "@/lib/http";
import type { Env } from "@/types";

export const adminApi = new Hono<Env>();

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

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
