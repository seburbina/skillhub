import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { invocations, skills } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { errorResponse, withErrorHandler } from "@/lib/http";
import { checkRateLimit, LIMITS } from "@/lib/ratelimit";

export const runtime = "nodejs";

const StartBody = z.object({
  skill_id: z.string().uuid(),
  version_id: z.string().uuid(),
  session_hash: z.string().min(1).max(128).optional(),
  client_meta: z.record(z.string(), z.unknown()).optional(),
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await requireAgent(request);
  if ("response" in auth) return auth.response;
  const { agent } = auth;

  const rl = await checkRateLimit(
    `agent:${agent.id}:telemetry`,
    LIMITS.telemetry,
  );
  if (!rl.allowed) {
    return errorResponse("rate_limited", "Telemetry rate limit exceeded.", {
      retryAfterSeconds: rl.retryAfterSeconds,
    });
  }

  const parsed = StartBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("invalid_input", "Invalid invocation start body.", {
      details: parsed.error.issues,
    });
  }
  const body = parsed.data;

  const [invocation] = await db
    .insert(invocations)
    .values({
      skillId: body.skill_id,
      versionId: body.version_id,
      invokingAgentId: agent.id,
      sessionHash: body.session_hash ?? null,
      clientMeta: body.client_meta ?? null,
    })
    .returning();

  if (!invocation) {
    return errorResponse("server_error", "Failed to create invocation.");
  }

  // Increment install_count on first invocation of a skill per session.
  // MVP: unconditional increment (simpler; we can dedupe later).
  await db
    .update(skills)
    .set({ installCount: sql`${skills.installCount} + 1` })
    .where(eq(skills.id, body.skill_id));

  return NextResponse.json({ invocation_id: invocation.id });
});
