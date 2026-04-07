#!/usr/bin/env node
/**
 * One-shot migration: drop the user_stats table that Drizzle created from the
 * schema.ts declaration, and recreate it as a real MATERIALIZED VIEW so the
 * refresh-user-stats cron job (which calls REFRESH MATERIALIZED VIEW
 * CONCURRENTLY) actually works.
 *
 * Idempotent — safe to re-run.
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
    console.log("FAIL");
    console.error("    " + (e.message || e));
    throw e;
  }
}

// 1. Check current state
const before = await sql(`
  SELECT relkind
  FROM pg_class
  WHERE relname = 'user_stats' AND relnamespace = 'public'::regnamespace
`);
const beforeKind = before[0]?.relkind;
console.log(`\nuser_stats relkind before: ${beforeKind ?? "(missing)"}  (r=table, m=matview)`);

if (beforeKind === "m") {
  console.log("Already a materialized view, nothing to do.");
  await step("REFRESH MATERIALIZED VIEW CONCURRENTLY user_stats (sanity)", () =>
    sql("REFRESH MATERIALIZED VIEW CONCURRENTLY user_stats"),
  );
  process.exit(0);
}

// 2. Drop the regular table (cascades to indexes/dependencies)
await step("DROP TABLE user_stats CASCADE", () =>
  sql("DROP TABLE IF EXISTS user_stats CASCADE"),
);

// 3. Recreate as a MATERIALIZED VIEW with the same columns the schema expects
await step("CREATE MATERIALIZED VIEW user_stats", () =>
  sql(`
    CREATE MATERIALIZED VIEW user_stats AS
    SELECT
      u.id AS user_id,
      COUNT(DISTINCT s.id) FILTER (WHERE s.deleted_at IS NULL)::int
          AS total_skills_published,
      COALESCE(SUM(s.install_count), 0)::bigint AS total_installs,
      COALESCE(SUM(s.download_count), 0)::bigint AS total_downloads,
      COALESCE(
        (SELECT COUNT(*) FROM invocations i
         WHERE i.skill_id IN (SELECT id FROM skills WHERE owner_user_id = u.id)),
        0
      )::bigint AS total_invocations_received,
      COALESCE(MAX(s.reputation_score), 0)::numeric(8,4) AS best_skill_score,
      COALESCE(AVG(s.reputation_score), 0)::numeric(8,4) AS avg_skill_score,
      0::numeric(8,4) AS iter_signal_avg,
      0::numeric(8,4) AS contributor_score,
      'unranked'::contributor_tier AS tier,
      MIN(s.created_at) AS first_publish_at,
      MAX(s.updated_at) AS last_publish_at,
      0::numeric(8,4) AS weekly_delta,
      NOW() AS refreshed_at
    FROM users u
    LEFT JOIN skills s ON s.owner_user_id = u.id AND s.deleted_at IS NULL
    GROUP BY u.id
  `),
);

// 4. UNIQUE INDEX is required for REFRESH MATERIALIZED VIEW CONCURRENTLY
await step("CREATE UNIQUE INDEX user_stats_user_id_unq", () =>
  sql("CREATE UNIQUE INDEX user_stats_user_id_unq ON user_stats (user_id)"),
);
await step("CREATE INDEX user_stats_contributor_score_idx", () =>
  sql("CREATE INDEX user_stats_contributor_score_idx ON user_stats (contributor_score DESC)"),
);
await step("CREATE INDEX user_stats_tier_idx", () =>
  sql("CREATE INDEX user_stats_tier_idx ON user_stats (tier)"),
);

// 5. Verify
const after = await sql(`
  SELECT relkind
  FROM pg_class
  WHERE relname = 'user_stats' AND relnamespace = 'public'::regnamespace
`);
console.log(`\nuser_stats relkind after: ${after[0]?.relkind}  (should be 'm')`);

// 6. Sanity-check REFRESH CONCURRENTLY
await step("REFRESH MATERIALIZED VIEW CONCURRENTLY user_stats", () =>
  sql("REFRESH MATERIALIZED VIEW CONCURRENTLY user_stats"),
);

console.log("\nuser_stats matview is ready. The refresh-user-stats cron will now succeed.");
