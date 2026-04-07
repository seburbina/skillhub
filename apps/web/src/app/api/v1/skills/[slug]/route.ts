import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { skillVersions, skills } from "@/db/schema";
import { errorResponse, withErrorHandler } from "@/lib/http";

export const runtime = "nodejs";

export const GET = withErrorHandler(
  async (_request: NextRequest, { params }: { params: Promise<{ slug: string }> }) => {
    const { slug } = await params;

    const rows = await db
      .select()
      .from(skills)
      .where(and(eq(skills.slug, slug), isNull(skills.deletedAt)))
      .limit(1);

    const skill = rows[0];
    if (!skill) {
      return errorResponse("not_found", `No skill with slug '${slug}'.`);
    }

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
      .where(eq(skillVersions.skillId, skill.id))
      .orderBy(desc(skillVersions.publishedAt));

    const latest = versions.find((v) => !v.yankedAt && !v.deprecatedAt);

    return NextResponse.json({
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
  },
);
