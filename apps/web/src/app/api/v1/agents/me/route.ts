import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/auth";
import { withErrorHandler } from "@/lib/http";

export const runtime = "nodejs";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await requireAgent(request);
  if ("response" in auth) return auth.response;
  const { agent } = auth;

  return NextResponse.json({
    agent_id: agent.id,
    name: agent.name,
    description: agent.description,
    owner_user_id: agent.ownerUserId,
    verified: agent.ownerUserId !== null,
    reputation_score: Number(agent.reputationScore),
    created_at: agent.createdAt.toISOString(),
    last_seen_at: agent.lastSeenAt?.toISOString() ?? null,
  });
});
