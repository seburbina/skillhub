#!/usr/bin/env node
/**
 * T-014 — adds the `skill_versions.r2_deleted_at` column.
 *
 * apps/api/src/db/schema.ts declares the column; this script makes it real
 * in any environment that already has a `skill_versions` table. Idempotent —
 * safe to re-run; the schema-diff CI guard verifies that.
 *
 * Set by the cron-driven r2-cleanup-yanked job after the 24h grace window
 * once the R2 object has been hard-deleted (and a copy archived to GitHub
 * under `yanked/<slug>/v<semver>/`). NULL means the R2 object is still live
 * (or the version was never yanked).
 *
 * Usage:
 *   DATABASE_URL=postgres://... node apps/api/scripts/add-r2-deleted-at.mjs
 */
import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = neon(DATABASE_URL);

async function step(label, fn) {
  process.stdout.write(`  ${label}... `);
  try {
    const result = await fn();
    console.log("ok" + (result != null ? ` (${result})` : ""));
  } catch (e) {
    console.log("FAIL");
    console.error("    " + (e.message || e));
    throw e;
  }
}

console.log("T-014 — add skill_versions.r2_deleted_at");

await step("skill_versions.r2_deleted_at: add column if not exists", async () => {
  await sql(`
    ALTER TABLE skill_versions
    ADD COLUMN IF NOT EXISTS r2_deleted_at timestamptz
  `);
});

await step("verify — column present, count rows by state", async () => {
  const r = await sql(`
    SELECT
      COUNT(*)::int                              AS total,
      COUNT(yanked_at)::int                      AS yanked,
      COUNT(r2_deleted_at)::int                  AS r2_deleted
    FROM skill_versions
  `);
  const row = r[0] ?? {};
  return `${row.total} versions · ${row.yanked} yanked · ${row.r2_deleted} r2-deleted`;
});

console.log("\nDone.");
