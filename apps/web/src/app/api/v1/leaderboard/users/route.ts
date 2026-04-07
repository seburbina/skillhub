import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { errorResponse, withErrorHandler } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Top contributors by `contributor_score`.
 *
 * MVP stub: returns an empty array. Phase 2 will read from `user_stats`
 * (materialized view refreshed hourly by the Inngest job) and join to
 * agents/users for the display payload.
 */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const sp = request.nextUrl.searchParams;
  const window = sp.get("window") ?? "all";
  const limit = Math.min(Math.max(Number(sp.get("limit") ?? 100), 1), 200);

  if (!["week", "month", "all"].includes(window)) {
    return errorResponse("invalid_input", "window must be week|month|all");
  }

  // Phase 2: join user_stats → users for the payload.
  // MVP placeholder: top N agents by reputation_score (proxy while we wait
  // for real contributor_score rollup from the refresh-user-stats job).
  const rows = await db.execute<{
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

  return NextResponse.json({
    window,
    kind: "users",
    generated_at: new Date().toISOString(),
    note: "MVP placeholder — real contributor_score ranking ships in Phase 2.",
    entries: rows.map((r) => ({
      rank: Number(r.rank),
      subject_id: r.subject_id,
      display_name: r.display_name,
      score: Number(r.score),
    })),
  });
});
