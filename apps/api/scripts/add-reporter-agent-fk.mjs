#!/usr/bin/env node
/**
 * One-shot migration: add `reporter_agent_id` FK on `moderation_flags`,
 * create a dedupe index, and backfill existing rows from the
 * `admin_notes LIKE 'reporter_agent:<uuid>%'` prefix convention that the
 * Phase 2 MVP used before real user auth existed.
 *
 * After this runs, `apps/api/src/routes/skills.ts` uses the column
 * directly instead of parsing admin_notes.
 *
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node apps/api/scripts/add-reporter-agent-fk.mjs
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

console.log("Adding reporter_agent_id FK on moderation_flags");

await step("add column if not exists", async () => {
  await sql(`
    ALTER TABLE moderation_flags
      ADD COLUMN IF NOT EXISTS reporter_agent_id uuid
      REFERENCES agents(id) ON DELETE SET NULL
  `);
});

await step("create dedupe index if not exists", async () => {
  await sql(`
    CREATE INDEX IF NOT EXISTS moderation_flags_dedupe_idx
      ON moderation_flags (target_type, target_id, reporter_agent_id, reason)
  `);
});

await step("backfill from admin_notes prefix", async () => {
  const r = await sql(`
    UPDATE moderation_flags
       SET reporter_agent_id = (
             substring(admin_notes FROM 'reporter_agent:([0-9a-f-]{36})')
           )::uuid
     WHERE reporter_agent_id IS NULL
       AND admin_notes LIKE 'reporter_agent:%'
    RETURNING id
  `);
  return `${r.length} rows backfilled`;
});

await step("verify — count rows still missing FK", async () => {
  const r = await sql(`
    SELECT COUNT(*)::int AS n
      FROM moderation_flags
     WHERE reporter_agent_id IS NULL
       AND admin_notes LIKE 'reporter_agent:%'
  `);
  const n = Number(r[0]?.n ?? 0);
  if (n > 0) throw new Error(`${n} rows still unbackfilled`);
  return `${n} unbackfilled`;
});

console.log("\nDone.");
