/**
 * Typosquat detection for skill slugs.
 *
 * Compares a new slug against established skills (install_count >= 10) using
 * Levenshtein distance. Flags suspicious near-matches for human review
 * rather than hard-blocking — legitimate "pdf-v2" scenarios exist.
 *
 * Motivated by the ClawHavoc attack where 29 skills used near-identical
 * names to popular legitimate skills.
 */

import { sql } from "drizzle-orm";
import type { Db } from "@/db";

export interface TyposquatResult {
  isSuspicious: boolean;
  similarSlugs: string[];
}

/**
 * Check whether `slug` is suspiciously similar to an existing popular skill.
 *
 * Thresholds:
 *   - slugs <= 12 chars: Levenshtein distance <= 2
 *   - slugs > 12 chars:  Levenshtein distance <= 3
 *   - also flags if new slug is a substring variant of a popular slug
 *     (e.g. `pdf-v2`, `pdf-helper`, `pdf-updated`)
 */
export async function checkTyposquat(
  db: Db,
  slug: string,
  minInstalls = 10,
): Promise<TyposquatResult> {
  // Fetch established skill slugs. This is a small set (install_count >= 10
  // is a high bar for a new registry) so in-memory comparison is fine.
  const rows = await db.execute<{ slug: string }>(sql`
    SELECT slug FROM skills
    WHERE install_count >= ${minInstalls}
      AND deleted_at IS NULL
  `);

  const popularSlugs = rows.rows.map((r) => r.slug);
  const similarSlugs: string[] = [];
  const threshold = slug.length <= 12 ? 2 : 3;

  for (const existing of popularSlugs) {
    // Exact match is fine — same author updating their own skill
    if (existing === slug) continue;

    const dist = levenshtein(slug, existing);
    if (dist <= threshold) {
      similarSlugs.push(existing);
      continue;
    }

    // Substring variant check: new slug contains a popular slug with a
    // prefix/suffix (e.g. "pdf-v2" contains "pdf", "my-pdf" contains "pdf")
    if (slug.length > existing.length && slug.includes(existing)) {
      similarSlugs.push(existing);
    }
  }

  return {
    isSuspicious: similarSlugs.length > 0,
    similarSlugs,
  };
}

/**
 * Standard Levenshtein distance (edit distance) between two strings.
 * O(m*n) time, O(min(m,n)) space via single-row optimization.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Keep the shorter string as 'b' for the single-row optimization
  if (a.length < b.length) [a, b] = [b, a];

  const bLen = b.length;
  const row = new Array<number>(bLen + 1);
  for (let j = 0; j <= bLen; j++) row[j] = j;

  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(
        row[j]! + 1,       // deletion
        row[j - 1]! + 1,   // insertion
        prev + cost,        // substitution
      );
      prev = row[j]!;
      row[j] = val;
    }
  }

  return row[bLen]!;
}
