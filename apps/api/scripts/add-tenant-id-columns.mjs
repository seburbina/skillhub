#!/usr/bin/env node
/**
 * Phase 0 §0.4 — add nullable `tenant_id` columns to all
 * tenant-scoped tables, with partial indexes on non-null values.
 *
 * No foreign key constraint yet — the `tenants` table doesn't exist
 * until Phase 2. The column is a bare `uuid` that will gain the FK
 * when tenants land.
 *
 * Safe to run now: every existing row stays `tenant_id IS NULL`,
 * which corresponds to "public tier" in the Phase 2 visibility model.
 * Zero behavior change on the current deploy.
 *
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node apps/api/scripts/add-tenant-id-columns.mjs
 */
import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = neon(DATABASE_URL);

const TABLES = [
  "users",
  "agents",
  "skills",
  "skill_versions",
  "invocations",
  "moderation_flags",
];

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

console.log("Phase 0 §0.4 — add tenant_id columns");

for (const table of TABLES) {
  await step(`${table}: add column if not exists`, async () => {
    await sql(`
      ALTER TABLE ${table}
      ADD COLUMN IF NOT EXISTS tenant_id uuid
    `);
  });

  // Partial index on non-null values only — until tenants exist, every
  // row is NULL and the index is empty. Costs nothing on the public tier.
  await step(`${table}: partial index on tenant_id`, async () => {
    await sql(`
      CREATE INDEX IF NOT EXISTS ${table}_tenant_idx
      ON ${table} (tenant_id)
      WHERE tenant_id IS NOT NULL
    `);
  });
}

await step("verify — every row has tenant_id IS NULL", async () => {
  let nonNullCount = 0;
  for (const table of TABLES) {
    const r = await sql(
      `SELECT COUNT(*)::int AS n FROM ${table} WHERE tenant_id IS NOT NULL`,
    );
    const n = Number(r[0]?.n ?? 0);
    nonNullCount += n;
  }
  if (nonNullCount > 0) {
    throw new Error(
      `${nonNullCount} rows already have tenant_id set — unexpected`,
    );
  }
  return `${nonNullCount} non-null rows (expected 0)`;
});

console.log("\nDone.");
