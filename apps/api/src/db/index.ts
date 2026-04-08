/**
 * Drizzle DB client wired to Neon's serverless HTTP driver.
 *
 * `@neondatabase/serverless` works on Cloudflare Workers (and any other
 * fetch-only runtime) because it talks to Neon over HTTPS instead of using
 * raw Postgres TCP. Drizzle's `neon-http` adapter sits on top of it.
 *
 * Pattern (unchanged from Phase 0 batch 1):
 *   const db = makeDb(c.env);
 *   const rows = await db.select().from(skills).where(eq(skills.slug, slug));
 *
 * `makeDb` is called per-request (cheap — just builds a thin object); the
 * underlying neon() client itself caches connection state inside the
 * Cloudflare isolate, so successive requests reuse warm connections.
 *
 * Phase 0 §0.5 — tenant context
 * -----------------------------
 * `makeDb(env, ctx)` now accepts an optional `TenantContext`. Phase 0
 * records the context for instrumentation but does NOT yet wrap every
 * query in a transaction — permissive RLS policies (USING true) let
 * existing queries through unchanged.
 *
 * `runWithTenantContext(env, ctx, fn)` is the proof-of-concept wrapper
 * that actually uses sql.transaction([SET LOCAL, ...]) to carry the
 * tenant id into the query session. Routes that need tight isolation
 * (Phase 2) opt into it; Phase 0 leaves existing routes on the plain
 * `makeDb()` path.
 *
 * The RLS spike (docs/rls-spike-results.md) confirmed this pattern
 * works with the Neon HTTP driver.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

export type Db = NeonHttpDatabase<typeof schema>;

/**
 * A Drizzle transaction scope — what `db.transaction(async tx => ...)`
 * hands to its callback. Narrower than `Db` (no `$withAuth`, no
 * `batch`) but supports all query builders, so it's what
 * `runWithTenantContext` exposes.
 */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Per-request tenant context. Phase 0 uses this for instrumentation;
 * Phase 2 uses it to scope RLS policies.
 *
 * - `tenantId: null` → public tier (current state)
 * - `tenantId: "<uuid>"` → tenant-scoped request
 * - `bypassRls: true` → cron jobs, admin queries that must see
 *   everything. Flips `app.bypass_rls = on` in the session.
 */
export interface TenantContext {
  tenantId: string | null;
  bypassRls?: boolean;
}

/**
 * Well-known UUID used as a sentinel "no tenant" value when
 * `SET LOCAL app.current_tenant_id` cannot accept NULL. All public-tier
 * rows are compared against this; Phase 2 RLS policies treat it the
 * same as `tenant_id IS NULL`.
 */
export const PUBLIC_TENANT_SENTINEL =
  "00000000-0000-0000-0000-000000000000";

/**
 * Build a Drizzle client. Accepts an optional tenant context for
 * instrumentation (Phase 0) and future RLS enforcement (Phase 2).
 */
export function makeDb(
  env: { DATABASE_URL: string },
  _ctx?: TenantContext,
): Db {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }
  const client = neon(env.DATABASE_URL);
  return drizzle(client, { schema, logger: false });
}

/**
 * Run a function inside a Postgres transaction with tenant context
 * session variables set via SET LOCAL. This is the Phase 2 enforcement
 * primitive. Phase 0 uses it only for proof-of-concept endpoints; the
 * rest of the codebase stays on `makeDb()` and relies on permissive
 * RLS policies.
 *
 * The callback receives a plain Drizzle client that runs its queries
 * inside the same transaction, so SET LOCAL values carry across.
 *
 * Why this shape:
 *   - `sql.transaction([...])` from Neon HTTP requires an array of
 *     queries, which doesn't compose well with Drizzle.
 *   - Instead we use Drizzle's `db.transaction(async (tx) => { ... })`
 *     which maps to the same underlying primitive, and set the session
 *     variables as the first statement inside the callback.
 *
 * Not yet used by any production route — the intended first caller is
 * a smoke-test endpoint or a Phase 2 tenant-scoped query.
 */
export async function runWithTenantContext<T>(
  env: { DATABASE_URL: string },
  ctx: TenantContext,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  const db = makeDb(env);
  return db.transaction(async (tx) => {
    const tenantId = ctx.tenantId ?? PUBLIC_TENANT_SENTINEL;
    const bypassRls = ctx.bypassRls === true ? "on" : "off";

    // SET LOCAL is scoped to this transaction only. We validate the
    // tenantId against a strict UUID regex before string-interpolating
    // it into the SQL because Postgres's SET LOCAL doesn't accept
    // parameterized values.
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        tenantId,
      )
    ) {
      throw new Error(`invalid tenantId: ${tenantId}`);
    }
    await tx.execute(sql.raw(`SET LOCAL app.current_tenant_id = '${tenantId}'`));
    await tx.execute(sql.raw(`SET LOCAL app.bypass_rls = '${bypassRls}'`));

    return fn(tx);
  });
}

export { schema };
