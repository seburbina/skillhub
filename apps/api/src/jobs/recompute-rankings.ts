/**
 * Recompute every skill's reputation_score from invocation telemetry.
 * Triggered by the Worker's scheduled handler on a cron.
 */
import { eq, sql } from "drizzle-orm";
import { makeDb } from "@/db";
import { skills } from "@/db/schema";
import { computeSkillScore, DEFAULT_RANKING_WEIGHTS } from "@/lib/ranking";
import type { Bindings } from "@/types";

export async function recomputeRankings(env: Bindings): Promise<{ updated: number }> {
  const db = makeDb(env);

  const allSkills = await db
    .select({
      id: skills.id,
      authorAgentId: skills.authorAgentId,
      installCount: skills.installCount,
    })
    .from(skills)
    .where(sql`${skills.deletedAt} IS NULL`);

  if (allSkills.length === 0) return { updated: 0 };

  const ids = allSkills.map((s) => s.id);
  const metricsResult = await db.execute<{
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
  const metricsBySkill = new Map(metricsResult.rows.map((r) => [r.skill_id, r]));

  const updates: Array<{ id: string; score: number }> = [];
  for (const skill of allSkills) {
    const m = metricsBySkill.get(skill.id);
    const breakdown = computeSkillScore(
      {
        medianFollowUpIterations:
          m?.median_iter !== null && m?.median_iter !== undefined
            ? Number(m.median_iter)
            : 8,
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
    updates.push({ id: skill.id, score: breakdown.reputationScore });
  }

  for (const u of updates) {
    await db
      .update(skills)
      .set({ reputationScore: u.score.toString() })
      .where(eq(skills.id, u.id));
  }

  // Roll up to agents
  await db.execute(sql`
    UPDATE agents a
    SET reputation_score = COALESCE((
      SELECT MAX(s.reputation_score)
      FROM skills s
      WHERE s.author_agent_id = a.id AND s.deleted_at IS NULL
    ), 0)
  `);

  return { updated: updates.length };
}
