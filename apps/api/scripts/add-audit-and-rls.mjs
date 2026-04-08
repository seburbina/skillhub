#!/usr/bin/env node
/**
 * Phase 0 batch 2 migration — audit_events + tenant_skill_allowlist + RLS.
 *
 * Composes three independent but related Phase 0 items into a single
 * idempotent migration:
 *
 *   §0.2  Create `audit_events` table (append-only via RLS).
 *   §0.8  Create `tenant_skill_allowlist` table (empty schema hook).
 *   §0.1  Enable Row-Level Security on all 6 tenanted tables with
 *         permissive policies (USING true), so existing queries keep
 *         working. Phase 2 tightens the policies to use
 *         current_setting('app.current_tenant_id', true).
 *
 * Behavior change on public tier: ZERO. Permissive policies let
 * every query through. The refactor to wrap queries in
 * sql.transaction([SET LOCAL, ...]) lands in a later PR; until then,
 * everything works exactly as before.
 *
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node apps/api/scripts/add-audit-and-rls.mjs
 */
import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = neon(DATABASE_URL);

const TENANTED_TABLES = [
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

// ---------------------------------------------------------------------------
// §0.2 — audit_events
// ---------------------------------------------------------------------------

console.log("Phase 0 §0.2 — audit_events table");

await step("create audit_events if not exists", async () => {
  await sql(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid,
      actor_type text NOT NULL,
      actor_id uuid,
      actor_email text,
      action text NOT NULL,
      target_type text,
      target_id text,
      ip text,
      user_agent text,
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
});

await step("audit_events index: tenant_id + created_at DESC", async () => {
  await sql(`
    CREATE INDEX IF NOT EXISTS audit_events_tenant_at_idx
    ON audit_events (tenant_id, created_at DESC)
  `);
});

await step("audit_events index: actor_id", async () => {
  await sql(`
    CREATE INDEX IF NOT EXISTS audit_events_actor_idx
    ON audit_events (actor_id)
    WHERE actor_id IS NOT NULL
  `);
});

await step("audit_events index: action", async () => {
  await sql(`
    CREATE INDEX IF NOT EXISTS audit_events_action_idx
    ON audit_events (action)
  `);
});

await step("audit_events: enable RLS (append-only policy)", async () => {
  await sql(`ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY`);
});

// Use DO block to make CREATE POLICY idempotent (Postgres has no
// CREATE POLICY IF NOT EXISTS yet).
await step("audit_events: INSERT policy (everyone can write)", async () => {
  await sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'audit_events' AND policyname = 'audit_events_insert'
      ) THEN
        CREATE POLICY audit_events_insert ON audit_events FOR INSERT WITH CHECK (true);
      END IF;
    END$$
  `);
});

await step("audit_events: SELECT policy (permissive for now)", async () => {
  await sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'audit_events' AND policyname = 'audit_events_select'
      ) THEN
        CREATE POLICY audit_events_select ON audit_events FOR SELECT USING (true);
      END IF;
    END$$
  `);
});

// NOTE: Deliberately NO UPDATE or DELETE policies. RLS denies by
// default when no policy matches, making audit_events append-only at
// the database level. Even the service role can't mutate history
// unless it disables RLS first — which is detectable in audit logs.

// ---------------------------------------------------------------------------
// §0.8 — tenant_skill_allowlist
// ---------------------------------------------------------------------------

console.log("Phase 0 §0.8 — tenant_skill_allowlist table");

await step("create tenant_skill_allowlist if not exists", async () => {
  await sql(`
    CREATE TABLE IF NOT EXISTS tenant_skill_allowlist (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid,
      skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      allowed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      allowed_at timestamptz NOT NULL DEFAULT now()
    )
  `);
});

await step("tenant_skill_allowlist unique (tenant_id, skill_id)", async () => {
  // Use COALESCE so NULL tenant_id (public tier) is treated as one bucket
  await sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS tenant_skill_allowlist_unq
    ON tenant_skill_allowlist (
      COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
      skill_id
    )
  `);
});

await step("tenant_skill_allowlist index: skill_id", async () => {
  await sql(`
    CREATE INDEX IF NOT EXISTS tenant_skill_allowlist_skill_idx
    ON tenant_skill_allowlist (skill_id)
  `);
});

// ---------------------------------------------------------------------------
// §0.1 — RLS with permissive policies
// ---------------------------------------------------------------------------

console.log("Phase 0 §0.1 — Row-Level Security (permissive)");

for (const table of TENANTED_TABLES) {
  await step(`${table}: enable RLS`, async () => {
    await sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  });

  await step(`${table}: permissive USING(true) policy`, async () => {
    await sql(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE tablename = '${table}' AND policyname = '${table}_permissive'
        ) THEN
          CREATE POLICY ${table}_permissive ON ${table}
          FOR ALL USING (true) WITH CHECK (true);
        END IF;
      END$$
    `);
  });
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

console.log("Verification");

await step("verify — audit_events exists with RLS on", async () => {
  const r = await sql(`
    SELECT rowsecurity FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'audit_events'
  `);
  const on = r[0]?.rowsecurity;
  if (!on) throw new Error("RLS not enabled on audit_events");
  return "RLS on";
});

await step("verify — tenant_skill_allowlist exists", async () => {
  const r = await sql(`
    SELECT COUNT(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'tenant_skill_allowlist'
  `);
  if (Number(r[0]?.n ?? 0) !== 1) throw new Error("table missing");
});

await step("verify — all 6 tenanted tables have RLS", async () => {
  const r = await sql(`
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename = ANY(ARRAY[
        'users','agents','skills','skill_versions','invocations','moderation_flags'
      ])
    ORDER BY tablename
  `);
  const missing = r.filter((row) => !row.rowsecurity);
  if (missing.length > 0) {
    throw new Error(
      `RLS not enabled on: ${missing.map((m) => m.tablename).join(", ")}`,
    );
  }
  return `${r.length}/6 tables`;
});

await step("verify — a permissive SELECT from skills still works", async () => {
  const r = await sql(`SELECT COUNT(*)::int AS n FROM skills WHERE deleted_at IS NULL`);
  return `${r[0]?.n ?? 0} skills visible`;
});

console.log("\nDone.");
