#!/usr/bin/env node
/**
 * ClawHavoc hardening §5 — add the GitHub-linking columns to `agents`.
 *
 * `apps/api/src/db/schema.ts` has carried `githubHandle`, `githubId`, and
 * `githubLinkedAt` on the agents table for a while, and `routes/link-github.ts`
 * writes to them. The columns were never added to prod, so every authenticated
 * request that goes through `requireAgent` (which does `SELECT *` on agents)
 * fails with `column "github_handle" does not exist`. That includes
 * `/v1/skills/:id/versions/:semver/download`, breaking install end-to-end.
 *
 * All three columns are nullable and unindexed in the schema — purely
 * additive, no row rewrite. Idempotent — safe to re-run.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node apps/api/scripts/add-github-link-columns.mjs
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

console.log("ClawHavoc §5 — add github linking columns to agents");

await step("agents.github_handle: add column if not exists", async () => {
  await sql(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS github_handle text`);
});

await step("agents.github_id: add column if not exists", async () => {
  await sql(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS github_id bigint`);
});

await step("agents.github_linked_at: add column if not exists", async () => {
  await sql(
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS github_linked_at timestamptz`,
  );
});

await step("verify — columns are present and all rows are NULL", async () => {
  const r = await sql(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(github_handle)::int AS handle_set,
      COUNT(github_id)::int AS id_set,
      COUNT(github_linked_at)::int AS linked_set
    FROM agents
  `);
  const row = r[0] ?? {};
  return `${row.total} agents · handle_set=${row.handle_set} · id_set=${row.id_set} · linked_set=${row.linked_set}`;
});

console.log("\nDone.");
