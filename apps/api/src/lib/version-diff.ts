/**
 * Version-diff-aware scanning for skill updates.
 *
 * When a skill publishes v1.0.1, this module fetches the previous approved
 * version from R2, extracts text files, and runs the exfiltration detector
 * ONLY on changed/new content. Catches the "pass review clean, add malware
 * in the patch" pattern that ClawHavoc exploited.
 *
 * Skips entirely on first publish (no previous version to diff against).
 */

import { and, eq, desc } from "drizzle-orm";
import type { Db } from "@/db";
import { skillVersions } from "@/db/schema";
import { textFilesFromZip } from "@/lib/unzip";
import {
  detectExfiltration,
  type ExfiltrationResult,
  type ExfiltrationFinding,
} from "@/lib/scrub/exfiltration";
import type { ScanFile } from "@/lib/scrub/regex";

const CLEAN_RESULT: ExfiltrationResult = {
  overallSeverity: "clean",
  findings: [],
};

/**
 * Scan only the content that changed between the previous approved version
 * and the new files being published.
 *
 * Returns an ExfiltrationResult with findings tagged tier: "rule" (from the
 * exfiltration detector). The publish route merges these via worstOf().
 *
 * @param skillId - The skill being updated
 * @param newFiles - Text files extracted from the new ZIP
 * @param bucket - R2 bucket binding to fetch the previous version
 */
export async function scanVersionDiff(
  db: Db,
  bucket: R2Bucket,
  skillId: string,
  newFiles: ScanFile[],
): Promise<ExfiltrationResult> {
  // Find the most recent approved version for this skill
  const [prevVersion] = await db
    .select({ r2Key: skillVersions.r2Key })
    .from(skillVersions)
    .where(
      and(
        eq(skillVersions.skillId, skillId),
        eq(skillVersions.reviewStatus, "approved"),
      ),
    )
    .orderBy(desc(skillVersions.publishedAt))
    .limit(1);

  // First publish — nothing to diff against
  if (!prevVersion) return CLEAN_RESULT;

  // Fetch previous version from R2
  const r2Object = await bucket.get(prevVersion.r2Key);
  if (!r2Object) return CLEAN_RESULT;

  const prevBytes = new Uint8Array(await r2Object.arrayBuffer());
  let prevFiles: ScanFile[];
  try {
    prevFiles = textFilesFromZip(prevBytes);
  } catch {
    // If we can't read the previous version, skip diff scanning
    return CLEAN_RESULT;
  }

  // Build a map of previous file contents for fast lookup
  const prevMap = new Map<string, string>();
  for (const f of prevFiles) {
    prevMap.set(f.path, f.content);
  }

  // Collect only changed or new files
  const changedFiles: ScanFile[] = [];
  for (const newFile of newFiles) {
    const prevContent = prevMap.get(newFile.path);
    if (prevContent === undefined) {
      // New file — scan entirely
      changedFiles.push(newFile);
    } else if (prevContent !== newFile.content) {
      // Changed file — scan the new version
      // (We scan the full new file, not just the diff lines, because
      // exfiltration patterns can span context that was already there)
      changedFiles.push(newFile);
    }
    // Unchanged files are skipped
  }

  if (changedFiles.length === 0) return CLEAN_RESULT;

  // Run exfiltration detection on changed content only
  const result = detectExfiltration(changedFiles);

  // Tag findings so the publish route can distinguish diff-originated findings
  const taggedFindings: ExfiltrationFinding[] = result.findings.map((f) => ({
    ...f,
    reason: `[version-diff] ${f.reason}`,
  }));

  return {
    overallSeverity: result.overallSeverity,
    findings: taggedFindings,
  };
}
