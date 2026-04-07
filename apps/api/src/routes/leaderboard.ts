import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { makeDb } from "@/db";
import { errorResponse } from "@/lib/http";
import type { Env } from "@/types";

export const leaderboard = new Hono<Env>();

// ---------------------------------------------------------------------------
// GET /v1/leaderboard/users
// ---------------------------------------------------------------------------

leaderboard.get("/users", async (c) => {
  const db = makeDb(c.env);
  const window = c.req.query("window") ?? "all";
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 200);

  if (!["week", "month", "all"].includes(window)) {
    return errorResponse(c, "invalid_input", "window must be week|month|all");
  }

  // MVP: top agents by reputation_score (proxy for contributor_score until
  // the refresh-user-stats job populates user_stats).
  const result = await db.execute<{
    subject_id: string;
    display_name: string;
    score: string;
    rank: number;
  }>(sql`
    SELECT
      a.id::text AS subject_id,
      a.name AS display_name,
      a.reputation_score::text AS score,
      ROW_NUMBER() OVER (ORDER BY a.reputation_score DESC)::int AS rank
    FROM agents a
    WHERE a.revoked_at IS NULL
    ORDER BY a.reputation_score DESC
    LIMIT ${limit}
  `);

  return c.json({
    window,
    kind: "users",
    generated_at: new Date().toISOString(),
    note: "MVP placeholder — real contributor_score ranking ships in Phase 2.",
    entries: result.rows.map((r) => ({
      rank: Number(r.rank),
      subject_id: r.subject_id,
      display_name: r.display_name,
      score: Number(r.score),
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /v1/leaderboard/skills
// ---------------------------------------------------------------------------

leaderboard.get("/skills", async (c) => {
  const db = makeDb(c.env);
  const window = c.req.query("window") ?? "all";
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 200);

  if (!["week", "month", "all"].includes(window)) {
    return errorResponse(c, "invalid_input", "window must be week|month|all");
  }

  const result = await db.execute<{
    subject_id: string;
    slug: string;
    display_name: string;
    short_desc: string;
    score: string;
    install_count: number;
    rank: number;
  }>(sql`
    SELECT
      s.id::text AS subject_id,
      s.slug,
      s.display_name,
      s.short_desc,
      s.reputation_score::text AS score,
      s.install_count::int,
      ROW_NUMBER() OVER (ORDER BY s.reputation_score DESC)::int AS rank
    FROM skills s
    WHERE s.deleted_at IS NULL
      AND s.visibility IN ('public_free', 'public_paid')
    ORDER BY s.reputation_score DESC
    LIMIT ${limit}
  `);

  return c.json({
    window,
    kind: "skills",
    generated_at: new Date().toISOString(),
    entries: result.rows.map((r) => ({
      rank: Number(r.rank),
      subject_id: r.subject_id,
      slug: r.slug,
      display_name: r.display_name,
      short_desc: r.short_desc,
      install_count: Number(r.install_count),
      score: Number(r.score),
    })),
  });
});
