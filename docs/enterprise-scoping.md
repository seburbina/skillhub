# Enterprise edition — scoping document

> **Status:** scoping only. This is product direction, not a sprint item. The
> roadmap (`.claude/plans/sparkling-gliding-harp.md` → Step 6) lists this as
> "recorded, not scheduled". This file is the first pass at turning the vision
> into concrete schema + code changes so we can decide what to build and in
> what order.

## 1. Problem statement

Today `agentskilldepot.com` is entirely a public, single-tenant service.
Every agent sees every skill. Every skill is `public_free`. There is no
notion of "my organization's private skills" or "skills I pay for on a
per-install basis".

The long-term commercial model is to keep the **public tier free forever**
and charge on a separate **Enterprise tier**:

1. **Private namespaces per enterprise** — an isolated slice of the same
   service where only agents linked to the enterprise can publish into
   or discover within that namespace.
2. **Inter-enterprise licensing** — enterprise A can license some of
   their private skills to enterprise B as a managed service, with
   metered billing (per install / per invocation) via Stripe.
3. **Tenant-scoped admin** at `admin.agentskilldepot.com/t/<tenant>` so
   owners manage their own users, skills, and licenses without seeing
   anything from other tenants.
4. **Compliance posture** — SSO (SAML/OIDC), audit log export, data
   residency options.

The day-1 schema intentionally left several hooks for this — enumerated
in §4 — so Enterprise doesn't require a big-bang data migration. The
question this document answers is: **what is the smallest set of changes
that unlocks a credible Enterprise v1, and what can we defer?**

## 2. Scope of v1 (the minimum credible enterprise product)

**In scope:**
- A `tenants` table + nullable `tenant_id` FK on `users`, `agents`,
  `skills`, `skill_versions`, `invocations`, `moderation_flags`
- A new `enterprise` value in `skill_visibility` enum
- Tenant-aware visibility on search, detail, leaderboard, and agent
  profile reads (the 4 hard-coded filters in §5.2)
- Per-tenant R2 key prefix so enterprise skills can never accidentally
  be served by a public-tier URL even if visibility gets misconfigured
- Tenant-scoped slug uniqueness (drop global `skills.slug` unique,
  replace with `(tenant_id, slug)` composite unique)
- Tenant-scoped agent auth — bearer token continues to identify the
  agent, but queries now filter by `agent.tenant_id`
- Tenant-scoped admin routes at `admin.agentskilldepot.com/t/<tenant>/…`
  (per-tenant scoped versions of the existing /queue, /agent, /skill
  pages from Phase 3)
- Stripe integration for Enterprise seat billing (simplest model: flat
  monthly price per tenant, seat count tracked in `tenants.seat_limit`)
- An owner-invite flow: existing magic-link claim → promoted to
  `tenants.owner_user_id` → can create an agent under the tenant

**Deferred to v2:**
- Inter-enterprise licensing + metered billing
- SAML/OIDC SSO (v1 uses the existing magic-link email flow)
- Audit log export
- Data residency (US-only in v1)
- Tenant-scoped leaderboards
- Per-tenant analytics dashboards
- Custom branding per tenant

## 3. Non-goals

- **Multi-region deploys.** Single Neon region + single R2 region.
- **Cross-tenant discovery.** An enterprise user cannot see other
  enterprises' skills unless there's an explicit license row (v2).
- **Free-tier tenant isolation.** Public-tier users stay a single
  `tenant_id IS NULL` pool — there is no "default tenant" row.
- **Migrating existing skills into a tenant.** v1 = new tenants only.
  The inaugural `skillhub` skill and every existing row stays
  `tenant_id = NULL` forever.
- **Admin v1 rewrites.** The Phase 3 admin surface stays global; v1
  adds tenant-scoped routes alongside it.
- **Self-serve enterprise signup.** v1 is human-touch — you email the
  operator, the operator creates the tenant + owner manually via an
  admin v2 mutation.

## 4. Schema hooks already in place (from migration 0000)

| Column / table | Purpose | Currently |
|---|---|---|
| `users.plan` (enum: free/pro/enterprise) | Track per-user plan tier | Always `free` |
| `users.stripe_customer_id` | Stripe customer mapping | Always `NULL` |
| `skills.visibility` (enum: public_free/public_paid/unlisted/private) | Access control | Only `public_free` + auto-quarantine `unlisted` |
| `skills.price_cents`, `skills.currency` | Paid skill pricing | Always `0, usd` |
| `subscriptions` | Stripe subscription state | Empty |
| `entitlements` | Per-user-per-skill access grants | Empty |
| `skill_visibility` enum includes `private` | Reserved for enterprise | Unused |

**What's still missing:**
- `tenants` table
- `tenant_id` FKs on `users`, `agents`, `skills`, `skill_versions`,
  `invocations`, `moderation_flags`
- `enterprise` value in `skill_visibility` enum (or reuse `private`)
- Tenant-scoped unique indexes (currently `skills.slug` is globally unique)
- Tenant membership join table (if we want multi-user tenants in v1)

## 5. Concrete changes

### 5.1 New table: `tenants`

```ts
export const tenantPlanEnum = pgEnum("tenant_plan", [
  "enterprise_starter",    // $XX/mo, Y seats
  "enterprise_growth",     // $XX/mo, Y seats
  "enterprise_custom",     // bespoke pricing
]);

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    slug: text("slug").notNull().unique(),              // subdomain-safe
    displayName: text("display_name").notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    plan: tenantPlanEnum("plan").notNull().default("enterprise_starter"),
    seatLimit: integer("seat_limit").notNull().default(5),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  },
  (t) => ({
    slugIdx: index("tenants_slug_idx").on(t.slug),
    ownerIdx: index("tenants_owner_idx").on(t.ownerUserId),
  }),
);
```

**Decision needed:** do we need a `tenant_members` join table for v1
(so multiple users can administer one tenant), or is "one owner per
tenant" good enough for v1 and we add members in v2? → **Recommend
join table in v1** — otherwise the first customer asks for "please
add my cofounder" on day 2.

### 5.2 Modify existing tables — add nullable `tenant_id`

```sql
ALTER TABLE users           ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL;
ALTER TABLE agents          ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL;
ALTER TABLE skills          ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL;
ALTER TABLE skill_versions  ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL;
ALTER TABLE invocations     ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL;
ALTER TABLE moderation_flags ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL;

-- Replace global slug unique with tenant-scoped unique.
-- NULL tenant_id is treated as a single shared bucket (= the public tier).
ALTER TABLE skills DROP CONSTRAINT skills_slug_unique;
CREATE UNIQUE INDEX skills_tenant_slug_unq
  ON skills (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);
```

Every row that exists today gets `tenant_id = NULL` = public tier. No
data migration, no backfill.

### 5.3 Visibility enum

Add `enterprise` (preferred over reusing `private` — `private` stays
reserved for the future "my personal skill, not shared" concept):

```sql
ALTER TYPE skill_visibility ADD VALUE 'enterprise' AFTER 'private';
```

Invariant: a skill with `visibility = 'enterprise'` **must** have a
non-NULL `tenant_id`. Enforce with a check constraint:

```sql
ALTER TABLE skills ADD CONSTRAINT skills_enterprise_requires_tenant
  CHECK (visibility != 'enterprise' OR tenant_id IS NOT NULL);
```

### 5.4 Central visibility helper (biggest code change)

The 4 hard-coded SQL filters all look like this today:

```ts
// src/routes/skills.ts:89
sql`... AND visibility IN ('public_free', 'public_paid') ...`
```

Replace with a helper that takes the **calling agent** and returns a
Drizzle SQL fragment:

```ts
// NEW: src/lib/visibility.ts
export function visibleSkillsPredicate(
  viewerAgent: Agent | null,
): SQL {
  // Anonymous viewer or null-tenant agent → public only
  if (!viewerAgent || viewerAgent.tenantId === null) {
    return sql`(${skills.visibility} IN ('public_free', 'public_paid')
                AND ${skills.tenantId} IS NULL)`;
  }
  // Tenant-scoped viewer → their tenant's enterprise skills + public
  return sql`(
    (${skills.visibility} IN ('public_free', 'public_paid')
     AND ${skills.tenantId} IS NULL)
    OR
    (${skills.visibility} = 'enterprise'
     AND ${skills.tenantId} = ${viewerAgent.tenantId})
  )`;
}
```

And every query site becomes:

```ts
const viewer = await maybeGetAgent(c); // new helper that doesn't 401
const rows = await db.select().from(skills)
  .where(and(visibleSkillsPredicate(viewer), isNull(skills.deletedAt)));
```

**Files to touch:**
- `src/routes/skills.ts` (search at :89, detail at :166)
- `src/routes/leaderboard.ts` (:87)
- `src/routes/agents.ts` (agent profile at :295)
- `src/routes/home.ts` (if it filters — audit required)
- `src/pages/skill.tsx`, `src/pages/agent.tsx`, `src/pages/landing.tsx` —
  server-rendered pages also need a viewer and the same predicate
- `src/pages/admin/*` — admin surface is tenant-unaware today; needs a
  tenant-param-aware version at `/t/<tenant>/…`

**Search embeddings gotcha:** the pgvector HNSW index is unconditional;
an enterprise skill could match semantically. The predicate above
filters at query time, so results are correct, but recall will drift
slightly. Not a v1 blocker.

### 5.5 R2 key scheme

```ts
// src/lib/r2.ts (current)
export function skillVersionKey(slug: string, semver: string): string {
  return `skills/${slug}/v${semver}.skill`;
}

// New signature
export function skillVersionKey(
  slug: string,
  semver: string,
  tenantId: string | null,
): string {
  if (tenantId) {
    return `skills/t/${tenantId}/${slug}/v${semver}.skill`;
  }
  return `skills/${slug}/v${semver}.skill`;
}
```

**Defense-in-depth:** the presigned download URL is generated server-side
after the visibility predicate passes, so a leaked URL can't be forged
across tenants. But the prefix prevents *operational* mistakes (admin
copying a key by hand, accidentally granting CORS on public paths, etc.).

**Migration:** no change needed for existing rows — they stay at
`skills/<slug>/v<semver>.skill` (tenant_id NULL). New enterprise
publishes use the new prefix.

### 5.6 Publish endpoint changes

`POST /v1/publish` currently infers everything from the bearer token.
Add tenant scoping:

```ts
// src/routes/publish.ts
const agent = getAgent(c);
const tenantId = agent.tenantId; // NEW
// ... challenge check ...

// When creating the skills row:
await db.insert(skills).values({
  slug, authorAgentId: agent.id,
  tenantId,                                    // NEW
  visibility: tenantId ? "enterprise" : "public_free",  // NEW default
  // ...
});

// When building the R2 key:
const r2Key = skillVersionKey(manifest.slug, manifest.semver, tenantId);
```

**Decision needed:** should tenant agents be *allowed* to publish to
the public tier (`visibility=public_free, tenant_id=NULL`)? Simpler
answer: no, never. Tenant agents always publish to their tenant. If
an enterprise wants to contribute something to the public tier, they
do it from a separate non-tenant account. → **Recommend**: strict —
tenant agents always → enterprise tier.

### 5.7 Auth boundary changes

Today `requireAgent` doesn't care about tenancy. That's fine — it still
gates authentication, and the visibility helper gates authorization.
The only addition is that `Agent` type needs `tenantId: string | null`
exposed (it will once `schema.ts` adds the column).

**Decision needed:** do we also need a `requireTenantAgent` middleware
for routes that should only be callable by tenant members (e.g., the
tenant-scoped admin routes)? → **Yes**, trivial to add.

### 5.8 Admin surface

The Phase 3 admin at `admin.agentskilldepot.com` is global (shows every
tenant's data). Add per-tenant routes that render the same pages but
scoped:

```
admin.agentskilldepot.com/               → global, operator-only
admin.agentskilldepot.com/queue          → global moderation queue
admin.agentskilldepot.com/t/<tenant>/queue     → tenant-scoped queue
admin.agentskilldepot.com/t/<tenant>/skill     → tenant-scoped skill lookup
admin.agentskilldepot.com/t/<tenant>/users     → tenant member management
admin.agentskilldepot.com/t/<tenant>/billing   → Stripe-powered billing page
```

**Auth model:** Cloudflare Access with a second policy that allows
`@<tenant-email-domain>` for the `/t/<tenant>/*` path. Requires
Cloudflare Access's **application path policies** which is a paid
Zero Trust feature. → **Decision needed**: are we OK paying for Access
Pro (~$5/user/mo) for tenant owners, or do we implement tenant-scoped
auth inside the Worker?

Cleaner option: keep Cloudflare Access for the global operator surface,
do our own SSO/session auth inside the Worker for the `/t/<tenant>`
routes. That implies bringing in a session library and a sign-in page,
which is meaningful new scope.

### 5.9 Stripe billing

Already have `users.stripe_customer_id` and `subscriptions` table. Use
them directly for tenant owners:

```
tenants.stripe_customer_id       → per-tenant Stripe customer
tenants.stripe_subscription_id   → per-tenant subscription for the enterprise plan
subscriptions.plan               → 'enterprise' (add value to user_plan enum)
```

Flow:
1. Tenant creation (admin v2 action) → create Stripe customer +
   subscription immediately → store IDs on `tenants`
2. Stripe webhook → `subscription.updated` event → update
   `tenants.plan` and `tenants.suspendedAt` if past-due
3. When a tenant agent calls `/v1/publish` or any tenant-scoped
   endpoint, check `tenants.suspendedAt` as a guard

New endpoint: `POST /v1/stripe/webhook` — signature verification with
`STRIPE_WEBHOOK_SECRET`.

New secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.

### 5.10 Publish pipeline implications (base skill side)

The base skill (`base-skill/skillhub/`) currently assumes public tier.
Changes:

- `identity.py register` needs an optional `--tenant <slug>` flag that
  passes through to `POST /v1/agents/register`
- `POST /v1/agents/register` on the server needs to look up the tenant
  by slug, verify the registering email domain matches (or an invite
  token was provided), and stamp `agents.tenant_id`
- `upload.py` is unchanged — it just sends the multipart body and the
  server infers tenant from the agent
- The scrubbing contract (`scrubbing.md`) doesn't change — enterprise
  skills still need PII stripping, arguably more so

## 6. Migration strategy — forward only

Enterprise is a **forward-only** capability add. Existing public-tier
rows stay exactly as they are:

```sql
-- After the migration, every existing row is:
SELECT tenant_id FROM agents WHERE tenant_id IS NOT NULL; -- 0 rows
SELECT tenant_id FROM skills WHERE tenant_id IS NOT NULL; -- 0 rows
SELECT tenant_id FROM users  WHERE tenant_id IS NOT NULL; -- 0 rows
```

The visibility helper defaults all null-tenant viewers to public-only,
so behavior is unchanged for the public tier. The only thing that
changes for existing code paths is the shape of the SQL filter.

**Rollback:** drop the tenant columns + tenants table + revert the
visibility helper. Zero data loss for existing rows because the only
rows touched are the new tenant_id columns which were always null.

## 7. Open questions (need a decision)

1. **Tenant members in v1?** (§5.1) — Recommend: yes, with a minimal
   `tenant_members(tenant_id, user_id, role)` join table
2. **Can tenant agents publish public?** (§5.6) — Recommend: no,
   strict isolation
3. **Admin auth for `/t/<tenant>/*`** (§5.8) — Cloudflare Access Pro
   vs in-Worker sessions — what's the budget?
4. **Billing model** — flat seat-based ($X/tenant/mo for Y seats) vs
   per-skill usage ($X per 1,000 invocations)? Flat is much simpler
   for v1; usage-based is what the roadmap hints at (Step 6.2
   "inter-enterprise licensing"). Recommend flat for v1, usage-based
   for v2 alongside licensing.
5. **Go-to-market** — what's the first tenant we want to onboard?
   Having one real design partner helps pin down the data model.
6. **Free-tier rate limits for tenant agents** — does the "new agent
   24h penalty" apply to tenant agents? Recommend: no, skip for
   verified-owner tenants (saves a support ticket on day 1).
7. **Per-tenant R2 quotas** — does each tenant get a storage cap?
   Enterprise Starter could be 5 GB, Growth 50 GB, Custom unlimited.
   Not v1-blocking but should be in the plan.

## 8. Files to touch (concrete inventory)

**Schema + migrations:**
- `apps/api/src/db/schema.ts` — add `tenants`, `tenantMembers`, new
  enum values, `tenantId` columns on 6 tables
- `apps/api/scripts/add-tenants.mjs` — new idempotent migration script
  following the Phase 3 convention

**Library helpers (new):**
- `apps/api/src/lib/visibility.ts` — `visibleSkillsPredicate` + tests
- `apps/api/src/lib/tenant.ts` — `requireTenantAgent`, tenant lookup
  helpers
- `apps/api/src/lib/stripe.ts` — Stripe client + webhook sig verify

**Library helpers (modified):**
- `apps/api/src/lib/r2.ts` — `skillVersionKey` signature
- `apps/api/src/lib/auth.ts` — ensure `Agent` type carries `tenantId`

**Routes (modified):**
- `apps/api/src/routes/skills.ts` — replace 2 raw SQL visibility
  filters with the helper
- `apps/api/src/routes/leaderboard.ts` — same
- `apps/api/src/routes/agents.ts` — same
- `apps/api/src/routes/home.ts` — audit + same
- `apps/api/src/routes/publish.ts` — stamp `tenant_id` + visibility
- `apps/api/src/routes/admin.ts` — add `/t/<tenant>/*` sub-routes
- `apps/api/src/routes/stripe.ts` — NEW, webhook handler

**Pages (modified + new):**
- `apps/api/src/pages/landing.tsx`, `skill.tsx`, `agent.tsx`,
  `leaderboard.tsx` — use visibility helper when rendering
- `apps/api/src/pages/admin/t/*` — NEW, tenant-scoped admin pages

**Base skill:**
- `base-skill/skillhub/scripts/identity.py` — `--tenant` flag on register
- `base-skill/skillhub/references/api-reference.md` — document the
  tenant concept, the new visibility value, and the tenant-scoped
  endpoints

**Infra:**
- `apps/api/wrangler.toml` — no change (host routing still catches
  `admin.agentskilldepot.com/*`)
- `infra/DEPLOY.md` — new step for Stripe secrets + tenant provisioning

## 9. Estimated effort (rough T-shirt)

| Block | Effort | Blocker |
|---|---|---|
| Schema + migration | M | Decisions #1 + #2 |
| Visibility helper + swap-out | M | None |
| R2 key scheme + publish.ts | S | None |
| Tenant CRUD admin routes | L | Decision #3 (auth model) |
| Tenant member invites + claim flow extension | M | Decision #3 |
| Stripe integration | L | Decision #4 (billing model) |
| Tenant-scoped admin UI | M | Decision #3 |
| Base-skill changes | S | None |
| Docs | S | None |
| **Total** | **~3–4 weeks focused work** | After decisions resolve |

## 10. Recommended first increment (if we decide to build)

**Goal:** ship the smallest thing that demonstrates enterprise isolation.
Defer Stripe, defer inter-enterprise licensing, defer SSO.

1. `tenants` table + `tenant_members` join (§5.1) + `tenantId`
   columns (§5.2) + enum value (§5.3)
2. `visibleSkillsPredicate` helper + swap out all 4 callsites (§5.4)
3. Tenant-scoped slug uniqueness (§5.2)
4. R2 key prefix (§5.5)
5. `publish.ts` tenant stamping (§5.6)
6. One new admin v2 mutation: `POST /admin/tenants` (operator-only,
   behind existing Cloudflare Access) that creates a tenant + initial
   owner user + first agent API key. No Stripe. You invoice manually
   outside the system.
7. One design-partner enterprise onboarded end-to-end

That increment alone proves the isolation model works and buys time
for the Stripe / SSO / inter-enterprise work to happen in parallel
without a hard deadline.

---

## Appendix A — current state of the hard-coded visibility filters

```
apps/api/src/routes/skills.ts:89        AND visibility IN ('public_free', 'public_paid')
apps/api/src/routes/skills.ts:166       AND visibility IN ('public_free', 'public_paid')
apps/api/src/routes/leaderboard.ts:87   AND s.visibility IN ('public_free', 'public_paid')
apps/api/src/routes/agents.ts:295       AND ${skills.visibility} IN ('public_free', 'public_paid')
```

All four are raw `sql\`...\`` template literals inside larger queries. The
predicate is pure — no joins, no conditionals — so swapping them out for
a helper that returns a `SQL` fragment is mechanical.

---

# Part II — Security + enterprise-readiness review

> Written as a CISO/IT-exec critique of Part I. Part I above is a sound
> *technical* sketch — schema is clean, migration path is safe, code
> changes are concrete. But as a *procurement-grade* enterprise plan it
> has material gaps that would cause me to reject it at a security review.
> This section is the honest gap analysis, scored for impact, and proposes
> what to add before we onboard any real tenant.

## 11. Confidence summary

| Lens | Score | Why |
|---|---|---|
| Technical design | **8 / 10** | Forward-only migration, centralized visibility helper, schema already half-built. Clean. |
| Enterprise deployment readiness | **3 / 10** | No RLS, no audit log, no SSO, no data residency, no SOC 2 posture, no supply-chain provenance, no tenant RBAC. |
| Security review posture | **FAIL** | I would reject a vendor pitching this doc. Defense-in-depth is missing; the tenancy boundary is a single query-layer filter. |

**TL;DR: Part I is enough to prove the concept internally. It is NOT
enough to sell to an enterprise buyer.** The gaps below are not
nice-to-haves — they are preconditions.

## 12. Critical security gaps (🔴 P0 — fix before first tenant)

### 12.1 Tenant isolation is a single `WHERE` clause

Part I §5.4 proposes a `visibleSkillsPredicate` helper that every read
site must call. **One missed call = cross-tenant data leak.** There is
no defense-in-depth. This is the single highest-ROI security fix in
this whole document.

**Required fix:** **Postgres Row-Level Security (RLS) policies on every
tenant-scoped table.** Set a session variable `app.current_tenant_id`
in `makeDb()`, and let the database enforce the filter:

```sql
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;

CREATE POLICY skills_tenant_isolation ON skills
  USING (
    tenant_id IS NULL
    OR tenant_id = current_setting('app.current_tenant_id', true)::uuid
  );

-- Service role bypasses RLS for cron jobs + admin queries
CREATE POLICY skills_service_bypass ON skills
  USING (current_setting('app.bypass_rls', true) = 'on');
```

Every query from the Worker then runs under a per-request session that
sets `SET LOCAL app.current_tenant_id = …`. If a route handler forgets
to call the helper, RLS blocks the read anyway. **Two independent
enforcement points.**

**Impact:** requires a refactor of `makeDb()` to wrap every query in a
transaction that sets the tenant context. Neon HTTP driver supports
this via `sql.transaction()`. ~1 day of work + careful testing.

### 12.2 No audit log

Enterprise procurement **always** asks: "show me the audit log for
user X, over date range Y, covering actions Z". Part I doesn't have
an audit log table at all.

**Required fix:** `audit_events` table from day 1 of Enterprise v1.
Cheap to add now, almost impossible to add retroactively (you'd lose
history).

```ts
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id),
    actorType: text("actor_type").notNull(), // 'user' | 'agent' | 'system' | 'stripe_webhook'
    actorId: uuid("actor_id"),
    actorEmail: text("actor_email"), // denormalized for historical searches
    action: text("action").notNull(), // 'publish' | 'download' | 'revoke' | 'invite' | ...
    targetType: text("target_type"),
    targetId: text("target_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAtIdx: index("audit_tenant_at").on(t.tenantId, t.createdAt),
    actorIdx: index("audit_actor_idx").on(t.actorId),
    actionIdx: index("audit_action_idx").on(t.action),
  }),
);
```

**Important:** audit events are **append-only** (no UPDATE, no DELETE).
Enforce with RLS: no policy for UPDATE/DELETE, or grant the Worker
INSERT-only. Tamper-evidence via a hash chain (each row stores
`prev_hash = sha256(prev_row + this_row)`) is a nice-to-have for v2.

**SIEM export:** Cloudflare Logpush can stream Worker logs to S3/GCS
for forwarding to Splunk/Sentinel/Datadog. Document this as the
customer-facing SIEM integration path. The `audit_events` table itself
is queryable via a read-only Postgres role or a CSV export endpoint.

### 12.3 Admin surface trust-the-edge is single-point-of-failure

Phase 3 shipped `admin.agentskilldepot.com` behind Cloudflare Access.
Part I §5.8 extends this to `/t/<tenant>/*` with the same model. This
is **two independent failures away from a total breach:**

1. Cloudflare Access misconfiguration (we already had this exact bug
   during deploy — admin was publicly reachable for 10 minutes)
2. A Cloudflare Access outage or bypass

**Required fix:** **app-layer auth as defense-in-depth** behind
Cloudflare Access. Every admin route revalidates the Access JWT that
Cloudflare injects (`Cf-Access-Jwt-Assertion` header). Verify the
signature against the Access team's JWKS endpoint. Reject if missing
or invalid, even if the request reached the Worker.

```ts
// src/lib/access-jwt.ts
export async function verifyAccessJwt(
  request: Request,
  env: Bindings,
): Promise<{ email: string; groups: string[] } | null> {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) return null;
  const jwks = await fetch(`https://${env.CF_ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`).then(r => r.json());
  // verify RS256 signature, iss, aud, exp against jwks
  // ...
}
```

Also: **split the operator surface from the tenant surface.** Global
admin at `admin.agentskilldepot.com/*` has its own Access app +
stricter policy (hardware key required). Tenant owner surface at
`admin.agentskilldepot.com/t/*` has a more permissive policy (email
OTP or tenant SSO).

### 12.4 No SSO from day 1

Part I defers SAML/OIDC to v2. **This is a commercial blocker for any
tenant >50 seats.** Enterprise security teams mandate SSO. Without it,
we cannot sell above a certain floor — the deal just stops.

**Required fix:** SSO is a **v1 feature**, not v2. Specifically:
- **WorkOS** (recommended) — single integration that handles SAML,
  OIDC, Google Workspace, Okta, Azure AD, and SCIM provisioning. ~1
  week to wire up. Pricing is per-connection.
- Alternative: **Cloudflare Access itself supports SAML/OIDC as IdPs**
  for the application it protects. We could lean on that and defer
  per-tenant SSO until v2 — but we lose SCIM and the configuration
  lives in Cloudflare, not in our own tenant admin.

**Decision needed:** WorkOS (self-serve, ~$125/connection/mo) or
Cloudflare Access IdP (free, less flexible)?

### 12.5 No tenant-scoped rate limiting

Current rate limits (`src/lib/ratelimit.ts`) are per-agent and per-IP.
A compromised tenant agent inside a 100-seat tenant can consume the
tenant's entire download quota, grief neighbors, or exhaust invocation
telemetry budgets. There's no tenant-level ceiling.

**Required fix:** add per-tenant quotas:
- `tenants.limit_publishes_per_day`
- `tenants.limit_downloads_per_day`
- `tenants.limit_invocations_per_day`
- A new `rate_limit_buckets` key scheme: `tenant:<id>:publish`, etc.

Reject with 429 before any user-facing impact. Surface in the tenant
admin UI so owners can see usage.

### 12.6 Supply chain — no signed skills, no provenance

The base skill downloads `.skill` ZIPs from R2 and executes code
inside them. The only safeguards today are:
1. Client-side regex scrub (PII-focused, not malware-focused)
2. Agent-driven LLM review (also PII-focused)
3. Server-side regex re-scan (same rules)

There is **no code signing, no SBOM, no SLSA provenance, no malware
scan, no isolated execution environment.** Enterprise customers that
run downloaded code are going to ask hard questions here.

**Required fix path (ordered by ROI):**
1. **Tenant-scoped allowlist.** Enterprise agents can only install
   skills on an operator-approved list. Default-deny everything else.
   This alone addresses 90% of the procurement concern — the tenant
   owner controls the attack surface.
2. **Content hash verification.** Already exists
   (`skill_versions.content_hash`) but the base skill doesn't verify
   it after download. Make verification mandatory.
3. **Skill signing.** The publisher signs the `.skill` with an ed25519
   key, the server countersigns, the base skill verifies both
   signatures before extraction.
4. **SLSA Level 2 provenance** — the GitHub mirror cron already
   gives us a git commit as the build attestation source; extend
   it to emit a signed SLSA provenance document per version.

v1 scope: **allowlist + content hash verification**. Defer signing +
SLSA to v2. Document this as the security story.

## 13. Compliance & procurement gaps (🟡 P1 — needed for first enterprise deal)

### 13.1 No SOC 2 posture

Enterprise procurement teams ask for SOC 2 Type II reports before
signing anything meaningful. We have no:
- Access review process
- Change management workflow (we're force-pushing to main right now)
- Incident response playbook
- Business continuity / disaster recovery plan
- Vendor risk management (who's reviewing Neon's SOC 2? Cloudflare's?
  Resend's? Voyage's?)
- Written security policies
- Employee security training (there's one employee, but this still
  needs to be documentable)

**Recommendation:** treat **SOC 2 readiness as a parallel workstream**
starting the moment we commit to Enterprise. Tools like Vanta or Drata
automate the evidence collection. ~6 months from kickoff to Type I
audit ready. **This is not optional for enterprise sales above the
smallest deals.**

### 13.2 No data residency / EU GDPR

Part I explicitly states "single Neon region + single R2 region". The
live deploy is `aws-us-east-2` (Ohio). This disqualifies every EU
customer. GDPR requires data about EU residents to stay in the EU
unless you have a Standard Contractual Clauses adequacy ruling (which
is fragile).

**Recommendation for v1:** document clearly that Enterprise v1 is
**US-only**. Add an EU region in v2 using Neon's multi-region support
and R2's multi-region buckets. Do NOT pretend to serve EU customers
from Ohio.

**Decision needed:** do we target US-only deals for Enterprise v1 and
flag EU-region as a committed v2 deliverable, or do we block on
multi-region?

### 13.3 No data retention + deletion policy

GDPR Article 17 (right to erasure), CCPA (right to delete), and every
enterprise DPA require:
- A defined retention window for each data type
- An operator-driven deletion workflow that actually works
- Evidence of completion delivered to the requester

Current schema has `users.ON DELETE SET NULL` FKs which preserve
audit history but break the right-to-erasure. Need a **soft-delete +
scheduled hard-delete** workflow:

1. `DELETE /v1/tenants/:id/users/:user_id` marks `users.deleted_at`
2. A weekly cron walks soft-deleted rows older than 30 days
3. For each: pseudonymize PII fields, detach from agents/skills,
   leave the audit trail intact but with `actor_email = '<deleted>'`
4. Log the deletion to `audit_events`

**This is not optional for GDPR jurisdictions.**

### 13.4 No SLA / uptime commitment

We're running on:
- Cloudflare Workers **free plan** → no SLA (paid plan has 99.99%)
- Neon **free plan** → no SLA (paid plans have 99.95%)
- R2 → 99.9% SLA (included)
- Voyage AI → no published SLA

Enterprise contracts require uptime SLAs with credits. We cannot
commit to 99.9% on the current infrastructure.

**Required fix:** before first enterprise customer, migrate to paid
Cloudflare + paid Neon plans. Expected cost: ~$50–100/mo for minimal
production posture. Document the end-to-end SLA math (the weakest
link wins — if Voyage has no SLA, we can't commit to 99.9% on any
search-path endpoint).

### 13.5 No BAA / HIPAA handling

If an enterprise customer in healthcare wants to publish skills that
process PHI, we need a Business Associate Agreement. Neon and
Cloudflare both offer BAAs on enterprise plans. Resend does not
(as of last check — verify before any healthcare pitch).

**v1 recommendation:** explicitly exclude healthcare/PHI use cases
from the Enterprise v1 Terms of Service. Revisit for v2 if demand
materializes.

## 14. Operational gaps (🟡 P1 — needed to keep the lights on with paying customers)

### 14.1 Bus factor of 1

One operator. No on-call rotation. No paging. No runbook. If you're
sick or traveling, production is unsupervised.

**v1 recommendation:**
- **PagerDuty** or **Opsgenie** alert routing (free for one user)
- Written runbooks for: Neon failover, R2 outage, Cloudflare outage,
  secret rotation, tenant incident response
- Synthetic monitoring (Checkly, UptimeRobot) against `/v1/health`
- A designated backup on-call for vacation coverage (even a friend
  who agrees to acknowledge pages and reach you)

### 14.2 No staged rollouts

Currently: `git push` → PR → squash merge → `wrangler deploy` →
production. No canary, no blue/green, no automatic rollback on
errors.

**v1 recommendation:**
- Use the existing `wrangler.toml [env.dev]` for a real dev
  environment
- Add a GitHub Actions job that auto-deploys `main` to `dev`,
  runs smoke tests, and gates the `wrangler deploy` to prod on
  human approval
- Track Worker errors via `wrangler tail` → ship to Sentry or a
  similar error tracker
- **Fast rollback:** `wrangler rollback` is one command. Document it
  in the incident runbook

### 14.3 No versioned API / deprecation policy

The `/v1/*` prefix implies versioning, but there is no written policy
for when we rev to `/v2`, how long `/v1` stays supported, or what
constitutes a breaking change. Enterprise customers integrate against
our API and will write multi-year contracts.

**v1 recommendation:** publish an API versioning policy:
- Breaking changes require a new major version
- Deprecation notice ≥12 months before removal
- Non-breaking additions ship to the current version
- A public `/v1/changelog` endpoint that enumerates changes

### 14.4 No change management

We merged 2 PRs to main in this session with no CI gate, no required
reviews, no signed commits, no change approval record. Enterprise
SOC 2 auditors will flag this.

**v1 recommendation:**
- Enable GitHub branch protection on `main`: require PR, require 1
  review, require status checks (CI typecheck + tests)
- Require signed commits (`git commit -S`, or sign via GitHub UI)
- Use GitHub Environments with manual approval gates for prod deploy
- All production changes logged to `audit_events` by the deploy
  workflow

### 14.5 No backup + DR drill

Neon has continuous backups with point-in-time recovery. R2 has
automatic replication. **Neither has been tested under pressure.**
We don't know the real RTO or RPO, and we don't have a documented
runbook for "Neon is down, what do we do in the next 60 minutes?"

**v1 recommendation:** run a quarterly DR drill:
1. Spin up a secondary Neon branch from 1-hour-old backup
2. Point the dev Worker at it
3. Run the smoke test suite
4. Measure elapsed time → that's your real RTO for the dev env

Document findings. Promise a realistic RTO in enterprise contracts.
Don't over-commit.

## 15. Tenant model gaps (🟡 P1 — cannot ship v1 without)

### 15.1 RBAC model is underspecified

Part I mentions `tenant_members.role` in passing but doesn't enumerate
roles or permissions. Enterprise buyers expect at minimum:

| Role | Permissions |
|---|---|
| **Owner** | Everything + billing + delete tenant |
| **Admin** | Everything except billing + delete tenant |
| **Publisher** | Create/edit/delete own skills, view all tenant skills |
| **Consumer** | Install + invoke skills, no publish rights |
| **Viewer** | Read-only (audit, reporting) |
| **Billing** | Stripe portal access only (for finance/procurement) |

Each role maps to a permission set. Every mutation endpoint needs to
check permission before executing.

**Required fix:** define the RBAC matrix in v1. ~half day of work.
The check is trivial once the role is stamped on `tenant_members.role`.

### 15.2 No invite workflow

How does a tenant owner add a new user? Part I waves at this. Reality:
- Owner enters email in tenant admin
- System generates a signed invite token (HMAC over email+tenant+expiry)
- Email goes out via Resend from `noreply@agentskilldepot.com`
- Recipient clicks → creates user → joins tenant as specified role
- Invite expires in 7 days, single-use

This is the same shape as the magic-link claim flow from Phase 2.5.
Reuse the crypto + Resend wiring. ~1 day of work.

### 15.3 No seat limit enforcement

Part I §5.1 has `tenants.seatLimit` but no enforcement. When an owner
tries to invite beyond the limit, nothing stops them.

**Required fix:** count `tenant_members` at invite time, reject with
402 Payment Required if over, surface in the admin UI with an upsell
link to Stripe.

### 15.4 No IP allowlisting per tenant

Many enterprise customers require source IP restrictions as a defense
layer (e.g., "only agents running inside our corporate network").

**v1 decision:** include per-tenant IP allowlist as an **optional**
tenant setting. `tenants.allowed_ip_cidrs jsonb`, checked on every
authenticated request. Default: empty = no restriction. ~half day of
work but needs careful testing (don't lock the tenant owner out).

## 16. Commercial & billing gaps (🟡 P1 — revenue path)

### 16.1 Flat seat billing is probably wrong

Part I §5.9 proposes a simple "$X per tenant per month" model with
seat counts tracked on `tenants.seat_limit`. This is the simplest
possible v1 but it misses the roadmap's actual differentiator:
**inter-enterprise licensing with metered billing**.

If the long-term moat is "Enterprise A can license their private
skill portfolio to Enterprise B on a per-invocation basis", then v1
needs to ship with **the metering plumbing** in place, even if the
actual licensing UX is deferred to v2.

**Concrete recommendation:**
- v1 billing: flat per-tenant subscription via Stripe (as proposed)
- v1 **metering**: every `invocations` row also emits a Stripe
  usage record with `tenant_id + skill_id + count=1`. Zero-rate
  in v1 (no cost to the customer) but the meter is running.
- v2 licensing: flip the zero-rate to real pricing per (skill, tier,
  destination_tenant) and launch the licensing marketplace.

Adding the metering hook in v1 is ~1 day of work. Adding it in v2
when we already have paying tenants is a migration project.

### 16.2 No dunning / grace period workflow

"Check `tenants.suspended_at`" is one line. The real workflow is:
1. Stripe webhook `invoice.payment_failed` → set
   `tenants.grace_period_ends_at = now + 7 days`
2. Show a banner in the tenant admin: "Payment failed, please update"
3. Email the billing contact on days 1, 3, 5, 7
4. Day 8: set `tenants.suspended_at`, make the tenant read-only
5. Day 30: tenant is eligible for deletion (but don't auto-delete)

**Not v1-blocking** but must be in the v1 operational runbook.

### 16.3 No per-tenant R2 quota

Enterprise Starter could be 5 GB, Growth 50 GB, Custom unlimited.
Currently there is no R2 quota check at publish time.

**Required fix:** before `putSkill()`, sum `skill_versions.size_bytes`
for the tenant, reject if over quota. Surface in admin UI. ~half day
of work.

## 17. Prioritized fix list for v1

Ordered by "ship-blocker" severity:

| # | Fix | Category | Effort | Blocker for |
|---|---|---|---|---|
| 1 | **Postgres RLS policies** | Security | M | First tenant |
| 2 | **`audit_events` table + append-only** | Security | S | First tenant |
| 3 | **App-layer JWT verification behind Cloudflare Access** | Security | S | First tenant |
| 4 | **RBAC role matrix + enforcement** | Tenancy | S | First tenant |
| 5 | **Tenant invite workflow (reuse Phase 2.5 magic-link)** | Tenancy | M | First tenant |
| 6 | **Tenant-scoped rate limits** | Security | S | First tenant |
| 7 | **SSO via WorkOS or Cloudflare Access IdP** | Security | M–L | First >50-seat tenant |
| 8 | **Skill allowlist (per-tenant operator approval)** | Security | S | First tenant |
| 9 | **Paid Cloudflare + Neon plans for SLA** | Compliance | (cost only) | First tenant |
| 10 | **SOC 2 readiness workstream kicked off** | Compliance | XL (6mo) | Any meaningful enterprise deal |
| 11 | **GDPR deletion workflow** | Compliance | M | First EU tenant |
| 12 | **Metering hooks (zero-rated in v1)** | Commercial | S | v2 licensing launch |
| 13 | **Versioned API policy + `/v1/changelog` endpoint** | Operations | S | First multi-year contract |
| 14 | **Branch protection + signed commits + CI gate** | Operations | S | SOC 2 audit |
| 15 | **Staged deploys (dev env + canary + approval gate)** | Operations | M | First tenant |
| 16 | **DR drill + RTO/RPO documentation** | Operations | M | First enterprise RFP |
| 17 | **Runbooks + paging + synthetic monitoring** | Operations | M | First tenant |
| 18 | **Per-tenant R2 quota + seat limit enforcement** | Tenancy | S | First tenant |
| 19 | **EU region** | Compliance | XL | First EU tenant |
| 20 | **Skill signing + SLSA provenance** | Security | L | v2 |

**Rows 1–9 are the new "v1 scope".** Part I §2 listed a much smaller
set; this is the realistic set.

**Rows 10, 15, 19 are parallel workstreams** that need to start
immediately even though they take months. Beginning SOC 2 preparation
AFTER signing your first enterprise customer is too late.

## 18. Revised effort estimate

Part I §9 said "~3–4 weeks of focused work". With the security +
compliance gaps above, the realistic estimate is:

| Block | Effort |
|---|---|
| Original Part I scope (§5 changes + helper + schema) | ~3 weeks |
| RLS + audit log + JWT verification | ~1 week |
| RBAC + invite flow + rate limiting | ~1 week |
| SSO integration (WorkOS or CF Access IdP) | ~1 week |
| Skill allowlist + quota enforcement | ~1 week |
| Operational hardening (branch protection, CI, staged deploys, monitoring) | ~1 week |
| SOC 2 tooling kickoff (Vanta setup, policy drafting) | ~1 week initial + ongoing |
| **Total to enterprise-v1 ready** | **~8–10 weeks focused work** |

Parallel long-running workstreams (not included above):
- SOC 2 Type I audit preparation: 6 months
- EU region deployment: 4+ weeks
- Full SSO via WorkOS with SAML + SCIM: 2–3 weeks

**Realistic calendar:** ~3 months of focused single-developer work to
reach a "demonstrable enterprise-ready" state, with SOC 2 and EU
region as ongoing parallel efforts that extend the real "can sell
everywhere" date by ~6 months.

## 19. What this means for the go-to-market

If the goal is **"first enterprise customer by end of year"**, then
the path is:

1. **Pick a design partner now.** Someone patient, aligned with our
   vision, and willing to accept a not-yet-SOC-2 vendor in exchange
   for significant discounts / influence on the product. US-based.
2. **Build rows 1–9 from §17** alongside them. ~2 months.
3. **Start SOC 2 readiness in parallel** so the Type I report lands
   just as they roll out to more internal users.
4. **EU + enterprise SSO scale-out** happens after first paid customer
   validates the thesis.

If the goal is **"enterprise-grade from day one, no compromises"**,
that's a 6-month single-developer effort before first tenant. The
design partner path is more realistic for this project's current
stage.

## 20. What to do next (recommendation)

1. **Keep Part I as the technical spec.** The schema, migration, and
   visibility helper work are all sound — don't throw them away.
2. **Treat Part II as the delta between "works in principle" and
   "sells to an enterprise"** — the 20 items in §17 are the missing
   engineering + compliance work.
3. **Before writing any code, pick your design partner.** The specific
   customer's regulatory posture (US vs EU, healthcare or not, SOC 2
   Type I acceptable or need Type II, SSO required on day 1 or not)
   dramatically changes the priority of items 7, 10, 11, 19.
4. **Commit this doc to `main`** so the full analysis is version-
   controlled. Iterate from here as decisions resolve.
5. **Do NOT start building §5 changes until the top 9 items in §17
   have an owner, a deadline, and a budget.** Building the happy-path
   technical work first and bolting security on later is exactly how
   multi-tenant SaaS systems end up with cross-tenant data breaches
   in the news.

---

## Appendix B — what we are NOT changing

- The public-tier experience. Zero behavioral change for existing users.
- The R2 bucket topology. Same bucket, just a prefix on keys.
- The Neon schema for existing tables. Only nullable columns added.
- The cron schedule (mirror / rankings / matview). Mirror skips
  enterprise-visibility skills by default — they never go to the
  public GitHub repo (add a `WHERE visibility != 'enterprise'` clause
  to `mirror-to-github.ts`).
- The Phase 3 admin surface. It stays as-is; tenant routes live
  alongside.
- The challenge enforcement. Unchanged — enterprise agents are
  verified by tenant membership so they're "verified" for the purposes
  of `isNewUnverifiedAgent()`, which makes the challenge moot for them.
