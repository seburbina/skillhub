/**
 * Hard-delete yanked skill content from R2 after the 24h grace window.
 *
 * Why the grace?
 *   When an admin yanks a version, in-flight downloads (signed URLs, CDN
 *   caches, the user that just ran `agent install`) can still be racing to
 *   pull the object. Deleting immediately would 404 them mid-install and
 *   leave broken setups. 24h is well past every cache TTL we control,
 *   short enough that leaked / guessed URLs don't stay live for long.
 *
 * What we do per eligible row:
 *   1. Fetch the .skill ZIP from R2 (so we can still archive it).
 *   2. Mirror it + a tombstone JSON to `yanked/<slug>/v<semver>/` on the
 *      GitHub mirror repo. This preserves the audit trail forever even
 *      after R2 is empty — DMCA / takedown reviewers need the bits.
 *   3. Hard-delete the R2 object.
 *   4. Stamp `skill_versions.r2_deleted_at = NOW()` (idempotency marker
 *      so we don't reprocess).
 *   5. Write an `audit_events` row, action = `skill.r2_deleted_after_yank`.
 *
 * Why mirror BEFORE delete: if mirroring fails we'd rather still purge R2
 * than leak content. Mirror failures get logged + carried into the audit
 * metadata; we still mark the row done so the cron isn't stuck retrying
 * forever on an R2 object that can't be mirrored.
 *
 * Why missing R2 is not an error: a previous run may have crashed AFTER
 * deleting R2 but BEFORE stamping r2_deleted_at. Treat absent R2 as
 * "already deleted" and just close the audit loop.
 *
 * Triggering: called inside the `mirror-to-github` cron (every 5 min) so
 * we don't burn one of the 3 cron slots Cloudflare Free gives us. 24h
 * grace means 5-min latency is fine.
 *
 * Requires `GITHUB_MIRROR_TOKEN` for the GitHub mirror leg. Without it
 * we skip cleanup entirely — we won't delete R2 unless we can also
 * archive, otherwise we'd lose the audit copy.
 */
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { makeDb, type Db } from "@/db";
import { skills, skillVersions } from "@/db/schema";
import { writeAudit } from "@/lib/audit";
import type { Bindings } from "@/types";

const REPO = "seburbina/skillhub-skills";
const BATCH_SIZE = 50;
const GITHUB_API = "https://api.github.com";

/** Hours of grace between `yanked_at` and the R2 hard-delete. */
export const GRACE_PERIOD_HOURS = 24;

/** One row's worth of context for the per-version processing step. */
export interface YankedCandidate {
  versionId: string;
  semver: string;
  r2Key: string;
  slug: string;
  yankedAt: Date | null;
}

export interface CleanupResult {
  processed: number;
  r2Deleted: number;
  mirrored: number;
  mirrorFailures: number;
  r2Missing: number;
  errors: number;
}

/**
 * Find versions eligible for hard-delete: yanked >24h ago and not yet
 * `r2_deleted_at` stamped.
 *
 * Exported so the cleanup test suite can replace just this read step with
 * a fixture instead of mocking Drizzle's chained query builder.
 */
export async function findEligibleYankedVersions(
  db: Db,
): Promise<YankedCandidate[]> {
  return db
    .select({
      versionId: skillVersions.id,
      semver: skillVersions.semver,
      r2Key: skillVersions.r2Key,
      slug: skills.slug,
      yankedAt: skillVersions.yankedAt,
    })
    .from(skillVersions)
    .innerJoin(skills, eq(skillVersions.skillId, skills.id))
    .where(
      and(
        isNotNull(skillVersions.yankedAt),
        isNull(skillVersions.r2DeletedAt),
        sql`${skillVersions.yankedAt} < NOW() - INTERVAL '${sql.raw(String(GRACE_PERIOD_HOURS))} hours'`,
      ),
    )
    .limit(BATCH_SIZE);
}

/**
 * Process a single eligible version: archive to GitHub, delete from R2,
 * stamp the row, write audit.
 *
 * Exported (and parameterized on `env` + `db`) so it can be exercised in
 * isolation by the test suite with mocked R2 + DB.
 *
 * Order matters:
 *   - Mirror first (so we don't lose the bytes if R2 delete + DB stamp
 *     both succeed but a later mirror retry can't find the object).
 *   - R2 delete regardless of mirror result (priority is purging
 *     accessible content; mirror is best-effort audit).
 *   - DB stamp + audit at the end, so a crash mid-process leaves the row
 *     eligible for retry on the next tick.
 */
export async function processYankedVersion(
  env: Bindings,
  db: Db,
  candidate: YankedCandidate,
): Promise<{
  mirrored: boolean;
  mirrorFailed: boolean;
  r2WasMissing: boolean;
}> {
  const obj = await env.SKILLS_BUCKET.get(candidate.r2Key);
  const r2WasMissing = !obj;

  // Mirror first. If mirror throws we'd rather still purge R2 — leaving
  // bytes accessible is worse than losing the GitHub archive.
  let mirrored = false;
  let mirrorFailed = false;
  if (obj) {
    const zipBytes = new Uint8Array(await obj.arrayBuffer());
    try {
      await mirrorToYankedArchive(
        env.GITHUB_MIRROR_TOKEN!,
        candidate.slug,
        candidate.semver,
        zipBytes,
        { yankedAt: candidate.yankedAt?.toISOString() ?? null },
      );
      mirrored = true;
    } catch (e) {
      mirrorFailed = true;
      console.warn(
        `[r2-cleanup-yanked] mirror failed for ${candidate.slug} v${candidate.semver}; deleting R2 anyway:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  // Hard-delete the R2 object. R2's delete is idempotent — no-op when
  // absent — so the "R2 was missing" case flows harmlessly through here.
  await env.SKILLS_BUCKET.delete(candidate.r2Key);

  // Mark the row done so the cron doesn't keep reprocessing it.
  await db
    .update(skillVersions)
    .set({ r2DeletedAt: new Date() })
    .where(eq(skillVersions.id, candidate.versionId));

  await writeAudit(db, {
    actorType: "system",
    action: "skill.r2_deleted_after_yank",
    targetType: "skill_version",
    targetId: candidate.versionId,
    metadata: {
      slug: candidate.slug,
      semver: candidate.semver,
      r2_key: candidate.r2Key,
      yanked_at: candidate.yankedAt?.toISOString() ?? null,
      grace_period_hours: GRACE_PERIOD_HOURS,
      mirrored,
      mirror_failed: mirrorFailed,
      r2_was_missing: r2WasMissing,
    },
  });

  return { mirrored, mirrorFailed, r2WasMissing };
}

export async function cleanupYankedR2(env: Bindings): Promise<CleanupResult> {
  const result: CleanupResult = {
    processed: 0,
    r2Deleted: 0,
    mirrored: 0,
    mirrorFailures: 0,
    r2Missing: 0,
    errors: 0,
  };

  if (!env.GITHUB_MIRROR_TOKEN) {
    console.warn(
      "[r2-cleanup-yanked] GITHUB_MIRROR_TOKEN not set; skipping (would lose audit copy)",
    );
    return result;
  }

  const db = makeDb(env);
  const candidates = await findEligibleYankedVersions(db);

  for (const candidate of candidates) {
    result.processed++;
    try {
      const outcome = await processYankedVersion(env, db, candidate);
      result.r2Deleted++;
      if (outcome.mirrored) result.mirrored++;
      if (outcome.mirrorFailed) result.mirrorFailures++;
      if (outcome.r2WasMissing) result.r2Missing++;
    } catch (e) {
      result.errors++;
      console.warn(
        `[r2-cleanup-yanked] ${candidate.slug} v${candidate.semver} failed:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// GitHub Contents API helpers — mirrors the pattern from
// jobs/mirror-to-github.ts but writes under the `yanked/` prefix and adds
// a tombstone JSON sibling.
// ---------------------------------------------------------------------------

async function mirrorToYankedArchive(
  token: string,
  slug: string,
  semver: string,
  zipBytes: Uint8Array,
  meta: { yankedAt: string | null },
): Promise<void> {
  const prefix = `yanked/${slug}/v${semver}`;

  // The .skill bytes themselves. GitHub Contents API will 422 if it
  // already exists at this path — that's fine, idempotent re-run.
  await putContent(
    token,
    `${prefix}/skill.zip`,
    zipBytes,
    `archive yanked ${slug} v${semver}: skill.zip`,
  );

  // Tombstone JSON so a forensic reader can see when/why the version
  // was yanked without joining back against the live DB.
  const tombstone = JSON.stringify(
    {
      slug,
      semver,
      yanked_at: meta.yankedAt,
      r2_deleted_at: new Date().toISOString(),
      archived_by: "r2-cleanup-yanked",
      note: "Auto-archived from R2 after the 24h grace window. Source skill_versions row is preserved in the DB with r2_deleted_at set.",
    },
    null,
    2,
  );
  const tombstoneBytes = new TextEncoder().encode(tombstone);
  await putContent(
    token,
    `${prefix}/tombstone.json`,
    tombstoneBytes,
    `archive yanked ${slug} v${semver}: tombstone.json`,
  );
}

async function putContent(
  token: string,
  repoPath: string,
  bytes: Uint8Array,
  message: string,
): Promise<{ commitSha: string | null; alreadyExists: boolean }> {
  const url = `${GITHUB_API}/repos/${REPO}/contents/${encodePathSegments(repoPath)}`;
  const body = JSON.stringify({
    message,
    content: bytesToBase64(bytes),
  });
  const res = await fetch(url, {
    method: "PUT",
    headers: githubHeaders(token),
    body,
  });
  if (res.status === 422) {
    // Already exists at that path — idempotent skip.
    return { commitSha: null, alreadyExists: true };
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `GitHub PUT ${repoPath} → ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as { commit?: { sha?: string } };
  return { commitSha: json.commit?.sha ?? null, alreadyExists: false };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "skillhub-r2-cleanup",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** URL-encode each path segment but keep the slashes. */
function encodePathSegments(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/**
 * Uint8Array → base64, chunked to avoid call-stack overflow on large files.
 * Workers expose `btoa` which needs a binary string, so we build that in
 * 32k chunks.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
