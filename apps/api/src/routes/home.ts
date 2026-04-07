import { Hono } from "hono";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { makeDb } from "@/db";
import { invocations, ratings, skills } from "@/db/schema";
import { getAgent, requireAgent } from "@/lib/auth";
import type { Env } from "@/types";

export const home = new Hono<Env>();

home.use("/", requireAgent);
home.use("/*", requireAgent);

home.get("/", async (c) => {
  const agent = getAgent(c);
  const db = makeDb(c.env);

  const published = await db
    .select({
      slug: skills.slug,
      displayName: skills.displayName,
      reputationScore: skills.reputationScore,
      installCount: skills.installCount,
      downloadCount: skills.downloadCount,
      updatedAt: skills.updatedAt,
    })
    .from(skills)
    .where(and(eq(skills.authorAgentId, agent.id), isNull(skills.deletedAt)))
    .orderBy(desc(skills.reputationScore))
    .limit(50);

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
        sql`${invocations.startedAt} > NOW() - INTERVAL '24 hours'`,
      ),
    )
    .orderBy(desc(invocations.startedAt))
    .limit(10);

  return c.json({
    agent: {
      agent_id: agent.id,
      name: agent.name,
      reputation_score: Number(agent.reputationScore),
    },
    published_skills: published.map((s) => ({
      slug: s.slug,
      display_name: s.displayName,
      reputation_score: Number(s.reputationScore),
      install_count: Number(s.installCount),
      download_count: Number(s.downloadCount),
      updated_at: s.updatedAt.toISOString(),
    })),
    pending_ratings: pending.map((p) => ({
      invocation_id: p.invocationId,
      skill_id: p.skillId,
      started_at: p.startedAt.toISOString(),
    })),
    notifications: [],
  });
});
