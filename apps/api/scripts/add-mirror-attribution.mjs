#!/usr/bin/env node
/**
 * One-shot migration: add upstream-attribution columns to `skills`.
 *
 * Adds:
 *   - skills.upstream_url      text  (e.g. https://github.com/owner/repo)
 *   - skills.original_author   text  (free-form display name)
 *   - skills.mirrored_from     text  (source directory, e.g. "skills.sh")
 *   - partial index on mirrored rows
 *
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/add-mirror-attribution.mjs
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
    await fn();
    console.log("ok");
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

console.log("\n=== add-mirror-attribution ===");

await step("ALTER TABLE skills ADD COLUMN upstream_url", () =>
  sql(`ALTER TABLE skills ADD COLUMN IF NOT EXISTS upstream_url text`),
);
await step("ALTER TABLE skills ADD COLUMN original_author", () =>
  sql(`ALTER TABLE skills ADD COLUMN IF NOT EXISTS original_author text`),
);
await step("ALTER TABLE skills ADD COLUMN mirrored_from", () =>
  sql(`ALTER TABLE skills ADD COLUMN IF NOT EXISTS mirrored_from text`),
);
await step("CREATE INDEX skills_mirrored_from_idx", () =>
  sql(`
    CREATE INDEX IF NOT EXISTS skills_mirrored_from_idx
    ON skills (mirrored_from)
    WHERE mirrored_from IS NOT NULL
  `),
);

const verify = await sql(`
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'skills'
    AND column_name IN ('upstream_url', 'original_author', 'mirrored_from')
  ORDER BY column_name
`);
console.log("\nVerification:");
for (const row of verify) console.log(`  ${row.column_name}: ${row.data_type}`);
console.log("\nMigration complete.");
