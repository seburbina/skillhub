/**
 * Hourly data-retention enforcement (T-034).
 *
 * `docs/data-retention.md` declares retention windows for the event-style
 * tables (`audit_events`, `invocations`, `scrub_reports`, `moderation_flags`,
 * `claim_nonces`, `rate_limit_buckets`). Nothing was enforcing them — rows
 * lived forever. This job DELETEs aged-out rows on the same cron tick as
 * `refresh-user-stats` (`37 * * * *`).
 *
 * Why piggyback instead of a 4th cron:
 *   Cloudflare Free plan caps the worker at 3 cron triggers and we're
 *   already using all three (`recompute-rankings`, `refresh-user-stats`,
 *   `mirror-to-github`). T-014 set the precedent — extra work runs inside
 *   an existing cron's handler.
 *
 * Per-table behaviour:
 *   - Each rule DELETEs rows where the chosen timestamp column is older
 *     than `now() - INTERVAL '<n> days'`, capped at LIMIT 10_000 per run
 *     so a backlog can't blow the Worker's 30s CPU budget. If 10_000 rows
 *     came back the next cron tick handles the rest; a warning is logged.
 *   - `RETURNING 1` gives us a count without pulling the row data over
 *     the wire — Drizzle/Neon HTTP returns the row count via `rowCount`
 *     but we use the `result.rows.length` to be portable.
 *   - A missing table (schema drift) is caught + logged + skipped so a
 *     bad migration doesn't take down the whole purge.
 *
 * Auditability:
 *   One summary `audit_events` row per run, `action: "retention.purge"`,
 *   `metadata: {deleted: {<table>: <n>, …}}`. The audit row itself is
 *   subject to the same retention as the other audit_events.
 *
 * Override:
 *   `env.AUDIT_RETENTION_OVERRIDE_DAYS` (string, parses as integer) lets
 *   operators extend the audit_events window for compliance reasons. The
 *   value is only honored when it is greater than the default 365 — a
 *   smaller value falls back to the default so an accidental "30" can't
 *   wipe a year of audit history.
 */
import { sql } from "drizzle-orm";
import { makeDb, type Db } from "@/db";
import { auditEvents } from "@/db/schema";
import { logError, logEvent } from "@/lib/log";
import type { Bindings } from "@/types";

/** Per-run cap so a backlog can't exhaust the Worker's CPU budget. */
export const MAX_DELETE_PER_TABLE = 10_000;

/** Defaults. Operators override audit via env.AUDIT_RETENTION_OVERRIDE_DAYS. */
export const DEFAULT_RETENTION_DAYS = {
  audit_events: 365,
  invocations: 90,
  scrub_reports: 180,
  moderation_flags: 365,
  /** `claim_nonces` are filtered by `expires_at`, not `created_at`. */
  claim_nonces_past_expiry: 7,
  /** `rate_limit_buckets` rows are filtered by `window_start`. */
  rate_limit_buckets: 7,
} as const;

interface RetentionRule {
  table: string;
  /** Raw SQL DELETE — `LIMIT` and a `RETURNING` constant column included. */
  buildSql: () => ReturnType<typeof sql>;
}

export interface DataRetentionResult {
  deleted: Record<string, number>;
}

/**
 * Resolve the effective audit_events retention window. Honors
 * `AUDIT_RETENTION_OVERRIDE_DAYS` when set AND strictly greater than the
 * default — a smaller override falls back to the default so an operator
 * misconfiguration can't accidentally shrink retention.
 */
export function resolveAuditRetentionDays(env: Bindings): number {
  const raw = (env as { AUDIT_RETENTION_OVERRIDE_DAYS?: string })
    .AUDIT_RETENTION_OVERRIDE_DAYS;
  if (!raw) return DEFAULT_RETENTION_DAYS.audit_events;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_RETENTION_DAYS.audit_events;
  }
  return Math.max(parsed, DEFAULT_RETENTION_DAYS.audit_events);
}

function buildRules(env: Bindings): RetentionRule[] {
  const auditDays = resolveAuditRetentionDays(env);
  const cap = MAX_DELETE_PER_TABLE;
  return [
    {
      table: "audit_events",
      buildSql: () => sql`
        DELETE FROM audit_events
        WHERE id IN (
          SELECT id FROM audit_events
          WHERE created_at < NOW() - (${auditDays} || ' days')::interval
          LIMIT ${cap}
        )
        RETURNING 1
      `,
    },
    {
      table: "invocations",
      buildSql: () => sql`
        DELETE FROM invocations
        WHERE id IN (
          SELECT id FROM invocations
          WHERE created_at < NOW() - (${DEFAULT_RETENTION_DAYS.invocations} || ' days')::interval
          LIMIT ${cap}
        )
        RETURNING 1
      `,
    },
    {
      table: "scrub_reports",
      buildSql: () => sql`
        DELETE FROM scrub_reports
        WHERE id IN (
          SELECT id FROM scrub_reports
          WHERE created_at < NOW() - (${DEFAULT_RETENTION_DAYS.scrub_reports} || ' days')::interval
          LIMIT ${cap}
        )
        RETURNING 1
      `,
    },
    {
      table: "moderation_flags",
      buildSql: () => sql`
        DELETE FROM moderation_flags
        WHERE id IN (
          SELECT id FROM moderation_flags
          WHERE created_at < NOW() - (${DEFAULT_RETENTION_DAYS.moderation_flags} || ' days')::interval
          LIMIT ${cap}
        )
        RETURNING 1
      `,
    },
    {
      table: "claim_nonces",
      buildSql: () => sql`
        DELETE FROM claim_nonces
        WHERE nonce IN (
          SELECT nonce FROM claim_nonces
          WHERE expires_at < NOW() - (${DEFAULT_RETENTION_DAYS.claim_nonces_past_expiry} || ' days')::interval
          LIMIT ${cap}
        )
        RETURNING 1
      `,
    },
    {
      table: "rate_limit_buckets",
      buildSql: () => sql`
        DELETE FROM rate_limit_buckets
        WHERE (key, window_start) IN (
          SELECT key, window_start FROM rate_limit_buckets
          WHERE window_start < NOW() - (${DEFAULT_RETENTION_DAYS.rate_limit_buckets} || ' days')::interval
          LIMIT ${cap}
        )
        RETURNING 1
      `,
    },
  ];
}

/**
 * Run one pass of retention enforcement. Safe to call concurrently —
 * Postgres serializes the DELETEs, and the LIMIT + subselect-by-id
 * pattern means two parallel runs at worst each delete a different
 * 10_000-row slice.
 */
export async function enforceDataRetention(
  env: Bindings,
): Promise<DataRetentionResult> {
  const db = makeDb(env);
  const deleted: Record<string, number> = {};
  const rules = buildRules(env);

  for (const rule of rules) {
    try {
      const count = await runRule(db, rule);
      deleted[rule.table] = count;
      if (count >= MAX_DELETE_PER_TABLE) {
        logEvent("warn", "retention.cap_hit", {
          table: rule.table,
          deleted: count,
          cap: MAX_DELETE_PER_TABLE,
        });
      }
    } catch (err) {
      // Schema drift (missing table/column) or transient DB error — log
      // and continue so one bad rule doesn't stop the rest of the purge.
      logError("retention.rule_failed", err, { table: rule.table });
      deleted[rule.table] = 0;
    }
  }

  await writeSummaryAudit(db, deleted);
  logEvent("info", "retention.run_complete", { deleted });

  return { deleted };
}

async function runRule(db: Db, rule: RetentionRule): Promise<number> {
  // Drizzle's `db.execute` returns the underlying neon-http result whose
  // `.rows` is the array of `RETURNING` rows. Length == deletion count.
  const result = await db.execute<{ "?column?": number }>(rule.buildSql());
  return result.rows.length;
}

async function writeSummaryAudit(
  db: Db,
  deleted: Record<string, number>,
): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      actorType: "system",
      action: "retention.purge",
      metadata: { deleted },
    });
  } catch (err) {
    // If audit_events itself is the missing table, the per-rule loop
    // already logged it. Swallow here so a half-broken schema doesn't
    // propagate into the scheduled-job error path.
    logError("retention.summary_audit_failed", err);
  }
}
