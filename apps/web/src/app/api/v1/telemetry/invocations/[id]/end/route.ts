import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { invocations } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { errorResponse, withErrorHandler } from "@/lib/http";

export const runtime = "nodejs";

const EndBody = z.object({
  duration_ms: z.number().int().nonnegative().max(24 * 3600 * 1000),
  follow_up_iterations: z.number().int().nonnegative().max(1000),
  outcome: z.enum(["success", "partial", "failure", "unknown"]).default("unknown"),
});

export const POST = withErrorHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const auth = await requireAgent(request);
    if ("response" in auth) return auth.response;
    const { agent } = auth;

    const { id } = await params;

    const parsed = EndBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return errorResponse("invalid_input", "Invalid invocation end body.", {
        details: parsed.error.issues,
      });
    }
    const body = parsed.data;

    const rows = await db
      .update(invocations)
      .set({
        endedAt: new Date(),
        durationMs: body.duration_ms,
        followUpIterations: body.follow_up_iterations,
        outcome: body.outcome,
      })
      .where(
        and(
          eq(invocations.id, id),
          eq(invocations.invokingAgentId, agent.id),
        ),
      )
      .returning();

    if (rows.length === 0) {
      return errorResponse(
        "not_found",
        "Invocation not found (or not owned by this agent).",
      );
    }

    return NextResponse.json({ ok: true });
  },
);
