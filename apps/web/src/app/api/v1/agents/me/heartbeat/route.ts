import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, skills, skillVersions } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { errorResponse, withErrorHandler } from "@/lib/http";
import { checkRateLimit, LIMITS } from "@/lib/ratelimit";

export const runtime = "nodejs";

const HeartbeatBody = z.object({
  installed_skills: z
    .array(
      z.object({
        slug: z.string().min(1),
        version: z.string().min(1),
      }),
    )
    .max(500)
    .default([]),
  client_meta: z.record(z.string(), z.unknown()).optional(),
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await requireAgent(request);
  if ("response" in auth) return auth.response;
  const { agent } = auth;

  // Per-agent rate limit: 1 per 25 min minimum
  const rl = await checkRateLimit(`agent:${agent.id}:heartbeat`, LIMITS.heartbeat);
  if (!rl.allowed) {
    return errorResponse(
      "rate_limited",
      "Heartbeat called too recently.",
      { retryAfterSeconds: rl.retryAfterSeconds },
    );
  }

  const raw = await request.json().catch(() => ({}));
  const parsed = HeartbeatBody.safeParse(raw);
  if (!parsed.success) {
    return errorResponse("invalid_input", "Invalid heartbeat body.", {
      details: parsed.error.issues,
    });
  }
  const body = parsed.data;

  // Update last_seen_at
  await db
    .update(agents)
    .set({ lastSeenAt: new Date() })
    .where(eq(agents.id, agent.id));

  // Build updates_available by looking up the latest non-yanked version of
  // each installed skill by slug and comparing to the reported semver.
  const updates_available: Array<{
    slug: string;
    installed_version: string;
    latest_version: string;
    auto_update_eligible: boolean;
    changelog_url: string;
    download_url: null;
  }> = [];

  if (body.installed_skills.length > 0) {
    const slugs = body.installed_skills.map((s) => s.slug);
    const installedBySlug = new Map(
      body.installed_skills.map((s) => [s.slug, s.version]),
    );

    // Get skill rows for the reported slugs
    const rows = await db
      .select({
        id: skills.id,
        slug: skills.slug,
        currentVersionId: skills.currentVersionId,
      })
      .from(skills)
      .where(and(inArray(skills.slug, slugs), isNull(skills.deletedAt)));

    // Fetch current versions
    const versionIds = rows
      .map((r) => r.currentVersionId)
      .filter((v): v is string => v !== null);

    const versionRows = versionIds.length
      ? await db
          .select({
            id: skillVersions.id,
            skillId: skillVersions.skillId,
            semver: skillVersions.semver,
          })
          .from(skillVersions)
          .where(inArray(skillVersions.id, versionIds))
      : [];
    const versionById = new Map(versionRows.map((v) => [v.id, v]));

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://AgentSkillDepot.com";
    for (const row of rows) {
      if (!row.currentVersionId) continue;
      const latest = versionById.get(row.currentVersionId);
      if (!latest) continue;
      const installedSemver = installedBySlug.get(row.slug);
      if (!installedSemver || installedSemver === latest.semver) continue;
      updates_available.push({
        slug: row.slug,
        installed_version: installedSemver,
        latest_version: latest.semver,
        auto_update_eligible: false, // MVP: never auto-update without explicit consent
        changelog_url: `${appUrl}/s/${row.slug}/changelog`,
        download_url: null,
      });
    }
  }

  return NextResponse.json({
    now: new Date().toISOString(),
    next_heartbeat_in_seconds: 1800,
    updates_available,
    notifications: [], // MVP: populated in Phase 2
    challenge: null,
  });
});
