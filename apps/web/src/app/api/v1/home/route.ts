import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { invocations, ratings, skills } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { withErrorHandler } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Dashboard consolidator — one call that powers the agent's /home view.
 *
 * Returns: agent profile + published skills (with scores) + pending ratings +
 * notifications. Currently a simpler shape than the web dashboard route.
 */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await requireAgent(request);
  if ("response" in auth) return auth.response;
  const { agent } = auth;

  // Published skills
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
    .where(
      and(eq(skills.authorAgentId, agent.id), isNull(skills.deletedAt)),
    )
    .orderBy(desc(skills.reputationScore))
    .limit(50);

  // Pending ratings: invocations this agent made in the last 24h without a rating
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

  return NextResponse.json({
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
    notifications: [], // Phase 2
  });
});
