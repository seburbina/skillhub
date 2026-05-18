/**
 * Unit tests for the T-034 hourly data-retention job.
 *
 * The job runs raw `DELETE … RETURNING 1` against a handful of event
 * tables and writes a single summary `audit_events` row at the end. We
 * mock the Drizzle client (`makeDb`) so the tests stay pure-node and
 * don't need a Postgres harness.
 *
 * Mock surface:
 *   - `db.execute(sql)`   → simulates a DELETE, returns `{ rows: [...] }`
 *                           whose length is the deletion count
 *   - `db.insert(table).values(row)` → records the inserted audit row
 *
 * The job is called via the real `enforceDataRetention(env)` entrypoint,
 * not by poking at private helpers, so the assertions stay close to the
 * real schedule wiring.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Bindings } from "@/types";

// Mock makeDb BEFORE importing the job module so the job picks up the stub.
// Each test re-installs handlers via the module-scoped `dbState` below.
vi.mock("@/db", () => {
  return {
    makeDb: vi.fn(() => fakeDb),
  };
});

// ---------------------------------------------------------------------------
// Fake Drizzle DB
// ---------------------------------------------------------------------------

type ExecuteHandler = (sqlText: string) => { rows: unknown[] };

interface DbState {
  executes: Array<{ sqlText: string; result: { rows: unknown[] } }>;
  inserts: Array<{ table: unknown; values: unknown }>;
  executeHandler: ExecuteHandler;
  insertShouldThrow: boolean;
}

const dbState: DbState = {
  executes: [],
  inserts: [],
  executeHandler: () => ({ rows: [] }),
  insertShouldThrow: false,
};

const fakeDb = {
  execute: vi.fn(async (sqlObj: { queryChunks?: unknown[]; sql?: string }) => {
    // Drizzle sql`` tags carry an interpolation tree. We don't need the
    // exact text — only enough to identify which table the rule targets.
    // Stringifying the chunks gives us a stable, table-name-bearing
    // representation regardless of drizzle's internal format.
    const sqlText = stringifySql(sqlObj);
    const result = dbState.executeHandler(sqlText);
    dbState.executes.push({ sqlText, result });
    return result;
  }),

  insert: vi.fn((table: unknown) => ({
    values: vi.fn(async (row: unknown) => {
      if (dbState.insertShouldThrow) {
        throw new Error("insert failed (simulated)");
      }
      dbState.inserts.push({ table, values: row });
      return undefined;
    }),
  })),
} as const;

/** Stringify the drizzle sql tagged-template object for table-name detection. */
function stringifySql(obj: unknown): string {
  try {
    return JSON.stringify(obj, (_k, v) => {
      if (typeof v === "function") return undefined;
      if (typeof v === "bigint") return v.toString();
      return v;
    });
  } catch {
    return String(obj);
  }
}

/** Find the table name embedded in the DELETE we just ran. */
function tableForExecute(sqlText: string): string | null {
  // The first matched table name is the one being DELETE-d from.
  const candidates = [
    "audit_events",
    "invocations",
    "scrub_reports",
    "moderation_flags",
    "claim_nonces",
    "rate_limit_buckets",
  ];
  for (const t of candidates) {
    if (sqlText.includes(`DELETE FROM ${t}`)) return t;
  }
  return null;
}

function resetDbState(): void {
  dbState.executes = [];
  dbState.inserts = [];
  dbState.executeHandler = () => ({ rows: [] });
  dbState.insertShouldThrow = false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubEnv = (overrides: Partial<Bindings> = {}): Bindings =>
  ({
    DATABASE_URL: "postgres://stub",
    API_KEY_HASH_SECRET: "stub",
    APP_URL: "http://test",
    AGENT_KEY_PREFIX: "skh_test_",
    VOYAGE_MODEL: "voyage-3",
    ENVIRONMENT: "test",
    SIGNED_URL_TTL: "300",
    ASSETS: undefined as unknown,
    SKILLS_BUCKET: undefined as unknown,
    AI: undefined as unknown,
    ...overrides,
  }) as unknown as Bindings;

function rowsOfCount(n: number): { rows: unknown[] } {
  return { rows: Array.from({ length: n }, () => ({ "?column?": 1 })) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enforceDataRetention", () => {
  beforeEach(() => {
    resetDbState();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("deletes past-retention rows from every table and reports the counts", async () => {
    const { enforceDataRetention } = await import("@/jobs/data-retention");

    // Simulate each table having a handful of expired rows.
    const counts: Record<string, number> = {
      audit_events: 7,
      invocations: 12,
      scrub_reports: 3,
      moderation_flags: 5,
      claim_nonces: 2,
      rate_limit_buckets: 9,
    };
    dbState.executeHandler = (sqlText) => {
      const t = tableForExecute(sqlText);
      if (t && counts[t] !== undefined) return rowsOfCount(counts[t]);
      return { rows: [] };
    };

    const result = await enforceDataRetention(stubEnv());

    expect(result.deleted).toEqual(counts);
    // One DELETE per table (6 rules in the job).
    expect(dbState.executes).toHaveLength(6);
  });

  it("does NOT touch within-retention rows (zero-row DELETE result)", async () => {
    const { enforceDataRetention } = await import("@/jobs/data-retention");

    // executeHandler default returns { rows: [] } → nothing deleted.
    const result = await enforceDataRetention(stubEnv());

    for (const t of [
      "audit_events",
      "invocations",
      "scrub_reports",
      "moderation_flags",
      "claim_nonces",
      "rate_limit_buckets",
    ]) {
      expect(result.deleted[t]).toBe(0);
    }
  });

  it("respects the per-table LIMIT cap and logs a warning when it's hit", async () => {
    const { enforceDataRetention, MAX_DELETE_PER_TABLE } = await import(
      "@/jobs/data-retention"
    );
    const warnSpy = vi.spyOn(console, "warn");

    // Simulate audit_events hitting the cap. (10_000 rows is the cap;
    // the DB itself enforces the LIMIT clause in the SQL, so the mock
    // returns exactly MAX_DELETE_PER_TABLE.)
    dbState.executeHandler = (sqlText) => {
      if (tableForExecute(sqlText) === "audit_events") {
        return rowsOfCount(MAX_DELETE_PER_TABLE);
      }
      return { rows: [] };
    };

    const result = await enforceDataRetention(stubEnv());

    expect(result.deleted.audit_events).toBe(MAX_DELETE_PER_TABLE);

    // A warn-level structured log line mentions cap_hit + the table.
    const warnLines = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      warnLines.some(
        (l) => l.includes("retention.cap_hit") && l.includes("audit_events"),
      ),
    ).toBe(true);
  });

  it("writes one summary audit_events row with the per-table counts", async () => {
    const { enforceDataRetention } = await import("@/jobs/data-retention");

    dbState.executeHandler = (sqlText) => {
      const t = tableForExecute(sqlText);
      if (t === "invocations") return rowsOfCount(4);
      if (t === "scrub_reports") return rowsOfCount(1);
      return { rows: [] };
    };

    await enforceDataRetention(stubEnv());

    expect(dbState.inserts).toHaveLength(1);
    const evt = dbState.inserts[0].values as {
      actorType: string;
      action: string;
      metadata: { deleted: Record<string, number> };
    };
    expect(evt.actorType).toBe("system");
    expect(evt.action).toBe("retention.purge");
    expect(evt.metadata.deleted.invocations).toBe(4);
    expect(evt.metadata.deleted.scrub_reports).toBe(1);
    expect(evt.metadata.deleted.audit_events).toBe(0);
  });

  it("is a no-op (but still audits) when every table is empty", async () => {
    const { enforceDataRetention } = await import("@/jobs/data-retention");
    // Default executeHandler returns empty rows for everything.

    const result = await enforceDataRetention(stubEnv());

    expect(Object.values(result.deleted).every((n) => n === 0)).toBe(true);
    // Summary audit row still written so we have a heartbeat per run.
    expect(dbState.inserts).toHaveLength(1);
  });

  it("logs + continues when one table's DELETE throws (schema drift)", async () => {
    const { enforceDataRetention } = await import("@/jobs/data-retention");
    const errSpy = vi.spyOn(console, "error");

    // Simulate scrub_reports missing — typical "schema drift" failure.
    dbState.executeHandler = (sqlText) => {
      const t = tableForExecute(sqlText);
      if (t === "scrub_reports") {
        throw new Error('relation "scrub_reports" does not exist');
      }
      if (t === "invocations") return rowsOfCount(2);
      return { rows: [] };
    };

    const result = await enforceDataRetention(stubEnv());

    // scrub_reports failed → 0 reported (not undefined / not crashing).
    expect(result.deleted.scrub_reports).toBe(0);
    // Other tables still ran.
    expect(result.deleted.invocations).toBe(2);
    // We logged the failure.
    const errLines = errSpy.mock.calls.map((c) => String(c[0]));
    expect(
      errLines.some(
        (l) =>
          l.includes("retention.rule_failed") && l.includes("scrub_reports"),
      ),
    ).toBe(true);
  });

  it("honors AUDIT_RETENTION_OVERRIDE_DAYS when greater than the default", async () => {
    const { resolveAuditRetentionDays, DEFAULT_RETENTION_DAYS } = await import(
      "@/jobs/data-retention"
    );

    const env = stubEnv({
      AUDIT_RETENTION_OVERRIDE_DAYS: "2555", // ~7 years
    } as Partial<Bindings>);

    expect(resolveAuditRetentionDays(env)).toBe(2555);
    expect(2555).toBeGreaterThan(DEFAULT_RETENTION_DAYS.audit_events);
  });

  it("falls back to the default when AUDIT_RETENTION_OVERRIDE_DAYS is smaller", async () => {
    const { resolveAuditRetentionDays, DEFAULT_RETENTION_DAYS } = await import(
      "@/jobs/data-retention"
    );

    // Operator typo / accidental shrink — must NOT erase audit history.
    const env = stubEnv({
      AUDIT_RETENTION_OVERRIDE_DAYS: "30",
    } as Partial<Bindings>);

    expect(resolveAuditRetentionDays(env)).toBe(
      DEFAULT_RETENTION_DAYS.audit_events,
    );
  });

  it("falls back to default for malformed AUDIT_RETENTION_OVERRIDE_DAYS", async () => {
    const { resolveAuditRetentionDays, DEFAULT_RETENTION_DAYS } = await import(
      "@/jobs/data-retention"
    );

    for (const bad of ["", "abc", "-7", "0"]) {
      const env = stubEnv({
        AUDIT_RETENTION_OVERRIDE_DAYS: bad,
      } as Partial<Bindings>);
      expect(resolveAuditRetentionDays(env)).toBe(
        DEFAULT_RETENTION_DAYS.audit_events,
      );
    }
  });

  it("is idempotent — a second run after the first deletes nothing new", async () => {
    const { enforceDataRetention } = await import("@/jobs/data-retention");

    // First run: simulate a populated batch.
    let firstRunDone = false;
    dbState.executeHandler = (sqlText) => {
      const t = tableForExecute(sqlText);
      if (!firstRunDone && t === "audit_events") return rowsOfCount(5);
      if (!firstRunDone && t === "invocations") return rowsOfCount(11);
      // Anything not matched in the first run, or anything in the second
      // run, returns no aged-out rows — exactly the "drained" state.
      return { rows: [] };
    };

    const first = await enforceDataRetention(stubEnv());
    expect(first.deleted.audit_events).toBe(5);
    expect(first.deleted.invocations).toBe(11);

    // Now the tables are drained; second run should be a no-op.
    firstRunDone = true;
    const second = await enforceDataRetention(stubEnv());
    expect(second.deleted.audit_events).toBe(0);
    expect(second.deleted.invocations).toBe(0);

    // The function never crashed and produced a stable shape between runs.
    expect(Object.keys(second.deleted).sort()).toEqual(
      Object.keys(first.deleted).sort(),
    );
  });
});
