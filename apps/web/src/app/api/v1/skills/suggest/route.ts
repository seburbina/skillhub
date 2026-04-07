import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { embed, toVectorLiteral } from "@/lib/embeddings";
import { errorResponse, withErrorHandler } from "@/lib/http";
import { checkRateLimit, LIMITS } from "@/lib/ratelimit";

export const runtime = "nodejs";

/**
 * Intent-tuned search for the proactive discovery flow.
 *
 * The base skill sends a distilled intent phrase (verb + primary noun) —
 * never the raw user message. In MVP this is a thin wrapper over the
 * normal search path. Phase 6 swaps in an intent-specific embedding
 * and a learned relevance model.
 */
const BodySchema = z.object({
  intent: z.string().min(1).max(500),
  context_hint: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(10).default(3),
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";
  const rl = await checkRateLimit(`ip:${ip}:search`, LIMITS.search);
  if (!rl.allowed) {
    return errorResponse("rate_limited", "Search rate limit exceeded.", {
      retryAfterSeconds: rl.retryAfterSeconds,
    });
  }

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("invalid_input", "Invalid suggest body.", {
      details: parsed.error.issues,
    });
  }
  const { intent, context_hint, limit } = parsed.data;
  const embedInput = context_hint ? `${intent} (${context_hint})` : intent;

  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await embed(embedInput, "query");
  } catch (e) {
    console.warn("[suggest] embedding failed, falling back to text:", e);
  }

  const orderBy = queryEmbedding
    ? sql`embedding <=> ${toVectorLiteral(queryEmbedding)}::vector`
    : sql`reputation_score DESC`;

  const rows = await db.execute<{
    id: string;
    slug: string;
    display_name: string;
    short_desc: string;
    reputation_score: string;
    install_count: number;
    updated_at: string;
  }>(sql`
    SELECT id, slug, display_name, short_desc, reputation_score,
           install_count, updated_at
    FROM skills
    WHERE deleted_at IS NULL
      AND visibility IN ('public_free', 'public_paid')
      ${queryEmbedding ? sql`` : sql` AND (display_name ILIKE ${`%${intent}%`} OR short_desc ILIKE ${`%${intent}%`})`}
    ORDER BY ${orderBy}
    LIMIT ${limit}
  `);

  return NextResponse.json({
    results: rows.map((r) => ({
      skill_id: r.id,
      slug: r.slug,
      display_name: r.display_name,
      short_desc: r.short_desc,
      reputation_score: Number(r.reputation_score),
      install_count: Number(r.install_count),
      last_updated: r.updated_at,
    })),
  });
});
