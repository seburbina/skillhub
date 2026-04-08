import { Hono } from "hono";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { makeDb } from "@/db";
import {
  moderationFlags,
  skillVersions,
  skills as skillsTable,
} from "@/db/schema";
import { requireAgent, getAgent } from "@/lib/auth";
import { isNewUnverifiedAgent } from "@/lib/challenge";
import { embed, toVectorLiteral } from "@/lib/embeddings";
import { clientIp, errorResponse } from "@/lib/http";
import { signedDownloadUrl } from "@/lib/r2";
import { LIMITS, checkRateLimit } from "@/lib/ratelimit";
import type { Env } from "@/types";

export const skills = new Hono<Env>();

// ---------------------------------------------------------------------------
// GET /v1/skills/search
// ---------------------------------------------------------------------------

const SearchQuery = z.object({
  q: z.string().min(1).max(500),
  category: z.string().max(64).optional(),
  sort: z.enum(["rank", "new", "installs", "trending"]).default("rank"),
  limit: z.coerce.number().int().min(1).max(50).default(5),
});

skills.get("/search", async (c) => {
  const ip = clientIp(c);
  const db = makeDb(c.env);

  const rl = await checkRateLimit(db, `ip:${ip}:search`, LIMITS.search);
  if (!rl.allowed) {
    return errorResponse(c, "rate_limited", "Search rate limit exceeded.", {
      retryAfterSeconds: rl.retryAfterSeconds,
    });
  }

  const parsed = SearchQuery.safeParse({
    q: c.req.query("q"),
    category: c.req.query("category"),
    sort: c.req.query("sort"),
    limit: c.req.query("limit"),
  });
  if (!parsed.success) {
    return errorResponse(c, "invalid_input", "Invalid search query.", {
      details: parsed.error.issues,
    });
  }
  const { q, category, sort, limit } = parsed.data;

  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await embed(q, "query", c.env);
  } catch (e) {
    console.warn("[search] embedding failed, falling back to text:", e);
  }

  const limitClause = Math.max(1, Math.min(50, limit));
  const categoryFilter = category ? sql` AND category = ${category}` : sql``;

  const orderBy = queryEmbedding
    ? sql`embedding <=> ${toVectorLiteral(queryEmbedding)}::vector`
    : sort === "new"
      ? sql`created_at DESC`
      : sort === "installs"
        ? sql`install_count DESC`
        : sql`reputation_score DESC`;

  const result = await db.execute<{
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
      -- Anti-exfiltration filter: only surface skills whose current
      -- version has cleared review. current_version_id is only set by
      -- publish.ts when reviewStatus='approved', so a held-for-review
      -- first publish leaves it NULL.
      AND current_version_id IS NOT NULL
      ${categoryFilter}
      ${queryEmbedding ? sql`` : sql` AND (display_name ILIKE ${`%${q}%`} OR short_desc ILIKE ${`%${q}%`})`}
    ORDER BY ${orderBy}
    LIMIT ${limitClause}
  `);

  return c.json({
    results: result.rows.map((r) => ({
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

// ---------------------------------------------------------------------------
// POST /v1/skills/suggest
// ---------------------------------------------------------------------------

const SuggestBody = z.object({
  intent: z.string().min(1).max(500),
  context_hint: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(10).default(3),
});

skills.post("/suggest", async (c) => {
  const ip = clientIp(c);
  const db = makeDb(c.env);

  const rl = await checkRateLimit(db, `ip:${ip}:search`, LIMITS.search);
  if (!rl.allowed) {
    return errorResponse(c, "rate_limited", "Search rate limit exceeded.", {
      retryAfterSeconds: rl.retryAfterSeconds,
    });
  }

  const parsed = SuggestBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(c, "invalid_input", "Invalid suggest body.", {
      details: parsed.error.issues,
    });
  }
  const { intent, context_hint, limit } = parsed.data;
  const embedInput = context_hint ? `${intent} (${context_hint})` : intent;

  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await embed(embedInput, "query", c.env);
  } catch (e) {
    console.warn("[suggest] embedding failed:", e);
  }

  const orderBy = queryEmbedding
    ? sql`embedding <=> ${toVectorLiteral(queryEmbedding)}::vector`
    : sql`reputation_score DESC`;

  const result = await db.execute<{
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
      AND current_version_id IS NOT NULL
      ${queryEmbedding ? sql`` : sql` AND (display_name ILIKE ${`%${intent}%`} OR short_desc ILIKE ${`%${intent}%`})`}
    ORDER BY ${orderBy}
    LIMIT ${limit}
  `);

  return c.json({
    results: result.rows.map((r) => ({
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

// ---------------------------------------------------------------------------
// GET /v1/skills/:slug
// ---------------------------------------------------------------------------

skills.get("/:slug", async (c) => {
  // Hono matches /:slug too eagerly — exclude `search` and `suggest`
  const slug = c.req.param("slug");
  if (slug === "search" || slug === "suggest") {
    return errorResponse(c, "not_found", `No route for ${slug}.`);
  }

  const db = makeDb(c.env);

  const rows = await db
    .select()
    .from(skillsTable)
    .where(and(eq(skillsTable.slug, slug), isNull(skillsTable.deletedAt)))
    .limit(1);
  const skill = rows[0];
  if (!skill) {
    return errorResponse(c, "not_found", `No skill with slug '${slug}'.`);
  }

  // Only approved versions are visible in the public profile. Pending /
  // rejected versions (held by the anti-exfiltration filter) must not leak
  // through this endpoint — they stay visible only to the author via the
  // authenticated "my skills" surface.
  const versions = await db
    .select({
      id: skillVersions.id,
      semver: skillVersions.semver,
      publishedAt: skillVersions.publishedAt,
      deprecatedAt: skillVersions.deprecatedAt,
      yankedAt: skillVersions.yankedAt,
      sizeBytes: skillVersions.sizeBytes,
      changelogMd: skillVersions.changelogMd,
    })
    .from(skillVersions)
    .where(
      and(
        eq(skillVersions.skillId, skill.id),
        eq(skillVersions.reviewStatus, "approved"),
      ),
    )
    .orderBy(desc(skillVersions.publishedAt));

  // If every version is still pending/rejected the skill is effectively
  // not-yet-published from the public's perspective.
  if (versions.length === 0) {
    return errorResponse(c, "not_found", `No skill with slug '${slug}'.`);
  }

  const latest = versions.find((v) => !v.yankedAt && !v.deprecatedAt);

  return c.json({
    skill_id: skill.id,
    slug: skill.slug,
    display_name: skill.displayName,
    short_desc: skill.shortDesc,
    long_desc_md: skill.longDescMd,
    visibility: skill.visibility,
    category: skill.category,
    tags: skill.tags,
    reputation_score: Number(skill.reputationScore),
    install_count: Number(skill.installCount),
    download_count: Number(skill.downloadCount),
    license_spdx: skill.licenseSpdx,
    created_at: skill.createdAt.toISOString(),
    updated_at: skill.updatedAt.toISOString(),
    latest_version: latest?.semver ?? null,
    current_version: latest?.semver ?? null,
    versions: versions.map((v) => ({
      version_id: v.id,
      semver: v.semver,
      published_at: v.publishedAt.toISOString(),
      deprecated_at: v.deprecatedAt?.toISOString() ?? null,
      yanked_at: v.yankedAt?.toISOString() ?? null,
      size_bytes: v.sizeBytes,
      changelog_md: v.changelogMd,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /v1/skills/:id/report — community reporting (auth required)
// ---------------------------------------------------------------------------

const ReportBody = z.object({
  reason: z.enum(["malware", "pii", "spam", "tos", "other"]),
  comment: z.string().max(1000).optional(),
});

const QUARANTINE_THRESHOLD = 3;
const QUARANTINE_WINDOW_DAYS = 7;

skills.post("/:id/report", requireAgent, async (c) => {
  const reporterAgent = getAgent(c);
  const db = makeDb(c.env);
  const id = c.req.param("id")!;

  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const whereSkill = isUuid ? eq(skillsTable.id, id) : eq(skillsTable.slug, id);

  const skillRows = await db.select().from(skillsTable).where(whereSkill).limit(1);
  const skill = skillRows[0];
  if (!skill) {
    return errorResponse(c, "not_found", `No skill with identifier '${id}'.`);
  }

  // Reporters can't report their own skills (would be trivial spam)
  if (skill.authorAgentId === reporterAgent.id) {
    return errorResponse(c, "forbidden", "You can't report a skill you authored.");
  }

  // Parse + validate body
  const parsed = ReportBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(c, "invalid_input", "Invalid report body.", {
      details: parsed.error.issues,
    });
  }
  const { reason, comment } = parsed.data;

  // Idempotency: one report per (reporter, skill, reason) per 24h
  // (prevents reporters from spamming the same flag)
  // admin_notes is stored as `reporter_agent:<id>` optionally followed by
  // \n\n<comment>, so we use a LIKE prefix match.
  const reporterPrefix = `reporter_agent:${reporterAgent.id}`;
  const recentDup = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n
    FROM moderation_flags
    WHERE target_type = 'skill'
      AND target_id = ${skill.id}
      AND reporter_user_id IS NULL
      AND admin_notes LIKE ${reporterPrefix + "%"}
      AND reason = ${reason}
      AND created_at > NOW() - INTERVAL '24 hours'
  `);
  if (Number(recentDup.rows[0]?.n ?? 0) > 0) {
    return errorResponse(
      c,
      "conflict",
      "You already reported this skill for this reason in the last 24 hours.",
    );
  }

  // Insert the flag — since we don't have a users system yet, we put the
  // reporter agent id in admin_notes prefixed by 'reporter_agent:' so admins
  // can audit. Once Phase 3 wires real user auth we'll add a reporter_agent_id
  // column to moderation_flags.
  await db.insert(moderationFlags).values({
    targetType: "skill",
    targetId: skill.id,
    reason,
    adminNotes:
      `reporter_agent:${reporterAgent.id}` +
      (comment ? `\n\n${comment.slice(0, 800)}` : ""),
  });

  // Auto-quarantine: count distinct reporter agents in the last 7 days.
  // admin_notes starts with `reporter_agent:<uuid>` (optionally followed by
  // \n\n<comment>), so we split on the first newline AND on the prefix to
  // extract the agent id alone before counting distinct.
  const recentReports = await db.execute<{ distinct_reporters: number }>(sql`
    SELECT COUNT(DISTINCT split_part(split_part(admin_notes, E'\\n', 1), ':', 2))::int
      AS distinct_reporters
    FROM moderation_flags
    WHERE target_type = 'skill'
      AND target_id = ${skill.id}
      AND status = 'open'
      AND created_at > NOW() - (${QUARANTINE_WINDOW_DAYS} || ' days')::interval
      AND admin_notes LIKE 'reporter_agent:%'
  `);
  const reporters = Number(recentReports.rows[0]?.distinct_reporters ?? 0);

  let quarantined = false;
  if (reporters >= QUARANTINE_THRESHOLD) {
    // Yank the current version + flip visibility to unlisted
    await db
      .update(skillsTable)
      .set({ visibility: "unlisted", updatedAt: new Date() })
      .where(eq(skillsTable.id, skill.id));
    if (skill.currentVersionId) {
      await db
        .update(skillVersions)
        .set({ yankedAt: new Date() })
        .where(eq(skillVersions.id, skill.currentVersionId));
    }
    quarantined = true;
  }

  return c.json({
    ok: true,
    skill_id: skill.id,
    slug: skill.slug,
    reason,
    distinct_reporters_recent: reporters,
    quarantined,
    quarantine_threshold: QUARANTINE_THRESHOLD,
    quarantine_window_days: QUARANTINE_WINDOW_DAYS,
  });
});

// ---------------------------------------------------------------------------
// GET /v1/skills/:id/versions/:semver/download  (auth required)
// ---------------------------------------------------------------------------

skills.get("/:id/versions/:semver/download", requireAgent, async (c) => {
  const agent = getAgent(c);
  const db = makeDb(c.env);

  const rl = await checkRateLimit(
    db,
    `agent:${agent.id}:download`,
    LIMITS.download,
    isNewUnverifiedAgent(agent),
  );
  if (!rl.allowed) {
    return errorResponse(c, "rate_limited", "Download rate limit exceeded.", {
      retryAfterSeconds: rl.retryAfterSeconds,
    });
  }

  const id = c.req.param("id")!;
  const semver = c.req.param("semver")!;

  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const whereSkill = isUuid ? eq(skillsTable.id, id) : eq(skillsTable.slug, id);

  const skillRows = await db.select().from(skillsTable).where(whereSkill).limit(1);
  const skill = skillRows[0];
  if (!skill) {
    return errorResponse(c, "not_found", `No skill with identifier '${id}'.`);
  }

  const versionRows = await db
    .select()
    .from(skillVersions)
    .where(
      and(eq(skillVersions.skillId, skill.id), eq(skillVersions.semver, semver)),
    )
    .limit(1);
  const version = versionRows[0];
  if (!version) {
    return errorResponse(c, "not_found", `No version ${semver} for ${skill.slug}.`);
  }
  if (version.yankedAt) {
    return errorResponse(c, "forbidden", `Version ${semver} has been yanked.`);
  }
  // Anti-exfiltration review hold — download is blocked for any version
  // not in review_status='approved'. Authors using the authenticated
  // "my skills" surface see their own pending versions with the findings
  // attached; the download endpoint itself stays strict.
  if (version.reviewStatus !== "approved") {
    return errorResponse(
      c,
      "forbidden",
      `Version ${semver} is under review and not yet available for download.`,
    );
  }

  await db
    .update(skillsTable)
    .set({ downloadCount: sql`${skillsTable.downloadCount} + 1` })
    .where(eq(skillsTable.id, skill.id));

  const url = await signedDownloadUrl(c.env, version.r2Key);
  return c.redirect(url, 302);
});
