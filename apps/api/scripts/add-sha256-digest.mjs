#!/usr/bin/env node
/**
 * One-shot migration: add `sha256_digest` to skill_versions + backfill.
 *
 * This column was introduced by the .well-known/agent-skills discovery
 * endpoint (PR #25) but the migration script was missing from the repo.
 * Prod got ALTERed ad-hoc during the skills.sh import incident; this
 * script exists so fresh envs pick up the column correctly.
 *
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/add-sha256-digest.mjs
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
    const r = await fn();
    console.log("ok" + (typeof r === "number" ? ` (${r})` : ""));
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.includes("already exists") || msg.includes("duplicate")) {
      console.log("skip (" + msg.split("\n")[0] + ")");
      return;
    }
    console.log("FAIL");
    console.error("    " + msg);
    throw e;
  }
}

console.log("\n=== add-sha256-digest ===");

await step("ALTER TABLE skill_versions ADD COLUMN sha256_digest", () =>
  sql(`ALTER TABLE skill_versions ADD COLUMN IF NOT EXISTS sha256_digest text`),
);

await step("Backfill sha256_digest from content_hash", async () => {
  const rows = await sql(
    `UPDATE skill_versions
        SET sha256_digest = 'sha256:' || content_hash
      WHERE sha256_digest IS NULL
        AND content_hash IS NOT NULL
      RETURNING id`,
  );
  return rows.length;
});

const verify = await sql(`
  SELECT COUNT(*)::int AS total, COUNT(sha256_digest)::int AS filled
  FROM skill_versions
`);
console.log("\nVerification:");
console.log(`  skill_versions.total:  ${verify[0].total}`);
console.log(`  skill_versions.filled: ${verify[0].filled}`);
console.log("\nMigration complete.");
