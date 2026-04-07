import { Hono } from "hono";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { makeDb } from "@/db";
import { invocations, ratings, skills } from "@/db/schema";
import { getAgent, requireAgent } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import {
  DEFAULT_CONTRIBUTOR_WEIGHTS,
  computeContributorScore,
} from "@/lib/ranking";
import type { Env } from "@/types";

export const me = new Hono<Env>();

me.use("/*", requireAgent);

// ---------------------------------------------------------------------------
// GET /v1/me/dashboard
// ---------------------------------------------------------------------------

me.get("/dashboard", async (c) => {
  const agent = getAgent(c);
  const db = makeDb(c.env);

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
    .where(and(eq(skills.authorAgentId, agent.id), isNull(skills.deletedAt)))
    .orderBy(desc(skills.reputationScore));

  const skillIds = published.map((s) => s.id);
  let perSkillMetrics: Record<string, {
    invocations: number;
    up: number;
    down: number;
    medianIter: number | null;
  }> = {};

  if (skillIds.length > 0) {
    const metricsResult = await db.execute<{
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
      metricsResult.rows.map((r) => [
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

  const totalSkills = published.length;
  const totalInstalls = published.reduce((a, s) => a + Number(s.installCount), 0);
  const totalDownloads = published.reduce((a, s) => a + Number(s.downloadCount), 0);
  const totalInvocations = Object.values(perSkillMetrics).reduce(
    (a, m) => a + m.invocations,
    0,
  );
  const bestSkillScore = published[0] ? Number(published[0].reputationScore) : 0;
  const avgSkillScore =
    totalSkills > 0
      ? published.reduce((a, s) => a + Number(s.reputationScore), 0) / totalSkills
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

  return c.json({
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
        invocations: 0,
        up: 0,
        down: 0,
        medianIter: null,
      },
    })),
    pending_ratings: pending.map((p) => ({
      invocation_id: p.invocationId,
      skill_id: p.skillId,
      started_at: p.startedAt.toISOString(),
    })),
    notifications: [],
  });
});

// ---------------------------------------------------------------------------
// GET /v1/me/skills/:slug/stats?window=7d|30d|90d|all
// ---------------------------------------------------------------------------

me.get("/skills/:slug/stats", async (c) => {
  const agent = getAgent(c);
  const db = makeDb(c.env);
  const slug = c.req.param("slug");
  const window = c.req.query("window") ?? "30d";
  const days =
    window === "7d"
      ? 7
      : window === "90d"
        ? 90
        : window === "all"
          ? 3650
          : 30;

  const rows = await db
    .select()
    .from(skills)
    .where(and(eq(skills.slug, slug), isNull(skills.deletedAt)))
    .limit(1);
  const skill = rows[0];
  if (!skill) return errorResponse(c, "not_found", `No skill '${slug}'.`);
  if (skill.authorAgentId !== agent.id) {
    return errorResponse(c, "forbidden", "You do not own this skill.");
  }

  const seriesResult = await db.execute<{
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

  return c.json({
    skill_id: skill.id,
    slug: skill.slug,
    window,
    reputation_score: Number(skill.reputationScore),
    install_count: Number(skill.installCount),
    download_count: Number(skill.downloadCount),
    series: seriesResult.rows.map((s) => ({
      date: s.day,
      invocations: Number(s.invocations ?? 0),
      up_ratings: Number(s.up ?? 0),
      down_ratings: Number(s.down ?? 0),
      median_iter: s.median_iter !== null ? Number(s.median_iter) : null,
      median_duration_ms:
        s.median_duration_ms !== null ? Number(s.median_duration_ms) : null,
    })),
  });
});
