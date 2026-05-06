#!/usr/bin/env node
/**
 * One-shot migration: create the `claim_nonces` table for T-017.
 *
 * The email-claim flow now issues HMAC-signed tokens of the form
 *   <base64url(payload)>.<base64url(signature)>
 * where payload binds (agent_id, email, nonce, exp). To make each token
 * one-shot (block replay even before it expires), the issuer inserts the
 * nonce here on `POST /v1/agents/me/claim/start`, and the verifier marks
 * it used on `GET /claim/:token`.
 *
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/add-claim-nonces.mjs
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
      msg.includes("duplicate")
    ) {
      console.log("skip (" + msg.split("\n")[0] + ")");
      return;
    }
    console.log("FAIL");
    console.error("    " + msg);
    throw e;
  }
}

console.log("\n=== add-claim-nonces ===");

// 1. Create the table.
await step("CREATE TABLE claim_nonces", () =>
  sql(`
    CREATE TABLE IF NOT EXISTS claim_nonces (
      nonce       text PRIMARY KEY,
      agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      email       text NOT NULL,
      expires_at  timestamptz NOT NULL,
      used_at     timestamptz,
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `),
);

// 2. Index by agent so we can audit/drop a specific agent's pending claims.
await step("CREATE INDEX claim_nonces_agent_idx", () =>
  sql(`
    CREATE INDEX IF NOT EXISTS claim_nonces_agent_idx
    ON claim_nonces (agent_id)
  `),
);

// 3. Index by expires_at so the cleanup cron can prune cheaply.
await step("CREATE INDEX claim_nonces_expires_at_idx", () =>
  sql(`
    CREATE INDEX IF NOT EXISTS claim_nonces_expires_at_idx
    ON claim_nonces (expires_at)
  `),
);

// 4. Verify
const verify = await sql(`
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'claim_nonces'
  ORDER BY ordinal_position
`);
console.log("\nVerification:");
for (const row of verify) {
  console.log(
    `  ${row.column_name}: ${row.data_type}${row.is_nullable === "YES" ? " (nullable)" : ""}`,
  );
}

console.log("\nMigration complete.");
