import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { makeDb } from "@/db";
import { scrubReports, skillVersions, skills } from "@/db/schema";
import { embedSkill } from "@/jobs/embed-skill";
import { writeAudit } from "@/lib/audit";
import { getAgent, requireAgent } from "@/lib/auth";
import { isNewUnverifiedAgent, verifyChallenge } from "@/lib/challenge";
import { clientIp, errorResponse } from "@/lib/http";
import { putSkill, skillVersionKey } from "@/lib/r2";
import { LIMITS, checkRateLimit, rateLimitKey } from "@/lib/ratelimit";
import { scanSkill } from "@/lib/scrub/regex";
import { detectExfiltration, worstOf } from "@/lib/scrub/exfiltration";
import { classifyWithLLM } from "@/lib/scrub/exfiltration-llm";
import { textFilesFromZip } from "@/lib/unzip";
import type { Env } from "@/types";

export const publish = new Hono<Env>();

publish.use("/", requireAgent);
publish.use("/*", requireAgent);

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

const SkillCreatorReportSchema = z.object({
  status: z.enum(["clean", "warn", "block"]),
});

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

publish.post("/", async (c) => {
  const agent = getAgent(c);
  const db = makeDb(c.env);

  // Rate limit (halved for new unverified agents)
  const newAgent = isNewUnverifiedAgent(agent);
  const rl = await checkRateLimit(
    db,
    rateLimitKey("agent", agent.id, "publish", agent.tenantId),
    LIMITS.publish,
    newAgent,
  );
  if (!rl.allowed) {
    return errorResponse(c, "rate_limited", "Publish rate limit exceeded.", {
      retryAfterSeconds: rl.retryAfterSeconds,
    });
  }

  // Anti-spam: new unverified agents must solve the math challenge handed
  // out by the previous heartbeat. Verified or >24h-old agents are
  // unaffected. Header format: `X-Skillhub-Challenge: <token>:<answer>`.
  if (newAgent) {
    const header = c.req.header("x-skillhub-challenge") ?? "";
    const sepIdx = header.lastIndexOf(":");
    if (!header || sepIdx <= 0) {
      return errorResponse(
        c,
        "forbidden",
        "New unverified agents must solve the anti-spam challenge issued by the heartbeat endpoint.",
        {
          hint: "Call /v1/agents/me/heartbeat first, then include `X-Skillhub-Challenge: <token>:<answer>`.",
          details: { subcode: "challenge_required" },
        },
      );
    }
    const token = header.slice(0, sepIdx);
    const answer = Number(header.slice(sepIdx + 1));
    if (!Number.isFinite(answer)) {
      return errorResponse(c, "forbidden", "Invalid challenge answer.", {
        details: { subcode: "challenge_failed", reason: "non_numeric_answer" },
      });
    }
    const verdict = await verifyChallenge(agent.id, answer, token, c.env);
    if (!verdict.ok) {
      return errorResponse(
        c,
        "forbidden",
        `Anti-spam challenge failed: ${verdict.reason ?? "unknown"}`,
        {
          hint: "Request a fresh challenge via /v1/agents/me/heartbeat.",
          details: { subcode: "challenge_failed", reason: verdict.reason },
        },
      );
    }
  }

  // Parse multipart
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return errorResponse(c, "invalid_input", "Body must be multipart/form-data.");
  }

  const skillBlob = form.get("skill");
  const manifestStr = form.get("manifest");
  const scrubReportStr = form.get("scrub_report");
  const skillCreatorReportStr = form.get("skill_creator_report");

  // FormData.get returns FormDataEntryValue (string | File). Workers types
  // expose Blob/File as the same shape; check via duck-typing on arrayBuffer.
  if (
    !skillBlob ||
    typeof skillBlob === "string" ||
    typeof (skillBlob as Blob).arrayBuffer !== "function"
  ) {
    return errorResponse(c, "invalid_input", "Missing 'skill' file part.");
  }
  if ((skillBlob as Blob).size > MAX_UPLOAD_BYTES) {
    return errorResponse(
      c,
      "invalid_input",
      `Skill archive too large (${skillBlob.size} > ${MAX_UPLOAD_BYTES}).`,
    );
  }
  if (typeof manifestStr !== "string") {
    return errorResponse(c, "invalid_input", "Missing 'manifest' field.");
  }
  if (typeof scrubReportStr !== "string") {
    return errorResponse(c, "invalid_input", "Missing 'scrub_report' field.");
  }
  if (typeof skillCreatorReportStr !== "string") {
    return errorResponse(c, "invalid_input", "Missing 'skill_creator_report' field.");
  }

  const manifestParsed = ManifestSchema.safeParse(safeJson(manifestStr));
  if (!manifestParsed.success) {
    return errorResponse(c, "invalid_input", "Invalid manifest JSON.", {
      details: manifestParsed.error.issues,
    });
  }
  const manifest = manifestParsed.data;

  const clientScrubParsed = ScrubReportSchema.safeParse(safeJson(scrubReportStr));
  if (!clientScrubParsed.success) {
    return errorResponse(c, "invalid_input", "Invalid scrub_report JSON.", {
      details: clientScrubParsed.error.issues,
    });
  }
  const clientScrub = clientScrubParsed.data;
  if (clientScrub.overall_severity === "block") {
    return errorResponse(
      c,
      "block_finding",
      "Client scrub report marked the skill as 'block'. Fix and re-upload.",
      { findings: clientScrub.findings },
    );
  }

  const scParsed = SkillCreatorReportSchema.safeParse(safeJson(skillCreatorReportStr));
  if (!scParsed.success) {
    return errorResponse(c, "invalid_input", "Invalid skill_creator_report JSON.", {
      details: scParsed.error.issues,
    });
  }
  if (scParsed.data.status === "block") {
    return errorResponse(
      c,
      "block_finding",
      "skill-creator quality gate marked the skill as 'block'.",
    );
  }

  // Read .skill bytes
  const arrayBuffer = await skillBlob.arrayBuffer();
  const zipBytes = new Uint8Array(arrayBuffer);
  const contentHash = await sha256Hex(zipBytes);

  // Server-side defense-in-depth scrub re-scan
  let textFiles;
  try {
    textFiles = textFilesFromZip(zipBytes);
  } catch (e) {
    return errorResponse(
      c,
      "invalid_input",
      `Skill archive is not a valid ZIP: ${(e as Error).message}`,
    );
  }
  const serverScan = scanSkill(textFiles);
  if (serverScan.overallSeverity === "block") {
    return errorResponse(
      c,
      "block_finding",
      "Server-side regex re-scan found content the client missed. Re-sanitize and re-review.",
      {
        findings: serverScan.findings,
        hint: "See base-skill/references/scrubbing.md",
      },
    );
  }

  // ---------------------------------------------------------------------
  // Anti-exfiltration filter
  //
  // Protects the *downstream session* from a rogue skill. Runs after the
  // publisher-focused scrub above. Has two authoritative tiers:
  //
  //   block  → reject outright (invisible Unicode, webhook sinks, curl|sh,
  //            base64-decodes-to-block)
  //   review → accept the upload but hold the version in review_status
  //            'pending' so it is invisible to search/download until a
  //            human moderator clears it via docs/review-queue-runbook.md.
  //
  // Scans both the extracted file contents AND the manifest text fields,
  // since the latter are fed into embeddings and rendered on public pages
  // without any other content validation.
  // ---------------------------------------------------------------------
  const manifestAsFile = {
    path: "(manifest)",
    content: [
      manifest.display_name,
      manifest.short_desc,
      manifest.long_desc_md ?? "",
      (manifest.tags ?? []).join(" "),
      manifest.category ?? "",
      manifest.changelog_md ?? "",
    ]
      .filter((s) => s.length > 0)
      .join("\n\n"),
  };

  const manifestScrub = scanSkill([manifestAsFile]);
  if (manifestScrub.overallSeverity === "block") {
    return errorResponse(
      c,
      "block_finding",
      "Manifest text contains content flagged by the regex scrub.",
      { findings: manifestScrub.findings },
    );
  }

  const exfilResult = detectExfiltration(textFiles);
  const manifestExfil = detectExfiltration([manifestAsFile]);
  // LLM classifier — stub today, returns [] unless EXFIL_LLM_ENABLED=true.
  const llmFindings = await classifyWithLLM(
    [...textFiles, manifestAsFile],
    c.env,
  );
  const llmResult = {
    overallSeverity:
      llmFindings.find((f) => f.severity === "block")
        ? ("block" as const)
        : llmFindings.find((f) => f.severity === "review")
          ? ("review" as const)
          : llmFindings.find((f) => f.severity === "warn")
            ? ("warn" as const)
            : ("clean" as const),
    findings: llmFindings,
  };

  const exfilSeverity = worstOf(exfilResult, manifestExfil, llmResult);
  const mergedExfilFindings = [
    ...exfilResult.findings,
    ...manifestExfil.findings,
    ...llmResult.findings,
  ];

  if (exfilSeverity === "block") {
    return errorResponse(
      c,
      "block_finding",
      "Skill blocked by anti-exfiltration filter.",
      {
        findings: mergedExfilFindings.filter((f) => f.severity === "block"),
        hint:
          "See base-skill/skillhub/references/scrubbing.md § Exfiltration defenses.",
      },
    );
  }

  const reviewStatus: "approved" | "pending" =
    exfilSeverity === "review" ? "pending" : "approved";

  // Upload to R2
  const r2Key = skillVersionKey(manifest.slug, manifest.semver);
  try {
    await putSkill(c.env.SKILLS_BUCKET, r2Key, zipBytes, "application/zip");
  } catch (e) {
    return errorResponse(c, "server_error", `R2 upload failed: ${(e as Error).message}`);
  }

  // Insert or look up skill row (idempotent on slug)
  const existing = await db
    .select()
    .from(skills)
    .where(eq(skills.slug, manifest.slug))
    .limit(1);

  let skillId: string;
  if (existing.length > 0) {
    const skill = existing[0]!;
    if (skill.authorAgentId !== agent.id) {
      return errorResponse(c, "forbidden", "This slug is owned by a different agent.");
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
      return errorResponse(c, "server_error", "Failed to create skill row.");
    }
    skillId = created.id;
  }

  // Scrub report — store the exfiltration findings alongside the regex ones
  // in the existing `llm_findings` JSONB column. The column is historically
  // named for the client-side LLM review (which this codepath does not run
  // server-side), so reusing it for the exfiltration-filter findings avoids
  // a schema change. Each finding carries its own `tier` field
  // ("rule" | "llm") so downstream tooling can tell them apart.
  const [scrubRow] = await db
    .insert(scrubReports)
    .values({
      regexFindings: clientScrub.findings,
      serverRescanFindings: serverScan.findings,
      llmFindings: mergedExfilFindings,
      // `scrub_status` enum is clean|warn|block and can't represent "review".
      // Use "warn" for review-tier holds so the column stays within its
      // existing domain; the authoritative review state lives on
      // skill_versions.review_status.
      status:
        reviewStatus === "pending"
          ? "warn"
          : serverScan.overallSeverity === "warn"
            ? "warn"
            : "clean",
      reviewedByUser: true,
    })
    .returning();

  // Version uniqueness
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
      c,
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
      reviewStatus,
      reviewNotes:
        reviewStatus === "pending"
          ? `Held by anti-exfiltration filter. ${mergedExfilFindings
              .filter((f) => f.severity === "review")
              .length} review-tier finding(s). See scrub_reports.llm_findings.`
          : null,
    })
    .returning();
  if (!newVersion) {
    return errorResponse(c, "server_error", "Failed to create version row.");
  }

  // Only promote the skill row (currentVersionId, display metadata) when the
  // new version is approved. Pending versions land in the DB and R2 but must
  // stay invisible until a moderator clears them, so we do NOT overwrite the
  // public-facing fields on `skills`.
  if (reviewStatus === "approved") {
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

    // Fire-and-forget: embed the skill for semantic search in the background
    // via Cloudflare's executionCtx.waitUntil. Skipped for pending versions
    // — re-embedding runs when the moderator approves.
    c.executionCtx.waitUntil(
      embedSkill(c.env, skillId)
        .then((r) => console.log("[publish.embedSkill]", r))
        .catch((e) => console.warn("[publish.embedSkill] failed", e)),
    );
  } else {
    console.log(
      `[publish] version ${newVersion.id} held for review (${mergedExfilFindings.filter((f) => f.severity === "review").length} findings)`,
    );
  }

  // Audit trail — fire and forget (never blocks the response).
  c.executionCtx.waitUntil(
    writeAudit(db, {
      tenantId: agent.tenantId ?? null,
      actorType: "agent",
      actorId: agent.id,
      action: "skill.published",
      targetType: "skill",
      targetId: skillId,
      ip: clientIp(c),
      userAgent: c.req.header("user-agent") ?? null,
      metadata: {
        slug: manifest.slug,
        semver: manifest.semver,
        version_id: newVersion.id,
        size_bytes: zipBytes.length,
        content_hash: contentHash,
      },
    }),
  );

  return c.json({
    skill_id: skillId,
    slug: manifest.slug,
    version_id: newVersion.id,
    semver: manifest.semver,
    public_url: `${c.env.APP_URL}/s/${manifest.slug}`,
    r2_key: r2Key,
    published_at: newVersion.publishedAt.toISOString(),
    review_status: reviewStatus,
    review_findings:
      reviewStatus === "pending"
        ? mergedExfilFindings.filter((f) => f.severity === "review")
        : undefined,
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Cast to BufferSource so TS picks the right overload on the Worker types
  const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  const arr = new Uint8Array(buf);
  let hex = "";
  for (const b of arr) hex += b.toString(16).padStart(2, "0");
  return hex;
}
