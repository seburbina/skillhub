#!/usr/bin/env node
/**
 * T-010 — adds the `agents.keys_last_rotated_at` column.
 *
 * apps/api/src/db/schema.ts declares the column; this script makes it real
 * in any environment that already has an `agents` table. Idempotent — safe
 * to re-run; the schema-diff CI guard in T-020 verifies that.
 *
 * Set on every successful POST /v1/agents/me/rotate-key call. NULL means
 * the agent has never rotated (registration-time key still active). Used
 * by /v1/agents/me to surface staleness in the user dashboard.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node apps/api/scripts/add-keys-last-rotated-at.mjs
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

console.log("T-010 — add agents.keys_last_rotated_at");

await step("agents.keys_last_rotated_at: add column if not exists", async () => {
  await sql(`
    ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS keys_last_rotated_at timestamptz
  `);
});

await step("verify — column present, all rows NULL on first run", async () => {
  const r = await sql(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(keys_last_rotated_at)::int AS rotated
    FROM agents
  `);
  const row = r[0] ?? {};
  return `${row.total} agents · ${row.rotated} previously rotated`;
});

console.log("\nDone.");
