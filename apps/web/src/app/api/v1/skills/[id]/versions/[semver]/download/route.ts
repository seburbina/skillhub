import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { skillVersions, skills } from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { errorResponse, withErrorHandler } from "@/lib/http";
import { checkRateLimit, LIMITS } from "@/lib/ratelimit";
import { signedDownloadUrl } from "@/lib/r2";

export const runtime = "nodejs";

/**
 * Resolve a skill version by (id-or-slug, semver), enforce rate limits,
 * increment download_count, and return a 302 to the R2 signed URL.
 *
 * `[id]` accepts EITHER a UUID OR a slug for convenience. The base skill's
 * `jit_load.py` uses the slug path (`/v1/skills/by-slug/<slug>/versions/...`)
 * via a separate alias; this endpoint serves both via shape detection.
 */
export const GET = withErrorHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string; semver: string }> },
  ) => {
    const auth = await requireAgent(request);
    if ("response" in auth) return auth.response;
    const { agent } = auth;

    const rl = await checkRateLimit(
      `agent:${agent.id}:download`,
      LIMITS.download,
    );
    if (!rl.allowed) {
      return errorResponse("rate_limited", "Download rate limit exceeded.", {
        retryAfterSeconds: rl.retryAfterSeconds,
      });
    }

    const { id, semver } = await params;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      id,
    );
    const whereSkill = isUuid ? eq(skills.id, id) : eq(skills.slug, id);

    const skillRows = await db
      .select()
      .from(skills)
      .where(whereSkill)
      .limit(1);
    const skill = skillRows[0];
    if (!skill) {
      return errorResponse("not_found", `No skill with identifier '${id}'.`);
    }

    const versionRows = await db
      .select()
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.skillId, skill.id),
          eq(skillVersions.semver, semver),
        ),
      )
      .limit(1);
    const version = versionRows[0];
    if (!version) {
      return errorResponse("not_found", `No version ${semver} for ${skill.slug}.`);
    }
    if (version.yankedAt) {
      return errorResponse(
        "forbidden",
        `Version ${semver} has been yanked.`,
        { hint: "Pick a different version." },
      );
    }

    // MVP: all public skills are free. When monetization ships, this is
    // where the entitlement check goes.

    // Fire-and-forget download count increment
    await db
      .update(skills)
      .set({ downloadCount: sql`${skills.downloadCount} + 1` })
      .where(eq(skills.id, skill.id));

    const url = await signedDownloadUrl(version.r2Key);
    return NextResponse.redirect(url, 302);
  },
);
