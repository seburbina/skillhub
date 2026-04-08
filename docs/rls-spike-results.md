# RLS spike results — Neon HTTP driver + session variables

**Date:** 2026-04-07
**Spike item:** Phase 0 §0.1.a (from `docs/enterprise-implementation-roadmap.md`)
**Duration:** ~15 minutes
**Verdict:** ✅ **PASS — proceed with Phase 0 RLS strategy.**

## Question

Can we set `app.current_tenant_id` as a PostgreSQL session variable
in one statement and read it back in a subsequent statement via the
`@neondatabase/serverless` HTTP driver? This is the foundation for
Phase 0 §0.1 (permissive RLS) and §0.5 (`makeDb()` wrapper).

If the answer is no, Phase 0's RLS strategy collapses and we pivot
to application-layer "checked queries" (weaker) or switch to the
Neon WebSocket pooler driver (bigger architectural change).

## Method

Ran four probes against the production Neon instance (read-only test
queries, no schema or data modified):

### Test 1 — Multi-statement in a single `sql\`...\`` template

```ts
await sql`
  BEGIN;
  SET LOCAL app.current_tenant_id = '11111111-...';
  SELECT current_setting('app.current_tenant_id', true) AS tenant;
  COMMIT;
`;
```

**Result:** ❌ Fails with `cannot insert multiple commands into a
prepared statement`.

**Interpretation:** The HTTP driver parameterizes every `sql\`...\``
call as a single prepared statement. Multi-command strings aren't
accepted. Expected — that's how HTTP+prepared-statement drivers
behave.

### Test 2 — `sql.transaction([...])` with separate statements

```ts
const result = await sql.transaction([
  sql`SET LOCAL app.current_tenant_id = '22222222-...'`,
  sql`SELECT current_setting('app.current_tenant_id', true) AS tenant`,
]);
```

**Result:** ✅ `[[], [{"tenant":"22222222-2222-2222-2222-2222222222"}]]`

**Interpretation:** The `sql.transaction()` helper sends both
statements in a single HTTP request wrapped in `BEGIN`/`COMMIT`. The
`SET LOCAL` from statement 1 is visible to the `SELECT` in statement
2 because they share a server-side session for the duration of the
transaction. **This is the critical finding** — it means we can
wrap Drizzle queries in a transaction and pre-set the tenant
context on the first line.

### Test 3 — Raw multi-statement string via `sql(...)` function form

```ts
await sql("BEGIN; SET LOCAL ...; SELECT ...; COMMIT;");
```

**Result:** ❌ Same error as Test 1 — prepared-statement limitation.

### Test 4 — Session isolation between separate `sql()` calls

```ts
await sql`SET app.current_tenant_id = '44444444-...'`;
const r = await sql`SELECT current_setting('app.current_tenant_id', true) AS tenant`;
```

**Result:** `[{"tenant":""}]` — the second call sees an empty
tenant value.

**Interpretation:** Each top-level `sql()` call is its own
transaction on its own session. The HTTP driver does NOT pool
connections with shared session state. This is the **correct and
secure** behavior — it means there is no way for tenant context to
leak across requests via session-level state.

## Implications for Phase 0

### ✅ What works

1. **`sql.transaction([...])` with `SET LOCAL` as the first
   statement.** Every tenant-scoped query batch wraps in a transaction
   that looks like:

   ```ts
   await sql.transaction([
     sql`SET LOCAL app.current_tenant_id = ${ctx.tenantId ?? PUBLIC_SENTINEL}`,
     sql`SET LOCAL app.bypass_rls = ${ctx.bypassRls ? "on" : "off"}`,
     // ... actual queries ...
   ]);
   ```

2. **Permissive RLS can be enabled immediately** on the Phase 0
   tables. Even without the wrapper in place, `USING (true)` policies
   let all queries through and accumulate zero risk.

3. **Drizzle integration is possible via `db.transaction()`**. Drizzle's
   transaction wrapper maps to the underlying driver's transaction.
   We can execute `SET LOCAL` as the first `tx.execute()` call inside
   every transactional query.

### ⚠️ What doesn't work (and workarounds)

1. **Can't set session context on a "standing" `db` connection.** The
   Drizzle client returned from `drizzle(sql)` has no concept of
   per-request state. Every tenant-sensitive call site must either:
   - Use `db.transaction(async (tx) => {...})` and set the var inside
   - Or call `sql.transaction([...])` directly with raw SQL

2. **Single-statement `db.select()` calls outside a transaction will
   see `app.current_tenant_id = ''`.** This is fine for permissive
   policies (`USING true`) but will start blocking queries as soon as
   Phase 2 tightens the RLS rules. The migration path is: wrap every
   query in a transaction before tightening the policy.

### Recommended Phase 0 implementation pattern

**Don't rewrite every query yet.** Phase 0 is about getting the
machinery in place without changing behavior. The proposal:

1. **Enable RLS permissively on all tenant-scoped tables** (§0.1).
   Existing code works because `USING (true)` lets everything through.

2. **Create `makeDbWithContext(env, ctx)` as a new helper** (§0.5) —
   returns a Drizzle client bound to a tenant-aware transaction
   wrapper. Available immediately but NOT yet required by every route.

3. **Use the wrapper on ONE endpoint as proof of concept** (e.g.,
   `/v1/skills/search` since it's read-only and well-isolated). Verify
   behavior matches the old `makeDb(env)` path.

4. **Phase 2 week 1** migrates every remaining route over to the
   wrapper, then tightens the RLS policies. At that point, any query
   not inside the wrapper breaks loudly — which is exactly what we
   want as the enforcement boundary.

This keeps Phase 0 low-risk (nothing changes behavior), gets the
pattern battle-tested (the proof-of-concept endpoint runs on real
traffic), and sets up Phase 2 as a mechanical migration.

## What we did NOT test

- **Performance impact** of wrapping every query in a transaction.
  Expected to be minimal (HTTP driver is already one round-trip per
  call; transaction wrapping is still one round-trip with two or
  three statements). Will measure in Phase 0.20 TTFB baseline.

- **Drizzle's `db.transaction()` interaction with `sql` tag literals
  inside the transaction** — we know the underlying Neon helper
  works, but haven't confirmed Drizzle passes SET LOCAL through
  cleanly. Low risk but worth testing when §0.5 lands.

- **RLS policy evaluation overhead** — adding policies adds a
  per-query check. On a permissive policy this should be negligible
  (<1ms) but hasn't been measured.

- **Nested transactions** — if a route calls `db.transaction()` and
  that function internally calls another `db.transaction()`, how do
  SET LOCALs compose? Probably fine (SAVEPOINT semantics), but
  untested.

## Next steps

- ✅ §0.1.a spike complete — verdict positive
- ⏭ Proceed with §0.3, §0.4, §0.6, §0.7, §0.13, §0.18 (do not
  depend on RLS) — these can ship immediately
- ⏭ §0.1 (enable RLS) and §0.5 (`makeDb` wrapper) are unblocked
  but can ship in a follow-up PR to keep the Phase 0 batches
  reviewable
- ⏭ §0.2 (audit_events) can use either the old `makeDb()` or the
  new wrapper — start with the old, migrate in Phase 2

**Spike status: closed. No architectural pivot needed.**
