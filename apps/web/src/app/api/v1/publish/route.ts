import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  scrubReports,
  skillVersions,
  skills,
} from "@/db/schema";
import { requireAgent } from "@/lib/auth";
import { errorResponse, withErrorHandler } from "@/lib/http";
import { inngest } from "@/lib/inngest";
import { checkRateLimit, LIMITS } from "@/lib/ratelimit";
import { putObject, skillVersionKey } from "@/lib/r2";
import { scanSkill } from "@/lib/scrub/regex";
import { readZip, textFilesFromZip } from "@/lib/unzip";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const ManifestSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, {
      message: "slug must be kebab-case lowercase alphanumeric",
    }),
  display_name: z.string().min(1).max(120),
  short_desc: z.string().min(10).max(300),
  long_desc_md: z.string().max(20000).optional(),
  semver: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  category: z.string().max(64).optional(),
  tags: z.array(z.string().max(32)).max(16).default([]),
  license_spdx: z.string().max(64).default("MIT"),
  changelog_md: z.string().max(20000).optional(),
  content_hash: z.string().min(1).optional(),
});

const ScrubReportSchema = z.object({
  overall_severity: z.enum(["clean", "warn", "block"]),
  findings: z.array(z.record(z.string(), z.unknown())).default([]),
});

// skill-creator's quality-gate report is opaque JSON; we just require `status`
const SkillCreatorReportSchema = z.object({
  status: z.enum(["clean", "warn", "block"]),
});

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const POST = withErrorHandler(async (request: NextRequest) => {
  // Auth
  const auth = await requireAgent(request);
  if ("response" in auth) return auth.response;
  const { agent } = auth;

  // Rate limit
  const rl = await checkRateLimit(`agent:${agent.id}:publish`, LIMITS.publish);
  if (!rl.allowed) {
    return errorResponse("rate_limited", "Publish rate limit exceeded.", {
      retryAfterSeconds: rl.retryAfterSeconds,
    });
  }

  // Parse multipart
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse("invalid_input", "Body must be multipart/form-data.");
  }

  const skillBlob = form.get("skill");
  const manifestStr = form.get("manifest");
  const scrubReportStr = form.get("scrub_report");
  const skillCreatorReportStr = form.get("skill_creator_report");

  if (!(skillBlob instanceof Blob)) {
    return errorResponse("invalid_input", "Missing 'skill' file part.");
  }
  if (skillBlob.size > MAX_UPLOAD_BYTES) {
    return errorResponse(
      "invalid_input",
      `Skill archive is too large (${skillBlob.size} > ${MAX_UPLOAD_BYTES} bytes).`,
    );
  }
  if (typeof manifestStr !== "string") {
    return errorResponse("invalid_input", "Missing 'manifest' field.");
  }
  if (typeof scrubReportStr !== "string") {
    return errorResponse("invalid_input", "Missing 'scrub_report' field.");
  }
  if (typeof skillCreatorReportStr !== "string") {
    return errorResponse("invalid_input", "Missing 'skill_creator_report' field.");
  }

  // Validate manifest
  const manifestParsed = ManifestSchema.safeParse(safeJson(manifestStr));
  if (!manifestParsed.success) {
    return errorResponse("invalid_input", "Invalid manifest JSON.", {
      details: manifestParsed.error.issues,
    });
  }
  const manifest = manifestParsed.data;

  // Validate client scrub report shape (we don't trust its verdict — we'll
  // re-scan the content ourselves — but it must be well-formed)
  const clientScrubParsed = ScrubReportSchema.safeParse(safeJson(scrubReportStr));
  if (!clientScrubParsed.success) {
    return errorResponse("invalid_input", "Invalid scrub_report JSON.", {
      details: clientScrubParsed.error.issues,
    });
  }
  const clientScrub = clientScrubParsed.data;

  if (clientScrub.overall_severity === "block") {
    return errorResponse(
      "block_finding",
      "Client scrub report marked the skill as 'block'. Fix and re-upload.",
      { findings: clientScrub.findings },
    );
  }

  // Validate skill-creator report
  const scParsed = SkillCreatorReportSchema.safeParse(safeJson(skillCreatorReportStr));
  if (!scParsed.success) {
    return errorResponse("invalid_input", "Invalid skill_creator_report JSON.", {
      details: scParsed.error.issues,
    });
  }
  if (scParsed.data.status === "block") {
    return errorResponse(
      "block_finding",
      "skill-creator quality gate marked the skill as 'block'.",
    );
  }

  // Read the .skill buffer
  const arrayBuffer = await skillBlob.arrayBuffer();
  const zipBytes = new Uint8Array(arrayBuffer);
  const contentHash = createHash("sha256").update(zipBytes).digest("hex");

  // Parse the zip and run the server-side regex re-scan (defense in depth)
  let textFiles;
  try {
    const entries = readZip(zipBytes);
    textFiles = textFilesFromZip(entries);
  } catch (e) {
    return errorResponse(
      "invalid_input",
      `Skill archive is not a valid ZIP: ${(e as Error).message}`,
    );
  }

  const serverScan = scanSkill(textFiles);
  if (serverScan.overallSeverity === "block") {
    return errorResponse(
      "block_finding",
      "Server-side regex re-scan found content the client missed. Re-sanitize and re-review before retrying.",
      { findings: serverScan.findings, hint: "See base-skill/references/scrubbing.md" },
    );
  }

  // Upload to R2
  const r2Key = skillVersionKey(manifest.slug, manifest.semver);
  try {
    await putObject(r2Key, zipBytes, "application/zip");
  } catch (e) {
    return errorResponse("server_error", `R2 upload failed: ${(e as Error).message}`);
  }

  // Insert or look up the skill row (idempotent by slug)
  const existing = await db
    .select()
    .from(skills)
    .where(eq(skills.slug, manifest.slug))
    .limit(1);

  let skillId: string;
  if (existing.length > 0) {
    const skill = existing[0]!;
    if (skill.authorAgentId !== agent.id) {
      return errorResponse(
        "forbidden",
        "This slug is owned by a different agent.",
      );
    }
    skillId = skill.id;
  } else {
    const [created] = await db
      .insert(skills)
      .values({
        slug: manifest.slug,
        authorAgentId: agent.id,
        displayName: manifest.display_name,
        shortDesc: manifest.short_desc,
        longDescMd: manifest.long_desc_md ?? null,
        category: manifest.category ?? null,
        tags: manifest.tags,
        licenseSpdx: manifest.license_spdx,
      })
      .returning();
    if (!created) {
      return errorResponse("server_error", "Failed to create skill row.");
    }
    skillId = created.id;
  }

  // Scrub report row
  const [scrubRow] = await db
    .insert(scrubReports)
    .values({
      regexFindings: clientScrub.findings,
      serverRescanFindings: serverScan.findings,
      status: serverScan.overallSeverity === "warn" ? "warn" : "clean",
      reviewedByUser: true,
    })
    .returning();

  // Create the version row (unique on (skill_id, semver))
  const existingVersion = await db
    .select()
    .from(skillVersions)
    .where(
      and(
        eq(skillVersions.skillId, skillId),
        eq(skillVersions.semver, manifest.semver),
      ),
    )
    .limit(1);

  if (existingVersion.length > 0) {
    return errorResponse(
      "conflict",
      `Version ${manifest.semver} already exists for ${manifest.slug}.`,
      { hint: "Bump the semver and retry." },
    );
  }

  const [newVersion] = await db
    .insert(skillVersions)
    .values({
      skillId,
      semver: manifest.semver,
      contentHash,
      sizeBytes: zipBytes.length,
      r2Key,
      changelogMd: manifest.changelog_md ?? null,
      scrubReportId: scrubRow?.id ?? null,
    })
    .returning();

  if (!newVersion) {
    return errorResponse("server_error", "Failed to create version row.");
  }

  // Point the skill at this as current version
  await db
    .update(skills)
    .set({
      currentVersionId: newVersion.id,
      displayName: manifest.display_name,
      shortDesc: manifest.short_desc,
      longDescMd: manifest.long_desc_md ?? null,
      category: manifest.category ?? null,
      tags: manifest.tags,
      updatedAt: new Date(),
    })
    .where(eq(skills.id, skillId));

  // Trigger the embed-skill job so `skills.embedding` is populated
  // asynchronously. Failure here is non-fatal — the publish still
  // succeeds; search will just temporarily fall back to text matching
  // until the next embed attempt.
  try {
    await inngest.send({
      name: "skillhub/skill.published",
      data: { skill_id: skillId },
    });
  } catch (e) {
    console.warn("[publish] failed to send inngest event:", e);
  }

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? "https://AgentSkillDepot.com";

  return NextResponse.json({
    skill_id: skillId,
    slug: manifest.slug,
    version_id: newVersion.id,
    semver: manifest.semver,
    public_url: `${appUrl}/s/${manifest.slug}`,
    r2_key: r2Key,
    published_at: newVersion.publishedAt.toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
