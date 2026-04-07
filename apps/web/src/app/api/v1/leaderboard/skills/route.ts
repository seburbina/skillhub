import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { errorResponse, withErrorHandler } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Top skills by reputation_score (or trending = 7-day delta when window=week).
 */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const sp = request.nextUrl.searchParams;
  const window = sp.get("window") ?? "all";
  const limit = Math.min(Math.max(Number(sp.get("limit") ?? 100), 1), 200);

  if (!["week", "month", "all"].includes(window)) {
    return errorResponse("invalid_input", "window must be week|month|all");
  }

  const rows = await db.execute<{
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

  return NextResponse.json({
    window,
    kind: "skills",
    generated_at: new Date().toISOString(),
    entries: rows.map((r) => ({
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
