#!/usr/bin/env node
/**
 * One-shot migration: add the anti-exfiltration review queue columns.
 *
 * Adds:
 *   - enum `review_status` ('approved','pending','rejected')
 *   - `skill_versions.review_status review_status NOT NULL DEFAULT 'approved'`
 *   - `skill_versions.review_notes text`
 *   - partial index on pending rows (for moderator queue queries)
 *
 * The Drizzle schema has already been updated to match. Running this before
 * the next deploy ensures the DB matches what src/db/schema.ts declares.
 *
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/add-review-status.mjs
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
    console.log("ok" + (result ? ` (${result})` : ""));
  } catch (e) {
    const msg = String(e.message || e);
    if (
      msg.includes("already exists") ||
      msg.includes("duplicate") ||
      msg.includes("already enabled")
    ) {
      console.log("skip (" + msg.split("\n")[0] + ")");
      return;
    }
    console.log("FAIL");
    console.error("    " + msg);
    throw e;
  }
}

console.log("\n=== add-review-status ===");

// 1. Create the enum type (idempotent via IF NOT EXISTS equivalent).
//    Postgres doesn't support CREATE TYPE IF NOT EXISTS for enums, so we
//    wrap it in a DO block.
await step("CREATE TYPE review_status", () =>
  sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'review_status') THEN
        CREATE TYPE review_status AS ENUM ('approved', 'pending', 'rejected');
      END IF;
    END
    $$;
  `),
);

// 2. Add review_status column (default 'approved' so existing rows stay public).
await step("ALTER TABLE skill_versions ADD COLUMN review_status", () =>
  sql(`
    ALTER TABLE skill_versions
    ADD COLUMN IF NOT EXISTS review_status review_status NOT NULL DEFAULT 'approved'
  `),
);

// 3. Add review_notes column (moderator notes, nullable).
await step("ALTER TABLE skill_versions ADD COLUMN review_notes", () =>
  sql(`
    ALTER TABLE skill_versions
    ADD COLUMN IF NOT EXISTS review_notes text
  `),
);

// 4. Partial index to make the moderator review-queue query cheap.
await step("CREATE INDEX skill_versions_review_pending_idx", () =>
  sql(`
    CREATE INDEX IF NOT EXISTS skill_versions_review_pending_idx
    ON skill_versions (published_at DESC)
    WHERE review_status = 'pending'
  `),
);

// 5. Verify
const verify = await sql(`
  SELECT column_name, data_type, column_default
  FROM information_schema.columns
  WHERE table_name = 'skill_versions'
    AND column_name IN ('review_status', 'review_notes')
  ORDER BY column_name
`);
console.log("\nVerification:");
for (const row of verify) {
  console.log(`  ${row.column_name}: ${row.data_type} (default: ${row.column_default ?? "null"})`);
}

console.log("\nMigration complete.");
