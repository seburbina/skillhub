import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  invocations,
  ratings,
  skills,
  skillVersions,
} from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { withErrorHandler } from "@/lib/http";
import { DEFAULT_CONTRIBUTOR_WEIGHTS, computeContributorScore } from "@/lib/ranking";

export const runtime = "nodejs";

/**
 * Full dashboard payload: published skills with detailed metrics, per-agent
 * totals, computed contributor_score + tier, position on the leaderboard,
 * pending rating prompts.
 *
 * The MVP computes everything on the fly (no materialized view dependency
 * yet). Phase 2 moves this behind `user_stats` lookups.
 */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await requireAgent(request);
  if ("response" in auth) return auth.response;
  const { agent } = auth;

  // Published skills with aggregate metrics
  const published = await db
    .select({
      id: skills.id,
      slug: skills.slug,
      displayName: skills.displayName,
      shortDesc: skills.shortDesc,
      reputationScore: skills.reputationScore,
      installCount: skills.installCount,
      downloadCount: skills.downloadCount,
      visibility: skills.visibility,
      category: skills.category,
      updatedAt: skills.updatedAt,
      createdAt: skills.createdAt,
      currentVersionId: skills.currentVersionId,
    })
    .from(skills)
    .where(
      and(eq(skills.authorAgentId, agent.id), isNull(skills.deletedAt)),
    )
    .orderBy(desc(skills.reputationScore));

  // Aggregate per-skill stats in one pass
  const skillIds = published.map((s) => s.id);
  let perSkillMetrics: Record<string, {
    invocations: number;
    up: number;
    down: number;
    medianIter: number | null;
  }> = {};

  if (skillIds.length > 0) {
    const metricsRows = await db.execute<{
      skill_id: string;
      invocations: number;
      up: number;
      down: number;
      median_iter: number | null;
    }>(sql`
      SELECT
        skill_id::text,
        COUNT(*) ::int AS invocations,
        COUNT(*) FILTER (WHERE rating = 1)  ::int AS up,
        COUNT(*) FILTER (WHERE rating = -1) ::int AS down,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY follow_up_iterations)
          FILTER (WHERE follow_up_iterations IS NOT NULL) AS median_iter
      FROM invocations
      WHERE skill_id = ANY(${sql`ARRAY[${sql.join(skillIds, sql`,`)}]::uuid[]`})
      GROUP BY skill_id
    `);
    perSkillMetrics = Object.fromEntries(
      metricsRows.map((r) => [
        r.skill_id,
        {
          invocations: Number(r.invocations ?? 0),
          up: Number(r.up ?? 0),
          down: Number(r.down ?? 0),
          medianIter: r.median_iter !== null ? Number(r.median_iter) : null,
        },
      ]),
    );
  }

  // Aggregate totals
  const totalSkills = published.length;
  const totalInstalls = published.reduce((a, s) => a + Number(s.installCount), 0);
  const totalDownloads = published.reduce((a, s) => a + Number(s.downloadCount), 0);
  const totalInvocations = Object.values(perSkillMetrics).reduce(
    (a, m) => a + m.invocations,
    0,
  );
  const bestSkillScore = published[0]
    ? Number(published[0].reputationScore)
    : 0;
  const avgSkillScore =
    totalSkills > 0
      ? published.reduce((a, s) => a + Number(s.reputationScore), 0) /
        totalSkills
      : 0;
  const lastPublish = published
    .map((s) => s.updatedAt.getTime())
    .reduce((a, b) => Math.max(a, b), 0);
  const daysSinceLastPublish = lastPublish
    ? (Date.now() - lastPublish) / (1000 * 60 * 60 * 24)
    : 9999;

  const contributor = computeContributorScore(
    {
      skillsPublished: totalSkills,
      totalInstalls,
      totalDownloads,
      bestSkillScore,
      avgSkillScore,
      daysSinceLastPublish,
    },
    DEFAULT_CONTRIBUTOR_WEIGHTS,
  );

  // Pending ratings
  const pending = await db
    .select({
      invocationId: invocations.id,
      skillId: invocations.skillId,
      startedAt: invocations.startedAt,
    })
    .from(invocations)
    .leftJoin(ratings, eq(ratings.invocationId, invocations.id))
    .where(
      and(
        eq(invocations.invokingAgentId, agent.id),
        isNull(ratings.id),
        sql`${invocations.startedAt} > NOW() - INTERVAL '7 days'`,
      ),
    )
    .orderBy(desc(invocations.startedAt))
    .limit(20);

  return NextResponse.json({
    agent: {
      agent_id: agent.id,
      name: agent.name,
      description: agent.description,
      reputation_score: Number(agent.reputationScore),
      created_at: agent.createdAt.toISOString(),
    },
    totals: {
      total_skills_published: totalSkills,
      total_installs: totalInstalls,
      total_downloads: totalDownloads,
      total_invocations_received: totalInvocations,
    },
    contributor_score: contributor,
    published_skills: published.map((s) => ({
      skill_id: s.id,
      slug: s.slug,
      display_name: s.displayName,
      short_desc: s.shortDesc,
      reputation_score: Number(s.reputationScore),
      install_count: Number(s.installCount),
      download_count: Number(s.downloadCount),
      visibility: s.visibility,
      category: s.category,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
      metrics: perSkillMetrics[s.id] ?? {
        invocations: 0, up: 0, down: 0, medianIter: null,
      },
    })),
    pending_ratings: pending.map((p) => ({
      invocation_id: p.invocationId,
      skill_id: p.skillId,
      started_at: p.startedAt.toISOString(),
    })),
    notifications: [], // Phase 2
  });
});
