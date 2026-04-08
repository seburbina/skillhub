# Enterprise implementation roadmap

**Companion to** `docs/enterprise-scoping.md` (Step 6 scoping + CISO review).

Where the scoping doc explains *what* to build and *why*, this file
answers *when* and *in what order*. It is organized as **four
sequential phases** with an explicit gate between each, plus a
**Phase 0 "free-tier prep"** pass that can ship immediately without
adding any monthly cost.

> **Legend**
> - 💰 = incurs a new monthly cost
> - 🆓 = runs on current free tier
> - 🔴 = P0 (security blocker for first tenant)
> - 🟡 = P1 (must-have before GA)
> - 🟢 = P2 (nice-to-have / can slip)

---

## TL;DR — the shape of the plan

```
Phase 0   FREE-TIER PREP                  ~2 weeks   🆓   (do now)
   │
   │ Gate: all prep items merged, tests green
   │
Phase 1   DESIGN PARTNER + DECISIONS      ~2 weeks   🆓
   │
   │ Gate: signed LOI from first customer, open questions resolved
   │
Phase 2   ENTERPRISE v1 TECHNICAL BUILD   ~8 weeks   💰
   │
   │ Gate: internal pen-test pass, design partner accepts
   │
Phase 3   COMPLIANCE + GA                 ~4 weeks   💰
   │
   │ Gate: SOC 2 Type I report, first invoice
   │
Phase 4 (parallel, starts with Phase 2)
         SOC 2 READINESS                  ~6 months  💰
```

**The key move is Phase 0.** It's the part of enterprise work that can
happen right now, on the free tier, with no commercial pressure, and
dramatically reduces the cost and risk of Phase 2 later. Every item in
Phase 0 is either a schema hook, a code refactor, or a process change
that makes the enterprise migration incremental instead of a
big-bang rewrite.

---

## Phase 0 — Free-tier prep (do this now)

**Goal:** ship every change that costs $0/month and reduces
Phase-2 risk or cost. None of these items need a design partner, a
budget, or a decision on commercial model. They just make the future
build easier.

**Budget impact:** $0. Everything in this phase runs on the existing
free-tier stack (Cloudflare Workers free, Neon free, R2 free, GitHub
public repo).

**Duration:** ~2 weeks of focused work for one developer. Can be
scattered across multiple sittings.

**Principle:** every item below either adds a schema hook (nullable
column, empty table), refactors existing code without changing
behavior, or adds process infrastructure. Nothing changes the
public-tier user experience.

### 0.1 🔴 🆓 Enable Postgres Row-Level Security with permissive policies

The single highest-ROI security change. Cost: $0. Effort: ~1 day.

**What:** turn on RLS on every table that will be tenanted
(`users`, `agents`, `skills`, `skill_versions`, `invocations`,
`moderation_flags`), with policies that are currently permissive
(`USING (true)`). Wrap every query in a session that sets
`app.current_tenant_id = '00000000-...'` (the "public sentinel").

**Why now:**
- RLS is free in Postgres — no cost impact
- Today's public-tier behavior is unchanged because the policy is
  permissive
- When tenant_id lands later, tightening the policy is a one-line
  schema migration, not a rewrite
- Forces us to get comfortable with the `makeDb()` transaction
  wrapping pattern on the public tier before it matters
- Catches early bugs: if any query bypasses the wrapper and fails,
  we learn about it in dev, not under an enterprise pentest

**Concrete work:**
1. New migration `apps/api/scripts/enable-rls-permissive.mjs`:
   ```sql
   ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
   CREATE POLICY skills_rls_permissive ON skills
     USING (true) WITH CHECK (true);
   -- repeat for agents, users, skill_versions, invocations, moderation_flags
   ```
2. Refactor `apps/api/src/db/index.ts` `makeDb()` to wrap every query
   in a single-statement transaction that sets a `SET LOCAL
   app.current_tenant_id` before executing. Needs a spike first
   (see §0.1.a below).
3. Full regression test on the live API: search, publish, download,
   telemetry, heartbeat, claim, admin — every route must still
   return 200.

**Biggest unknown (named in scoping doc):** does the
`@neondatabase/serverless` HTTP driver support per-request
`SET LOCAL` via a transaction? 1-day spike in §0.1.a.

**Acceptance:**
- `SELECT rowsecurity FROM pg_tables WHERE tablename = 'skills'` returns `true`
- Every route still returns 200
- A test query without the wrapper silently returns all rows
  (confirms permissive policy is active)

### 0.1.a 🔴 🆓 Spike: Neon HTTP driver + RLS session variables

**Duration:** 1 day. **Blocks:** 0.1.

Proof-of-concept in a throwaway branch: does `sql(...)` from
`@neondatabase/serverless` actually let us do:

```ts
await sql(`BEGIN; SET LOCAL app.current_tenant_id = 'abc'; SELECT * FROM skills; COMMIT`);
```

If yes → proceed with 0.1. If no → investigate the WebSocket driver
(`@neondatabase/serverless` with pooler) as an alternative, or fall
back to **application-layer "checked" queries** where every query
passes the tenant_id as a parameter and a runtime assertion rejects
missing values. The checked-query approach is weaker than RLS but
better than nothing.

**Deliverable:** 1-page memo in `docs/rls-spike-results.md` with the
verdict + chosen path.

### 0.2 🔴 🆓 `audit_events` table + append-only logging

Cheap to add now, impossible retroactively. Starts accumulating
history immediately so enterprise deals don't ask "where's the audit
log for the last year?" and we can say "right here, filtered to your
tenant".

**What:** schema + write helper + call sites.

**Schema (new migration `apps/api/scripts/add-audit-events.mjs`):**
```sql
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,                 -- null = public tier
  actor_type text NOT NULL,       -- 'user' | 'agent' | 'system' | 'stripe_webhook'
  actor_id uuid,
  actor_email text,               -- denormalized
  action text NOT NULL,           -- 'publish' | 'download' | 'revoke' | ...
  target_type text,
  target_id text,
  ip text,
  user_agent text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_tenant_at_idx ON audit_events (tenant_id, created_at DESC);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_id);
CREATE INDEX audit_events_action_idx ON audit_events (action);

-- Append-only: RLS with no UPDATE/DELETE policies
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_events_insert ON audit_events FOR INSERT WITH CHECK (true);
CREATE POLICY audit_events_select ON audit_events FOR SELECT USING (true);
-- explicitly no UPDATE or DELETE policies → RLS denies by default
```

**Write helper (`apps/api/src/lib/audit.ts`, new):**
```ts
export async function writeAudit(
  db: DbClient,
  evt: {
    tenantId?: string | null;
    actorType: "user" | "agent" | "system" | "stripe_webhook";
    actorId?: string;
    actorEmail?: string;
    action: string;
    targetType?: string;
    targetId?: string;
    ip?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditEvents).values(evt);
}
```

**Call sites to wire up:**
- `/v1/agents/register` → `action: 'agent.register'`
- `/v1/agents/me/rotate-key` → `action: 'agent.key_rotate'`
- `/v1/agents/me/claim/start` → `action: 'claim.start'`
- `/claim/:token` (claim completion) → `action: 'claim.complete'`
- `/v1/publish` → `action: 'skill.publish'`
- `/v1/skills/:id/versions/:semver/download` → `action: 'skill.download'`
- `/v1/skills/:id/report` → `action: 'skill.report'`
- `/v1/skills/:id/yank` → `action: 'skill.yank'`
- `/v1/telemetry/invocations/:id/rate` → `action: 'skill.rate'`
- Admin page accesses (via host-based middleware) → `action: 'admin.view'`

**Retention:** no cap in Phase 0. The cost of keeping this table is
~few KB per event, Neon free tier can absorb millions of rows. Add
retention policy in Phase 2 (`DELETE FROM audit_events WHERE
created_at < now() - interval '1 year'` via cron).

**Acceptance:**
- After a publish, `SELECT action, actor_id, created_at FROM
  audit_events ORDER BY created_at DESC LIMIT 5` shows the event
- `DELETE FROM audit_events` fails with "permission denied"
- Admin page view triggers an entry

### 0.3 🔴 🆓 Central `visibleSkillsPredicate()` helper

Replace the 4 hard-coded raw SQL visibility filters **now**, even
though today it's just a trivial wrapper around
`visibility IN ('public_free', 'public_paid')`. This is a **behavior-
preserving refactor** — zero functional change, but the shape of the
code matches what Enterprise v1 needs.

**What:**
1. New file `apps/api/src/lib/visibility.ts`:
   ```ts
   export function visibleSkillsPredicate(
     viewerAgent: Agent | null,
   ): SQL {
     // Phase 0: public tier only. Tenant awareness lands in Phase 2.
     return sql`${skills.visibility} IN ('public_free', 'public_paid')`;
   }
   ```
2. Replace the 4 raw SQL filters at:
   - `apps/api/src/routes/skills.ts:89`
   - `apps/api/src/routes/skills.ts:166`
   - `apps/api/src/routes/leaderboard.ts:87`
   - `apps/api/src/routes/agents.ts:295`
3. Add a unit-test-grade assertion (even inline comment) that these
   are the ONLY places visibility filters should live.

**Why now:** when tenant_id lands, the migration is "change one
function, not four files". Makes the Phase 2 refactor mechanical.

**Acceptance:** 4 raw SQL filters deleted, 1 helper function
imported in 4 places, typecheck clean, production behavior
unchanged.

### 0.4 🔴 🆓 Add `tenant_id` columns (nullable, no FK yet)

**What:** migration `apps/api/scripts/add-tenant-id-columns.mjs`:

```sql
ALTER TABLE users           ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE agents          ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE skills          ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE skill_versions  ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE invocations     ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE moderation_flags ADD COLUMN IF NOT EXISTS tenant_id uuid;

CREATE INDEX IF NOT EXISTS users_tenant_idx   ON users (tenant_id)  WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agents_tenant_idx  ON agents (tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS skills_tenant_idx  ON skills (tenant_id) WHERE tenant_id IS NOT NULL;
-- ... etc
```

**No FK constraint yet** — the `tenants` table doesn't exist. Add
the FK in Phase 2 when `tenants` is created.

**Why now:** adding columns to large tables can be expensive on a
paid Neon instance. Adding them while the tables are tiny (free
tier, <1000 rows total) is instant. When we add millions of rows
later, the columns are already there.

**Mirror update to Drizzle schema:** add the columns to
`apps/api/src/db/schema.ts` so the TypeScript types match.
They'll be `tenantId: uuid('tenant_id')` (nullable, no `.references()`
yet).

**Acceptance:** `\d skills` in Neon shows `tenant_id` column, every
existing row has `tenant_id IS NULL`, Drizzle typecheck clean.

### 0.5 🔴 🆓 Wrap `makeDb()` with tenant-aware session context

Companion to 0.1. Once the spike confirms RLS + session variables
work, refactor the query client to accept a tenant context:

```ts
// Old signature
export function makeDb(env: Bindings): DbClient

// New signature
export function makeDb(
  env: Bindings,
  ctx?: { tenantId: string | null; bypassRls?: boolean },
): DbClient
```

Every route handler that already has an authenticated agent passes
the tenant (currently always `null`). Cron jobs and admin routes pass
`bypassRls: true`. The wrapper sets:

```sql
SET LOCAL app.current_tenant_id = COALESCE($1, '00000000-0000-0000-0000-000000000000');
SET LOCAL app.bypass_rls = $2;
```

**Why now:** same reason as 0.1. Get the pattern battle-tested on
public traffic before enterprise traffic.

**Acceptance:** all routes still return 200. A test query with the
wrong tenant context returns 0 rows (simulates a tenanted query on
the public sentinel).

### 0.6 🟡 🆓 RBAC role constants (unused but defined)

Add `apps/api/src/lib/rbac.ts` with the role matrix. No enforcement
yet — just constants and types:

```ts
export type TenantRole = "owner" | "admin" | "publisher" | "consumer" | "viewer" | "billing";

export const ROLE_PERMISSIONS: Record<TenantRole, Set<Permission>> = {
  owner:     new Set([... all ...]),
  admin:     new Set([... all minus billing ...]),
  publisher: new Set(["skill.publish", "skill.edit_own", "skill.delete_own", "tenant.read"]),
  consumer:  new Set(["skill.install", "skill.invoke", "tenant.read"]),
  viewer:    new Set(["tenant.read", "audit.read"]),
  billing:   new Set(["billing.read", "billing.manage"]),
};

export function hasPermission(role: TenantRole, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(perm) ?? false;
}
```

**Why now:** forces the design decision *before* it's under deadline
pressure. Discussion about whether "Publisher can delete own skill"
happens in a calm Phase 0 PR review, not in a 3am enterprise
incident.

**Acceptance:** file exists, exported, nothing imports it yet,
typecheck clean. This is a stake in the ground.

### 0.7 🟡 🆓 Cloudflare Access JWT verification helper (unused)

Add `apps/api/src/lib/access-jwt.ts` that verifies the
`Cf-Access-Jwt-Assertion` header against the Cloudflare Access
team's JWKS endpoint. Dead code — not called by any route yet.

**Why now:**
- Costs $0 (JWKS fetch is a single cached request)
- When the admin surface grows, we can flip it on with a one-line
  import
- Pentesters can review the verification logic before it becomes
  security-critical
- Forces us to answer "what claims do we actually trust from
  Access?" while the stakes are low

**Reference implementation:** Cloudflare publishes the exact pattern
at <https://developers.cloudflare.com/cloudflare-one/identity/users/validating-json/>

**Acceptance:** `verifyAccessJwt(request, env)` returns `{email,
groups}` on valid token, `null` on invalid, `null` on missing header.
Unit test covers all three cases (and expired/malformed tokens).

### 0.8 🟡 🆓 Skill allowlist table (empty)

Schema hook only. No enforcement in Phase 0.

```sql
CREATE TABLE tenant_skill_allowlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,                  -- null = public tier, always allowed
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  allowed_by_user_id uuid,
  allowed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tenant_skill_allowlist_unq ON tenant_skill_allowlist (tenant_id, skill_id);
```

When Phase 2 lands, the download endpoint adds:
```ts
if (agent.tenantId && !await isAllowlisted(db, agent.tenantId, skill.id)) {
  return errorResponse(c, "forbidden", "This skill is not on your tenant's allowlist.");
}
```

**Why now:** table exists → enterprise security questionnaires get
a "yes, we have a per-tenant allowlist" check without writing code.

### 0.9 🟡 🆓 API versioning policy document

New file `docs/api-versioning.md`. ~1 page. Content:
- `/v1/*` is the current stable contract
- Breaking changes require a new major version
- Deprecation notice ≥12 months before removal
- Non-breaking additions ship to the current version (new fields,
  new optional params, new endpoints)
- Every change recorded in `docs/api-changelog.md`
- The base skill version-pins the server API at registration time

**Why now:** when the first enterprise customer asks "what's your
deprecation policy?", the answer exists. Writing this while we have
0 customers is trivial; writing it during a contract negotiation is
agony.

### 0.10 🟡 🆓 GitHub branch protection + signed commits + CI gate

**Branch protection on `main`** (GitHub Free supports this):
- Require pull requests before merging
- Require status checks to pass (typecheck + build)
- Require signed commits
- Include administrators (yes, restrict yourself too)
- Disallow direct pushes

**CI gate via GitHub Actions** (free: 2000 min/mo, way more than
we'll use):

```yaml
# .github/workflows/ci.yml
name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter api typecheck
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          curl -fsS https://agentskilldepot.com/v1/health | grep -q '"status":"ok"'
```

**Signed commits:** Set `user.signingkey` to a GPG key or use
GitHub's web-signed commits. Free.

**Why now:** SOC 2 Type I audits look at change management as
Criterion CC8.1. "We enforce PRs and CI gates" is worth 2 pages of
evidence. "We force-push to main" is worth disqualification.

### 0.11 🟡 🆓 Dependabot + CodeQL + dependency graph

Free on public repos. Enable in one click each:
- **Dependabot alerts** (GitHub → Settings → Code security)
- **Dependabot security updates** (auto-PRs for vulns)
- **CodeQL** (static analysis, free on public repos)
- **Dependency graph** (built-in, gives us SBOM export)

**Why now:** any enterprise questionnaire asks "do you scan
dependencies for vulnerabilities?" The answer becomes "yes, via
GitHub Dependabot + CodeQL, weekly scans, findings tracked in our
repo's Security tab". Zero ongoing effort.

### 0.12 🟡 🆓 `SECURITY.md` + `/.well-known/security.txt`

Tiny files, big signal.

**`SECURITY.md`** at repo root:
```markdown
# Security policy

## Reporting a vulnerability
Email security@agentskilldepot.com (or a public-tier alias) with:
- description
- reproduction steps
- affected version/commit
- your contact info

We acknowledge within 48 hours, patch within 90 days, and credit
researchers on the public changelog unless you request anonymity.

## Supported versions
Only `main` is supported. Released `.skill` versions follow
api-versioning.md.

## Scope
In scope: the Worker at *.agentskilldepot.com, the base skill
scripts, the Drizzle schema.
Out of scope: DoS, social engineering, physical attacks, third-party
services (Neon, Cloudflare, Resend, Voyage).
```

**`apps/api/public/.well-known/security.txt`** (served automatically
by the `[assets]` binding):
```
Contact: mailto:security@agentskilldepot.com
Expires: 2027-04-07T00:00:00Z
Preferred-Languages: en
Canonical: https://agentskilldepot.com/.well-known/security.txt
Policy: https://github.com/seburbina/skillhub/blob/main/SECURITY.md
```

**Why now:** costs nothing, enterprise buyers look for this.

### 0.13 🟡 🆓 Structured logging with `tenant_id` field

Refactor the ad-hoc `console.log`s to a tiny structured logger:

```ts
// apps/api/src/lib/log.ts
export function logEvent(
  level: "info" | "warn" | "error",
  event: string,
  ctx: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    tenant_id: ctx.tenantId ?? null,
    ...ctx,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
```

Replace the existing `console.log("[publish.embedSkill]", ...)`
patterns with `logEvent("info", "publish.embedSkill", {...})`.

**Why now:** `tenant_id` field is present on every log line from day
1. When Phase 2 lands, operators can filter `wrangler tail` or a
SIEM by tenant without a schema rewrite.

**Acceptance:** every log line is a one-line JSON object with at
minimum `{ts, level, event, tenant_id}`. `wrangler tail --format
json` output is directly pipeable to `jq`.

### 0.14 🟡 🆓 Tenant-scoped rate-limit key scheme

Current `rate_limit_buckets.key` is `text` (e.g.,
`agent:<id>:publish`). Add a tenant dimension to the key naming
convention:

```
Old:  agent:<id>:publish
New:  t:<tenant>:agent:<id>:publish   (for tenanted agents)
New:  public:agent:<id>:publish       (for public-tier agents)
```

No schema change — the column is already `text`. Just update the
`checkRateLimit()` call sites to include the prefix.

**Why now:** when Phase 2 adds tenant-level quotas, the lookup
already has the tenant in the key. No key-migration script needed.

### 0.15 🟢 🆓 Incident response runbook

New file `docs/incident-runbook.md`. One page. Content:

```markdown
# Incident response runbook

## Severity levels
- SEV-1: production down, active data loss, active attack
- SEV-2: major feature broken, no data loss
- SEV-3: minor degradation, workaround exists

## First 5 minutes (any SEV)
1. Check https://agentskilldepot.com/v1/health
2. Check `wrangler tail` for errors
3. Check Cloudflare dashboard → Workers → skillhub → Metrics
4. Check Neon dashboard → branch status

## Common procedures
### Rollback the Worker
`cd apps/api && wrangler rollback`  (instant)

### Rotate API_KEY_HASH_SECRET (emergency)
... [procedure TBD — known gap, see scoping doc §H2] ...

### Restore Neon from backup
1. Neon dashboard → Branches → Restore from backup
2. Pick a point-in-time within retention window
3. Update DATABASE_URL secret in Worker
4. Redeploy

### Suspend a misbehaving agent
DATABASE_URL=... node -e "
  import('@neondatabase/serverless').then(async ({neon}) => {
    const sql = neon(process.env.DATABASE_URL);
    await sql('UPDATE agents SET revoked_at = now() WHERE id = \$1', [id]);
  });
"
```

**Why now:** the first SEV-1 is not the moment to learn what the
procedures are. Better a 1-page runbook now than a 10-page one
written under pressure later.

### 0.16 🟢 🆓 Neon point-in-time restore drill

One-time exercise: restore a 1-hour-old Neon backup to a new branch,
point the dev Worker at it, run the smoke test. Measure wall-clock
time. That's your real RTO for the dev environment. Document the
finding in `docs/dr-drill-2026-04.md`.

**Why now:** you learn the actual mechanics, the actual time, and
whether the free-tier branch limit (10 branches) is a blocker.

### 0.17 🟢 🆓 Data retention + deletion policy document

New file `docs/data-retention.md`. Defines:
- How long each data type is retained
- What triggers deletion (user action, tenant termination, time)
- How deletion propagates across tables
- How audit logs handle deleted users

Even without implementing the workflow, writing the policy forces
the hard decisions:
- Do skills published by a deleted user stay live? (probably yes,
  with author attribution pseudonymized)
- Do moderation reports from a deleted user stay? (yes, append-only
  audit trail)
- How long does a "pseudonymized but not deleted" user row live?

**Why now:** answer the hard questions while the stakes are low.
Phase 2 just implements the policy; it doesn't have to design it
under deadline.

### 0.18 🟢 🆓 Content hash verification on download (client-side)

The `skill_versions.content_hash` column is populated at publish but
never verified at install time. Add verification in
`base-skill/skillhub/scripts/` — when the base skill downloads a
`.skill` file, compute its SHA-256 and match against the server's
`content_hash`. Refuse to install on mismatch.

**Why now:** cheap supply-chain posture. The server already stores
the hash; the client just needs to check it. When enterprise asks
"do you verify skill integrity on install?", the answer becomes
"yes, every install".

**Acceptance:** the install flow prints `content verified: sha256:…`
on success, or refuses and exits nonzero on mismatch.

### 0.19 🟢 🆓 SBOM exposure

GitHub's dependency graph automatically generates an SBOM. Enable
the "Export SBOM" feature. Link from `SECURITY.md` to the GitHub
Security tab. Enterprise customers love SBOMs.

**Zero effort, just enable it.**

### 0.20 🟢 🆓 Consolidated phase 0 checklist + verification

Once 0.1 through 0.19 are done, a final housekeeping PR:
- Re-run the smoke test suite against production
- Measure TTFB on key endpoints (must stay within 10% of pre-0
  baseline; RLS + audit writes add ~5ms)
- Update `docs/enterprise-scoping.md` Part II §17 to mark items
  1, 2, 3, 4, 6 as "Phase 0 complete" and re-sort the remaining
  priority list
- Tag a `v0.2.0-prep` git tag for the baseline

**Phase 0 acceptance (full gate):**
- [ ] All 20 items merged to `main`
- [ ] CI gate in place, main branch protected
- [ ] Typecheck clean
- [ ] Production smoke test passes
- [ ] RLS enabled on all tenanted tables (permissive)
- [ ] `audit_events` table populated by real traffic
- [ ] `visibleSkillsPredicate` swapped in at all 4 call sites
- [ ] All 6 `tenant_id` columns added
- [ ] `makeDb()` wrapper accepts tenant context
- [ ] Dependabot + CodeQL active
- [ ] SECURITY.md + security.txt live
- [ ] DR drill completed and documented

---

## Phase 1 — Design partner + decisions (~2 weeks)

**Goal:** lock down the commercial + regulatory requirements for
Enterprise v1 by finding one real customer willing to be a design
partner.

**Budget impact:** $0 operational, may include discount commitments
for the design partner.

**Not a build phase — a discovery phase.**

### 1.1 Identify 3–5 prospects

Criteria:
- Use Claude Code or another agentic LLM tool in production
- Already sharing skills informally (Slack, internal docs, etc.)
- US-based (solves data residency in v1)
- ≤50 seats (avoids the SSO hard-block)
- Willing to accept a pre-SOC-2 vendor in exchange for:
  - Deep product influence
  - Discounted or free first year
  - Direct access to founder

### 1.2 Discovery calls

For each prospect, confirm:
- Do they need SSO on day 1? (if yes → WorkOS in v1, budget +$125/mo)
- Do they need SOC 2 Type I (attestation letter) or Type II (6-month
  audit)?
- Do they need BAA/HIPAA? (if yes → different product)
- Data residency requirement? (US-only = simple, EU = block or
  defer)
- Audit log export format? (CSV? JSON? SIEM-direct?)
- How many seats? How many skills per week?
- What's the #1 security question that would block procurement?

### 1.3 Lock the answers to the 7 open questions in scoping §7

Based on design partner input, make concrete decisions on:
1. Tenant members in v1? → **likely yes**
2. Can tenant agents publish public? → **likely no**
3. Admin auth for `/t/<tenant>/*`? → **depends on SSO answer**
4. Billing model? → **flat seat for v1 based on partner feedback**
5. First tenant name → **the signed LOI partner**
6. Rate-limit penalty for tenant agents? → **no**
7. Per-tenant R2 quotas? → **yes, tiered**

### 1.4 Signed LOI or equivalent commitment

Not a legal requirement — but a clear yes/no/maybe from the partner
including:
- Commit to pilot launch by target date
- Agree to a minimum contract value (even if discounted)
- Accept the "no SOC 2 yet, coming in month N" caveat

**Phase 1 acceptance:**
- [ ] Design partner identified and committed (LOI or verbal
  agreement with target launch date)
- [ ] All 7 scoping §7 questions resolved in a decisions log
- [ ] Revised scope for Phase 2 written, reflecting design-partner
  specifics (if they don't need EU, we skip region work; if they
  need SSO, WorkOS is in scope)

---

## Phase 2 — Enterprise v1 technical build (~8 weeks)

**Goal:** ship the smallest production-credible Enterprise v1 to the
design partner.

**Budget impact:** starts incurring costs. See §2.0 for the minimum
paid-service shopping list.

**Prereq:** Phase 0 and Phase 1 complete.

### 2.0 💰 Paid services to provision (week 0)

| Service | Purpose | Monthly cost |
|---|---|---|
| Cloudflare Workers Paid | SLA, higher CPU budget, Logpush | $5 |
| Neon Launch plan | SLA, larger storage, no compute hibernation | $19 |
| Cloudflare Access Pro | SSO path integration | ~$5 × admin count |
| WorkOS (if SSO needed) | SAML/OIDC + SCIM | $125/connection |
| Vanta or Drata | SOC 2 automation | $3k–10k/year |
| SOC 2 Type I auditor | Initial audit | $10k–15k (one-time) |
| Sentry (error tracking) | Incident visibility | Free tier works; $26/mo when it doesn't |
| **Minimum baseline** | | **~$50–150/mo** |
| **With SSO + SOC 2** | | **~$300–500/mo + audit fees** |

### 2.1 🔴 Phase 2 build order (weeks 1–8)

Map the 20-item fix list from scoping §17 to weeks:

| Week | Work | Items | Ref |
|---|---|---|---|
| 1 | Create `tenants` + `tenant_members` tables; add FK on the existing `tenant_id` columns. RLS policies tightened to use `current_tenant_id`. | 1, 4 | scoping §5.1–5.2 |
| 2 | Tenant-scoped slug uniqueness migration; `enterprise` visibility value; check constraint. R2 key prefix refactor. | — | scoping §5.2–5.5 |
| 3 | Publish endpoint stamps tenant_id; download endpoint checks allowlist; tenant-scoped rate limits active. | 6, 8 | scoping §5.6, Phase 0 §0.14 |
| 4 | Tenant invite workflow (reuse Phase 2.5 magic-link code). RBAC enforcement active using Phase 0 §0.6 constants. | 4, 5 | scoping §15.1–15.2 |
| 5 | SSO wire-up: WorkOS or Cloudflare Access IdP per Phase 1 decision. Test with design partner's IdP. | 7 | scoping §12.4 |
| 6 | Stripe subscription + webhook + dunning skeleton. Zero-rated metering hooks (Phase 0 §0.14 carried forward). | 12, 16 | scoping §5.9, §16.2 |
| 7 | Tenant-scoped admin routes: `/t/<tenant>/{queue,skill,agent,users,billing}` pages. Uses Phase 0 §0.7 JWT verification. | 4 | scoping §5.8 |
| 8 | End-to-end testing with design partner sandbox tenant. Bug fixes. Pentest kickoff. | — | — |

### 2.2 🔴 Pen test (week 8)

**Internal pass:** the founder runs through every documented attack
vector from the scoping doc §12 + §17. Verify each is blocked.

**External pass (optional but recommended):** hire a small pentest
firm (~$5k–10k) to spend 2 days. They'll find things the founder
missed. Report goes in `docs/security-reviews/2026-pentest-01.md`.

**Acceptance:** zero P0 findings; all P1 findings have tickets.

### 2.3 🔴 Design partner acceptance

The design partner accesses their tenant, invites a team member,
publishes a skill, installs it on another agent, downloads, rates.
They sign off that the isolation feels right.

**Phase 2 acceptance:**
- [ ] All 20 items from scoping §17 either completed or explicitly
  deferred to Phase 3/4 with written justification
- [ ] Pen test complete, no P0 findings
- [ ] Design partner has used the system for ≥1 week without a
  cross-tenant concern
- [ ] The public tier is unchanged (zero regressions confirmed by
  smoke tests)

---

## Phase 3 — Compliance + GA (~4 weeks)

**Goal:** get from "design partner happy" to "any customer can buy".

**Budget impact:** SOC 2 Type I audit fees (~$10k–15k one-time).

### 3.1 💰 SOC 2 Type I audit execution

If Phase 4 (SOC 2 readiness workstream, started at Phase 2 week 0)
has accumulated evidence properly, the Type I audit is a 2–3 week
exercise with an independent CPA firm:
- Evidence review
- Interviews
- Walkthrough of controls
- Attestation letter issued

The letter is what enterprise buyers actually want. Type II (which
tests controls over a 6-month period) comes later.

### 3.2 🔴 Public website + docs updates

- `agentskilldepot.com/enterprise` landing page
- Pricing page
- Security posture page (links to SOC 2 report request form)
- Terms of Service updates for enterprise tier
- Privacy policy updates (DPO contact, SCC ready)

### 3.3 🔴 Billing + onboarding flow polish

- Self-serve sign-up → Stripe checkout → automatic tenant creation
  (or keep human-touch for v1)
- Welcome email, first-steps guide
- Tenant admin dashboard polish

### 3.4 🔴 GA announcement

- Blog post
- Twitter/LinkedIn announcement
- Email to waiting list

**Phase 3 acceptance:**
- [ ] SOC 2 Type I attestation letter in hand
- [ ] Billing flow works end-to-end for a new customer
- [ ] Design partner migrated from "free pilot" to "paying customer"
- [ ] At least 1 additional paying customer onboarded
- [ ] Public documentation refreshed

---

## Phase 4 — SOC 2 + continuous compliance (parallel, ~6 months)

Starts at Phase 2 week 0. Runs in parallel to the build.

**Tools:** Vanta or Drata (~$3k–10k/year)

**Workstreams:**
1. **Policies** — information security policy, incident response
   policy, vendor management policy, access control policy, change
   management policy, business continuity policy, data retention
   policy (Phase 0 §0.17 covers this one)
2. **Evidence collection** — Vanta/Drata integrates with GitHub,
   Cloudflare, Neon, etc., and auto-collects controls evidence
3. **Access reviews** — quarterly review of who has access to what
4. **Vendor risk assessments** — review the SOC 2 of every upstream
   vendor (Neon, Cloudflare, Resend, Voyage, WorkOS, Stripe)
5. **Employee training** — one-person training is still required;
   document completion
6. **Pen test results** — the Phase 2.2 pen test contributes
7. **Access logs + audit log exports** — Phase 0 §0.2 populates this
8. **Change management evidence** — Phase 0 §0.10 branch protection
   + PR history is the evidence
9. **Incident response drills** — Phase 0 §0.15 runbook + 1 dry run

**Phase 4 milestones:**
- Month 1: Policies drafted, Vanta integrated
- Month 2: Evidence collection rolling
- Month 3: Readiness review with auditor
- Month 4: Type I audit fieldwork (Phase 3.1)
- Month 5: Type I letter delivered
- Month 6+: Type II observation window opens

---

## Phase 0 summary — what you can do right now, this week

If you want to start immediately and don't want to think about the
commercial path yet, here's the tight list of **13 free items that
make the biggest difference:**

| Item | Effort | Cost | Value |
|---|---|---|---|
| 0.1.a RLS spike with Neon HTTP driver | 1 day | $0 | Unblocks everything else |
| 0.1 Enable RLS (permissive) | 1 day | $0 | Defense-in-depth foundation |
| 0.2 `audit_events` table + write helper | 2 days | $0 | Starts accumulating history |
| 0.3 `visibleSkillsPredicate` refactor | 0.5 day | $0 | Makes Phase 2 mechanical |
| 0.4 `tenant_id` columns (nullable) | 0.5 day | $0 | Free schema hook |
| 0.5 `makeDb()` tenant context wrapper | 1 day | $0 | Battle-tested before it matters |
| 0.6 RBAC role constants | 0.5 day | $0 | Forces decisions early |
| 0.7 Access JWT verification (dead code) | 1 day | $0 | Admin hardening ready |
| 0.10 Branch protection + CI gate | 0.5 day | $0 | SOC 2 evidence from day 1 |
| 0.11 Dependabot + CodeQL | 15 min | $0 | Supply-chain posture |
| 0.12 SECURITY.md + security.txt | 30 min | $0 | Enterprise signal |
| 0.13 Structured logging | 1 day | $0 | Future SIEM integration |
| 0.18 Content hash verification | 1 day | $0 | Supply-chain posture |
| **Total** | **~11 days** | **$0** | **Everything Phase 2 depends on** |

The remaining Phase 0 items (0.8, 0.9, 0.14, 0.15, 0.16, 0.17, 0.19)
are lower priority and can slip into later weeks.

---

## Decision points before execution

Before starting even Phase 0, answer these:

1. **Do we commit to building Enterprise?** If "not sure", do
   Phase 0 anyway — it's valuable even if Enterprise never ships,
   because RLS, audit logs, structured logging, and branch
   protection are all good for the public tier too.
2. **Do we have a design partner candidate?** If yes, Phase 1
   can start in parallel with Phase 0. If no, Phase 0 still makes
   sense but Phase 1 is a harder discovery exercise.
3. **What's the budget ceiling?** Phase 2 onward incurs ~$50–500/mo
   depending on SSO. Phase 4 adds ~$3k–10k/year for Vanta + audit
   fees. If the budget is zero, stop after Phase 0 and wait.
4. **What's the time budget?** Phase 0 is ~2 weeks of developer
   time. Phase 2 is ~8 weeks. Phase 4 is ongoing. Total to first
   paying enterprise customer: ~4 months optimistic, ~6 months
   realistic.

---

## Files this roadmap would create or modify

**New files (Phase 0):**
- `apps/api/scripts/enable-rls-permissive.mjs`
- `apps/api/scripts/add-audit-events.mjs`
- `apps/api/scripts/add-tenant-id-columns.mjs`
- `apps/api/src/lib/visibility.ts`
- `apps/api/src/lib/audit.ts`
- `apps/api/src/lib/rbac.ts`
- `apps/api/src/lib/access-jwt.ts`
- `apps/api/src/lib/log.ts`
- `apps/api/public/.well-known/security.txt`
- `SECURITY.md`
- `.github/workflows/ci.yml`
- `docs/api-versioning.md`
- `docs/api-changelog.md`
- `docs/incident-runbook.md`
- `docs/data-retention.md`
- `docs/dr-drill-2026-04.md`
- `docs/rls-spike-results.md`

**Modified files (Phase 0):**
- `apps/api/src/db/schema.ts` — add `tenant_id` columns, new tables,
  `audit_events` definition
- `apps/api/src/db/index.ts` — `makeDb()` wrapper
- `apps/api/src/routes/skills.ts` — swap raw SQL for
  `visibleSkillsPredicate()`
- `apps/api/src/routes/leaderboard.ts` — same
- `apps/api/src/routes/agents.ts` — same
- `apps/api/src/routes/publish.ts` — audit event on publish
- Every mutation endpoint — audit event calls
- `base-skill/skillhub/scripts/upload.py` or equivalent — content
  hash verification on download
- Various routes — replace `console.log` with `logEvent`

---

## Exit criteria — "Phase 0 done" checklist

Copy-paste this into a GitHub issue when starting:

```
Phase 0 — Enterprise prep (free-tier-safe)

Track A: Foundation (days 1–5)
- [ ] 0.1.a RLS spike verdict written
- [ ] 0.1 RLS enabled permissively on all tenanted tables
- [ ] 0.2 audit_events table + writeAudit helper
- [ ] 0.3 visibleSkillsPredicate swapped in (4 sites)
- [ ] 0.4 tenant_id columns added to 6 tables
- [ ] 0.5 makeDb() wrapper with tenant context

Track B: Code stakes (days 6–8)
- [ ] 0.6 RBAC role constants
- [ ] 0.7 access-jwt.ts helper
- [ ] 0.13 Structured logger

Track C: Process (days 9–10)
- [ ] 0.10 Branch protection enabled
- [ ] 0.10 CI workflow merged
- [ ] 0.11 Dependabot + CodeQL enabled
- [ ] 0.12 SECURITY.md + security.txt

Track D: Documentation (async, any time)
- [ ] 0.9 API versioning policy doc
- [ ] 0.15 Incident response runbook
- [ ] 0.17 Data retention policy doc
- [ ] 0.16 DR drill run + documented
- [ ] 0.19 SBOM export enabled

Track E: Verification (day 11)
- [ ] 0.20 Regression smoke test
- [ ] 0.20 TTFB measurement
- [ ] 0.20 Scoping doc §17 updated
- [ ] Tag v0.2.0-prep

Delivery target: 2 weeks wall clock
Cost: $0
```
