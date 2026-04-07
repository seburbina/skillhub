/**
 * recompute-rankings — runs hourly.
 *
 * For each skill:
 *  1. Aggregate per-skill stats from invocations (median iter, median duration,
 *     up/down ratings, days since last use).
 *  2. Call computeSkillScore() to get the new reputation_score.
 *  3. UPDATE skills.reputation_score.
 *
 * Also updates agents.reputation_score as a rollup (max of their skills).
 */
import { eq, sql } from "drizzle-orm";
import { inngest } from "@/lib/inngest";
import { db } from "@/db";
import { agents, skills } from "@/db/schema";
import {
  DEFAULT_RANKING_WEIGHTS,
  computeSkillScore,
} from "@/lib/ranking";

export const recomputeRankings = inngest.createFunction(
  { id: "recompute-rankings", name: "Recompute skill + agent rankings" },
  { cron: "13 * * * *" }, // hourly at :13 past the hour
  async ({ step }) => {
    // Load all non-deleted skills
    const allSkills = await step.run("load-skills", async () =>
      db
        .select({
          id: skills.id,
          authorAgentId: skills.authorAgentId,
          installCount: skills.installCount,
        })
        .from(skills)
        .where(sql`${skills.deletedAt} IS NULL`),
    );

    if (allSkills.length === 0) return { updated: 0 };

    // Aggregate metrics per skill
    const metricsRows = await step.run("aggregate-metrics", async () => {
      const ids = allSkills.map((s) => s.id);
      return db.execute<{
        skill_id: string;
        median_iter: number | null;
        median_duration: number | null;
        up: number;
        down: number;
        days_since_last: number | null;
      }>(sql`
        SELECT
          skill_id::text,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY follow_up_iterations)
            FILTER (WHERE follow_up_iterations IS NOT NULL) AS median_iter,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)
            FILTER (WHERE duration_ms IS NOT NULL) AS median_duration,
          COUNT(*) FILTER (WHERE rating = 1)  ::int AS up,
          COUNT(*) FILTER (WHERE rating = -1) ::int AS down,
          EXTRACT(EPOCH FROM (NOW() - MAX(started_at))) / 86400 AS days_since_last
        FROM invocations
        WHERE skill_id = ANY(${sql`ARRAY[${sql.join(ids, sql`,`)}]::uuid[]`})
        GROUP BY skill_id
      `);
    });

    const metricsBySkill = new Map(metricsRows.map((r) => [r.skill_id, r]));

    // Compute + update each skill's score
    const updates: Array<{ id: string; score: number; author: string }> = [];
    for (const skill of allSkills) {
      const m = metricsBySkill.get(skill.id);
      const breakdown = computeSkillScore(
        {
          medianFollowUpIterations:
            m?.median_iter !== null && m?.median_iter !== undefined
              ? Number(m.median_iter)
              : 8, // neutral when no data
          upRatings: Number(m?.up ?? 0),
          downRatings: Number(m?.down ?? 0),
          installCount: Number(skill.installCount ?? 0),
          medianDurationMs:
            m?.median_duration !== null && m?.median_duration !== undefined
              ? Number(m.median_duration)
              : 15000,
          daysSinceLastUse:
            m?.days_since_last !== null && m?.days_since_last !== undefined
              ? Number(m.days_since_last)
              : 90,
        },
        DEFAULT_RANKING_WEIGHTS,
      );
      updates.push({
        id: skill.id,
        score: breakdown.reputationScore,
        author: skill.authorAgentId,
      });
    }

    // Batch update skills (could be one UPDATE with CASE for efficiency)
    await step.run("update-skill-scores", async () => {
      for (const u of updates) {
        await db
          .update(skills)
          .set({ reputationScore: u.score.toString() })
          .where(eq(skills.id, u.id));
      }
    });

    // Roll up to agents: reputation = max of their skills' scores
    await step.run("update-agent-scores", async () => {
      await db.execute(sql`
        UPDATE agents a
        SET reputation_score = COALESCE((
          SELECT MAX(s.reputation_score)
          FROM skills s
          WHERE s.author_agent_id = a.id AND s.deleted_at IS NULL
        ), 0)
      `);
    });

    return { updated: updates.length };
  },
);
