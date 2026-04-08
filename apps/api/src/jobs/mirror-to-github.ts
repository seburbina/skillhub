/**
 * Mirror published skill versions to a public GitHub repo.
 *
 * R2 stays canonical. GitHub is a free audit log + CDN fallback + the
 * "git history everything" intuition. Runs hourly via Cloudflare Cron
 * Triggers (see `apps/api/src/index.ts`).
 *
 * For each unmirrored, unyanked version (newest first, batch of 5):
 *   1. Fetch the .skill ZIP from R2
 *   2. Decompress with fflate
 *   3. PUT every entry under `<slug>/v<semver>/<path>` via the
 *      GitHub Contents API
 *   4. Record the last returned commit SHA on `skill_versions.github_commit_sha`
 *
 * Idempotent at the per-file level: GitHub returns 422 if a file already
 * exists at that path, which we treat as "already mirrored" and skip.
 *
 * Requires `GITHUB_MIRROR_TOKEN` — a fine-grained PAT scoped to
 * `contents:write` on `seburbina/skillhub-skills` only. Set via
 * `wrangler secret put GITHUB_MIRROR_TOKEN`.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { unzipSync } from "fflate";
import { makeDb } from "@/db";
import { skills, skillVersions } from "@/db/schema";
import type { Bindings } from "@/types";

const REPO = "seburbina/skillhub-skills";
const BATCH_SIZE = 5;
const GITHUB_API = "https://api.github.com";

export async function mirrorToGithub(
  env: Bindings,
): Promise<{ mirrored: number; skipped: number; errors: number }> {
  if (!env.GITHUB_MIRROR_TOKEN) {
    console.warn("[mirror-to-github] GITHUB_MIRROR_TOKEN not set; skipping");
    return { mirrored: 0, skipped: 0, errors: 0 };
  }
  const db = makeDb(env);

  const candidates = await db
    .select({
      versionId: skillVersions.id,
      semver: skillVersions.semver,
      r2Key: skillVersions.r2Key,
      slug: skills.slug,
    })
    .from(skillVersions)
    .innerJoin(skills, eq(skillVersions.skillId, skills.id))
    .where(
      and(
        isNull(skillVersions.githubCommitSha),
        isNull(skillVersions.yankedAt),
        isNull(skills.deletedAt),
      ),
    )
    .orderBy(desc(skillVersions.publishedAt))
    .limit(BATCH_SIZE);

  let mirrored = 0;
  let skipped = 0;
  let errors = 0;

  for (const v of candidates) {
    try {
      const obj = await env.SKILLS_BUCKET.get(v.r2Key);
      if (!obj) {
        console.warn(
          `[mirror-to-github] R2 miss: ${v.slug} v${v.semver} (${v.r2Key})`,
        );
        errors++;
        continue;
      }
      const zipBytes = new Uint8Array(await obj.arrayBuffer());
      let entries: Record<string, Uint8Array>;
      try {
        entries = unzipSync(zipBytes);
      } catch (e) {
        console.warn(
          `[mirror-to-github] unzip failed for ${v.slug} v${v.semver}`,
          e,
        );
        errors++;
        continue;
      }

      let lastCommitSha: string | null = null;
      let wroteAny = false;
      for (const [entryPath, bytes] of Object.entries(entries)) {
        if (entryPath.endsWith("/")) continue; // skip directories
        const repoPath = `${v.slug}/v${v.semver}/${entryPath}`;
        const result = await putContent(
          env.GITHUB_MIRROR_TOKEN!,
          repoPath,
          bytes,
          `mirror(${v.slug} v${v.semver}): ${entryPath}`,
        );
        if (result.commitSha) {
          lastCommitSha = result.commitSha;
          wroteAny = true;
        }
      }

      if (wroteAny && lastCommitSha) {
        await db
          .update(skillVersions)
          .set({ githubCommitSha: lastCommitSha })
          .where(eq(skillVersions.id, v.versionId));
        mirrored++;
      } else {
        // All files already existed on GitHub — the version is effectively
        // mirrored, record a sentinel so we don't keep retrying. Pick any
        // existing commit on the default branch.
        const sentinel = await getDefaultBranchHeadSha(env.GITHUB_MIRROR_TOKEN!);
        if (sentinel) {
          await db
            .update(skillVersions)
            .set({ githubCommitSha: sentinel })
            .where(eq(skillVersions.id, v.versionId));
        }
        skipped++;
      }
    } catch (e) {
      errors++;
      console.warn(
        `[mirror-to-github] ${v.slug} v${v.semver} failed:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return { mirrored, skipped, errors };
}

// ---------------------------------------------------------------------------
// GitHub Contents API helpers
// ---------------------------------------------------------------------------

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
    throw new Error(`GitHub PUT ${repoPath} → ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { commit?: { sha?: string } };
  return { commitSha: json.commit?.sha ?? null, alreadyExists: false };
}

async function getDefaultBranchHeadSha(token: string): Promise<string | null> {
  const res = await fetch(`${GITHUB_API}/repos/${REPO}`, {
    headers: githubHeaders(token),
  });
  if (!res.ok) return null;
  const repoJson = (await res.json()) as { default_branch?: string };
  const branch = repoJson.default_branch ?? "main";
  const refRes = await fetch(
    `${GITHUB_API}/repos/${REPO}/git/refs/heads/${branch}`,
    { headers: githubHeaders(token) },
  );
  if (!refRes.ok) return null;
  const refJson = (await refRes.json()) as { object?: { sha?: string } };
  return refJson.object?.sha ?? null;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "skillhub-mirror",
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
