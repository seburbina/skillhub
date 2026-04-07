import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { skills } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { errorResponse, withErrorHandler } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Time-series metrics for a single skill the agent authored.
 * Returns per-day counts for downloads, installs, invocations, up/down
 * ratings, and the median follow_up_iterations.
 *
 * Window query param: 7d | 30d | 90d | all (default 30d).
 */
export const GET = withErrorHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ slug: string }> },
  ) => {
    const auth = await requireAgent(request);
    if ("response" in auth) return auth.response;
    const { agent } = auth;

    const { slug } = await params;
    const window = request.nextUrl.searchParams.get("window") ?? "30d";
    const days = window === "7d" ? 7 : window === "90d" ? 90 : window === "all" ? 3650 : 30;

    // Ensure the agent owns this skill
    const rows = await db
      .select()
      .from(skills)
      .where(and(eq(skills.slug, slug), isNull(skills.deletedAt)))
      .limit(1);
    const skill = rows[0];
    if (!skill) return errorResponse("not_found", `No skill '${slug}'.`);
    if (skill.authorAgentId !== agent.id) {
      return errorResponse("forbidden", "You do not own this skill.");
    }

    // Aggregate invocations per day
    const series = await db.execute<{
      day: string;
      invocations: number;
      up: number;
      down: number;
      median_iter: number | null;
      median_duration_ms: number | null;
    }>(sql`
      SELECT
        DATE_TRUNC('day', started_at)::date::text AS day,
        COUNT(*)::int AS invocations,
        COUNT(*) FILTER (WHERE rating = 1)::int AS up,
        COUNT(*) FILTER (WHERE rating = -1)::int AS down,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY follow_up_iterations)
          FILTER (WHERE follow_up_iterations IS NOT NULL) AS median_iter,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)
          FILTER (WHERE duration_ms IS NOT NULL) AS median_duration_ms
      FROM invocations
      WHERE skill_id = ${skill.id}
        AND started_at > NOW() - (${days} || ' days')::interval
      GROUP BY day
      ORDER BY day ASC
    `);

    return NextResponse.json({
      skill_id: skill.id,
      slug: skill.slug,
      window,
      reputation_score: Number(skill.reputationScore),
      install_count: Number(skill.installCount),
      download_count: Number(skill.downloadCount),
      series: series.map((s) => ({
        date: s.day,
        invocations: Number(s.invocations ?? 0),
        up_ratings: Number(s.up ?? 0),
        down_ratings: Number(s.down ?? 0),
        median_iter: s.median_iter !== null ? Number(s.median_iter) : null,
        median_duration_ms:
          s.median_duration_ms !== null ? Number(s.median_duration_ms) : null,
      })),
    });
  },
);
