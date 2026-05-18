/**
 * Unit tests for the T-014 yanked-R2 cleanup job.
 *
 * The job orchestrates: read eligible rows -> mirror to GitHub -> delete
 * from R2 -> stamp r2_deleted_at -> write audit. We test the per-version
 * processor (`processYankedVersion`) in isolation with mocked R2 + DB
 * because the Drizzle "find eligible" query against a real PG is
 * integration-test territory.
 *
 * We also exercise the top-level `cleanupYankedR2` for the no-op cases
 * (no token / no candidates) by mocking the `@/db` and `fetch` modules.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  cleanupYankedR2,
  processYankedVersion,
  type YankedCandidate,
} from "@/jobs/r2-cleanup-yanked";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface UpdateCall {
  set: Record<string, unknown>;
  whereCalled: boolean;
}
interface InsertCall {
  values: Record<string, unknown>;
}
interface StubDb {
  __updates: UpdateCall[];
  __inserts: InsertCall[];
  update: (table: unknown) => {
    set: (vals: Record<string, unknown>) => { where: (clause: unknown) => Promise<void> };
  };
  insert: (table: unknown) => {
    values: (vals: Record<string, unknown>) => Promise<void>;
  };
  // findEligibleYankedVersions uses .select().from()...etc — these tests
  // exercise processYankedVersion directly so we never need to mock the
  // chain. Throwing here is a loud failure if the wiring ever changes.
  select: () => unknown;
}

function makeStubDb(): StubDb {
  const stub: StubDb = {
    __updates: [],
    __inserts: [],
    update: (_table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: async (_clause: unknown) => {
          stub.__updates.push({ set: vals, whereCalled: true });
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: async (vals: Record<string, unknown>) => {
        stub.__inserts.push({ values: vals });
      },
    }),
    select: () => {
      throw new Error(
        "select() called on stub DB — tests should use processYankedVersion directly",
      );
    },
  };
  return stub;
}

function makeR2Object(bytes: Uint8Array): R2ObjectBody {
  return {
    arrayBuffer: async () => bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  } as unknown as R2ObjectBody;
}

function makeBindings(opts: {
  r2Object?: R2ObjectBody | null;
  fetch?: typeof fetch;
}): {
  env: Parameters<typeof processYankedVersion>[0];
  getCalls: string[];
  deleteCalls: string[];
  fetchCalls: { url: string; init?: RequestInit }[];
} {
  const getCalls: string[] = [];
  const deleteCalls: string[] = [];
  const fetchCalls: { url: string; init?: RequestInit }[] = [];

  const env = {
    SKILLS_BUCKET: {
      get: async (key: string) => {
        getCalls.push(key);
        return opts.r2Object ?? null;
      },
      delete: async (key: string) => {
        deleteCalls.push(key);
      },
    },
    GITHUB_MIRROR_TOKEN: "fake-token-only-for-tests",
    // The rest of Bindings is unused by the cleanup path.
    ASSETS: undefined as unknown,
    AI: undefined as unknown,
    APP_URL: "http://test",
    AGENT_KEY_PREFIX: "skh_test_",
    VOYAGE_MODEL: "voyage-3",
    ENVIRONMENT: "test",
    SIGNED_URL_TTL: "300",
    DATABASE_URL: "postgres://stub",
    API_KEY_HASH_SECRET: "stub",
  } as unknown as Parameters<typeof processYankedVersion>[0];

  // Override global fetch — every call inside the cleanup hits GitHub.
  const fetchMock = opts.fetch ?? (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({ commit: { sha: "abc123" } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  return { env, getCalls, deleteCalls, fetchCalls };
}

function makeCandidate(overrides: Partial<YankedCandidate> = {}): YankedCandidate {
  return {
    versionId: "11111111-1111-1111-1111-111111111111",
    semver: "1.2.3",
    r2Key: "skills/my-skill/v1.2.3.skill",
    slug: "my-skill",
    yankedAt: new Date("2026-05-15T00:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cleanupYankedR2 — top level", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("no-ops when GITHUB_MIRROR_TOKEN is unset (won't delete without an audit copy)", async () => {
    // Important: no DATABASE_URL either — we should bail out BEFORE
    // building the DB client. If the function tried to connect this would
    // throw on Neon's URL parse.
    const env = {
      GITHUB_MIRROR_TOKEN: undefined,
    } as unknown as Parameters<typeof cleanupYankedR2>[0];

    const result = await cleanupYankedR2(env);
    expect(result).toEqual({
      processed: 0,
      r2Deleted: 0,
      mirrored: 0,
      mirrorFailures: 0,
      r2Missing: 0,
      errors: 0,
    });
  });
});

describe("processYankedVersion — per-version processor", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("happy path: mirrors then deletes R2 then stamps DB then writes audit", async () => {
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03]); // PK header + a few bytes
    const r2Obj = makeR2Object(zipBytes);
    const { env, deleteCalls, fetchCalls } = makeBindings({ r2Object: r2Obj });
    const db = makeStubDb();

    const outcome = await processYankedVersion(env, db as never, makeCandidate());

    expect(outcome.mirrored).toBe(true);
    expect(outcome.mirrorFailed).toBe(false);
    expect(outcome.r2WasMissing).toBe(false);

    // Two GitHub PUTs: skill.zip + tombstone.json
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0].url).toContain("/repos/seburbina/skillhub-skills/contents/");
    expect(fetchCalls[0].url).toContain("yanked/my-skill/v1.2.3/skill.zip");
    expect(fetchCalls[1].url).toContain("yanked/my-skill/v1.2.3/tombstone.json");

    // R2 delete fired once with the right key
    expect(deleteCalls).toEqual(["skills/my-skill/v1.2.3.skill"]);

    // DB stamped r2_deleted_at
    expect(db.__updates).toHaveLength(1);
    expect(db.__updates[0].set).toHaveProperty("r2DeletedAt");
    expect(db.__updates[0].set.r2DeletedAt).toBeInstanceOf(Date);

    // Audit row written with the right action
    expect(db.__inserts).toHaveLength(1);
    const audit = db.__inserts[0].values;
    expect(audit.actorType).toBe("system");
    expect(audit.action).toBe("skill.r2_deleted_after_yank");
    expect(audit.targetType).toBe("skill_version");
    expect(audit.targetId).toBe("11111111-1111-1111-1111-111111111111");
    expect(audit.metadata).toMatchObject({
      slug: "my-skill",
      semver: "1.2.3",
      mirrored: true,
      mirror_failed: false,
      r2_was_missing: false,
    });
  });

  it("mirror fires BEFORE R2 delete (so the archive isn't lost on partial failure)", async () => {
    const zipBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const r2Obj = makeR2Object(zipBytes);

    const callOrder: string[] = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      callOrder.push(`fetch:${String(url).split("/contents/")[1]?.split("?")[0]}`);
      return new Response(JSON.stringify({ commit: { sha: "abc" } }), { status: 201 });
    };
    const env = {
      SKILLS_BUCKET: {
        get: async (_key: string) => r2Obj,
        delete: async (_key: string) => {
          callOrder.push("r2:delete");
        },
      },
      GITHUB_MIRROR_TOKEN: "fake",
      DATABASE_URL: "postgres://stub",
    } as unknown as Parameters<typeof processYankedVersion>[0];
    vi.stubGlobal("fetch", fetchMock);

    const db = makeStubDb();
    await processYankedVersion(env, db as never, makeCandidate());

    // Both PUTs come before the R2 delete in the timeline.
    const r2DeleteIdx = callOrder.indexOf("r2:delete");
    const fetchIdxs = callOrder
      .map((c, i) => (c.startsWith("fetch:") ? i : -1))
      .filter((i) => i >= 0);
    expect(fetchIdxs.length).toBe(2);
    for (const idx of fetchIdxs) {
      expect(idx).toBeLessThan(r2DeleteIdx);
    }
  });

  it("mirror failure does NOT skip R2 delete (priority is purging accessible content)", async () => {
    const zipBytes = new Uint8Array([0x01, 0x02, 0x03]);
    const r2Obj = makeR2Object(zipBytes);

    // GitHub returns 500 on every PUT — mirror throws inside the processor.
    const fetchMock = async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response("upstream blew up", { status: 500 });
    };
    const { env, deleteCalls } = makeBindings({ r2Object: r2Obj, fetch: fetchMock });
    const db = makeStubDb();

    const outcome = await processYankedVersion(env, db as never, makeCandidate());

    // R2 still purged…
    expect(deleteCalls).toEqual(["skills/my-skill/v1.2.3.skill"]);
    // …and the row is stamped so the cron doesn't loop forever on it.
    expect(db.__updates).toHaveLength(1);
    expect(db.__updates[0].set).toHaveProperty("r2DeletedAt");
    // Outcome flags the mirror failure for the result counters.
    expect(outcome.mirrored).toBe(false);
    expect(outcome.mirrorFailed).toBe(true);
    // Audit still written but flags the mirror failure.
    expect(db.__inserts).toHaveLength(1);
    expect(db.__inserts[0].values.metadata).toMatchObject({
      mirrored: false,
      mirror_failed: true,
    });
  });

  it("treats absent R2 object as already-deleted (closes the audit loop without erroring)", async () => {
    const { env, deleteCalls, fetchCalls } = makeBindings({ r2Object: null });
    const db = makeStubDb();

    const outcome = await processYankedVersion(env, db as never, makeCandidate());

    // No mirror attempted — we have nothing to archive.
    expect(fetchCalls).toEqual([]);
    expect(outcome.mirrored).toBe(false);
    expect(outcome.mirrorFailed).toBe(false);
    expect(outcome.r2WasMissing).toBe(true);

    // R2 delete still called (idempotent in R2 when key is absent).
    expect(deleteCalls).toEqual(["skills/my-skill/v1.2.3.skill"]);

    // Row stamped, audit written with r2_was_missing:true.
    expect(db.__updates).toHaveLength(1);
    expect(db.__inserts).toHaveLength(1);
    expect(db.__inserts[0].values.metadata).toMatchObject({
      r2_was_missing: true,
      mirrored: false,
    });
  });

  it("writes audit event with action=skill.r2_deleted_after_yank and the version id", async () => {
    const zipBytes = new Uint8Array([0x00]);
    const r2Obj = makeR2Object(zipBytes);
    const { env } = makeBindings({ r2Object: r2Obj });
    const db = makeStubDb();
    const cand = makeCandidate({
      versionId: "22222222-2222-2222-2222-222222222222",
      slug: "another-skill",
      semver: "0.0.1",
    });

    await processYankedVersion(env, db as never, cand);

    expect(db.__inserts).toHaveLength(1);
    const audit = db.__inserts[0].values;
    expect(audit.action).toBe("skill.r2_deleted_after_yank");
    expect(audit.targetId).toBe("22222222-2222-2222-2222-222222222222");
    expect(audit.metadata).toMatchObject({
      slug: "another-skill",
      semver: "0.0.1",
      grace_period_hours: 24,
    });
  });

  it("propagates the candidate's r2Key to both R2 ops (no key rewriting)", async () => {
    const zipBytes = new Uint8Array([0x42]);
    const r2Obj = makeR2Object(zipBytes);
    const { env, getCalls, deleteCalls } = makeBindings({ r2Object: r2Obj });
    const db = makeStubDb();
    const customKey = "skills/weird-slug/v9.9.9.skill";

    await processYankedVersion(env, db as never, makeCandidate({ r2Key: customKey }));

    expect(getCalls).toEqual([customKey]);
    expect(deleteCalls).toEqual([customKey]);
  });

  it("mirror PUTs the skill bytes verbatim (base64-wrapped) — content not lost", async () => {
    const zipBytes = new Uint8Array([0x50, 0x4b, 0xff, 0x00, 0xab, 0xcd]);
    const r2Obj = makeR2Object(zipBytes);

    const seenBodies: string[] = [];
    const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
      seenBodies.push(typeof init?.body === "string" ? init.body : "");
      return new Response(JSON.stringify({ commit: { sha: "abc" } }), { status: 201 });
    };
    const env = {
      SKILLS_BUCKET: {
        get: async (_key: string) => r2Obj,
        delete: async (_key: string) => {},
      },
      GITHUB_MIRROR_TOKEN: "fake",
      DATABASE_URL: "postgres://stub",
    } as unknown as Parameters<typeof processYankedVersion>[0];
    vi.stubGlobal("fetch", fetchMock);

    const db = makeStubDb();
    await processYankedVersion(env, db as never, makeCandidate());

    expect(seenBodies).toHaveLength(2);
    // The first PUT is the .zip. Its base64 payload should decode back to
    // our exact bytes.
    const firstBody = JSON.parse(seenBodies[0]);
    expect(firstBody.message).toContain("skill.zip");
    const decoded = Buffer.from(firstBody.content, "base64");
    expect(Array.from(decoded)).toEqual(Array.from(zipBytes));

    // The second PUT is the tombstone JSON.
    const secondBody = JSON.parse(seenBodies[1]);
    expect(secondBody.message).toContain("tombstone.json");
    const tombstone = JSON.parse(
      Buffer.from(secondBody.content, "base64").toString("utf-8"),
    );
    expect(tombstone).toMatchObject({
      slug: "my-skill",
      semver: "1.2.3",
      archived_by: "r2-cleanup-yanked",
    });
  });
});
