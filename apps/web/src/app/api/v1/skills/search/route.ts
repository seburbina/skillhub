import { NextRequest, NextResponse } from "next/server";
import { desc, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { skills } from "@/db/schema";
import { embed, toVectorLiteral } from "@/lib/embeddings";
import { errorResponse, withErrorHandler } from "@/lib/http";
import { checkRateLimit, LIMITS } from "@/lib/ratelimit";

export const runtime = "nodejs";

const QuerySchema = z.object({
  q: z.string().min(1).max(500),
  category: z.string().max(64).optional(),
  sort: z.enum(["rank", "new", "installs", "trending"]).default("rank"),
  limit: z.coerce.number().int().min(1).max(50).default(5),
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  // Rate limit by IP (auth is optional for search)
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

  const sp = request.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    q: sp.get("q") ?? undefined,
    category: sp.get("category") ?? undefined,
    sort: sp.get("sort") ?? undefined,
    limit: sp.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return errorResponse("invalid_input", "Invalid search query.", {
      details: parsed.error.issues,
    });
  }
  const { q, category, sort, limit } = parsed.data;

  // Embed the query
  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await embed(q, "query");
  } catch (e) {
    // If embeddings fail, fall back to trigram-ish substring search via ILIKE.
    // This keeps search working in local dev without a Voyage key.
    console.warn("[search] embedding failed, falling back to text:", e);
  }

  // Build the SELECT
  const limitClause = Math.max(1, Math.min(50, limit));
  const categoryFilter = category
    ? sql` AND category = ${category}`
    : sql``;

  let orderBy;
  if (queryEmbedding) {
    // Cosine distance ANN — smaller is better
    orderBy = sql`embedding <=> ${toVectorLiteral(queryEmbedding)}::vector`;
  } else if (sort === "new") {
    orderBy = sql`created_at DESC`;
  } else if (sort === "installs") {
    orderBy = sql`install_count DESC`;
  } else {
    orderBy = sql`reputation_score DESC`;
  }

  const rows = await db.execute<{
    id: string;
    slug: string;
    display_name: string;
    short_desc: string;
    reputation_score: string;
    install_count: number;
    download_count: number;
    updated_at: string;
    category: string | null;
    tags: string[];
  }>(sql`
    SELECT id, slug, display_name, short_desc, reputation_score,
           install_count, download_count, updated_at, category, tags
    FROM skills
    WHERE deleted_at IS NULL
      AND visibility IN ('public_free', 'public_paid')
      ${categoryFilter}
      ${queryEmbedding ? sql`` : sql` AND (display_name ILIKE ${`%${q}%`} OR short_desc ILIKE ${`%${q}%`})`}
    ORDER BY ${orderBy}
    LIMIT ${limitClause}
  `);

  return NextResponse.json({
    results: rows.map((r) => ({
      skill_id: r.id,
      slug: r.slug,
      display_name: r.display_name,
      short_desc: r.short_desc,
      reputation_score: Number(r.reputation_score),
      install_count: Number(r.install_count),
      download_count: Number(r.download_count),
      last_updated: r.updated_at,
      category: r.category,
      tags: r.tags,
    })),
  });
});
