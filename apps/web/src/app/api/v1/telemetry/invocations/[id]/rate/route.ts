import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { invocations, ratings, skills } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { errorResponse, withErrorHandler } from "@/lib/http";

export const runtime = "nodejs";

const RateBody = z.object({
  value: z.union([z.literal(-1), z.literal(1)]),
  comment: z.string().max(500).optional(),
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

    const parsed = RateBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return errorResponse("invalid_input", "Invalid rating body.", {
        details: parsed.error.issues,
      });
    }
    const { value, comment } = parsed.data;

    // Look up the invocation to ensure (a) it exists, (b) the rater is not
    // the author of the skill.
    const invocationRows = await db
      .select({
        id: invocations.id,
        skillId: invocations.skillId,
        invokingAgentId: invocations.invokingAgentId,
        authorAgentId: skills.authorAgentId,
      })
      .from(invocations)
      .innerJoin(skills, eq(skills.id, invocations.skillId))
      .where(eq(invocations.id, id))
      .limit(1);

    const row = invocationRows[0];
    if (!row) {
      return errorResponse("not_found", "Invocation not found.");
    }
    if (row.authorAgentId === agent.id) {
      return errorResponse(
        "forbidden",
        "Cannot rate a skill you authored.",
      );
    }
    if (row.invokingAgentId !== agent.id) {
      return errorResponse(
        "forbidden",
        "Cannot rate an invocation you did not make.",
      );
    }

    // Upsert the rating (unique on invocation_id)
    await db
      .insert(ratings)
      .values({
        invocationId: id,
        raterAgentId: agent.id,
        value,
        comment: comment ?? null,
      })
      .onConflictDoUpdate({
        target: ratings.invocationId,
        set: { value, comment: comment ?? null },
      });

    // Also store rating on the invocation row for easy filtering
    await db
      .update(invocations)
      .set({ rating: value })
      .where(eq(invocations.id, id));

    return NextResponse.json({ ok: true });
  },
);
