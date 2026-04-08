# TODO — Agent Skill Depot

Master tracker for the forward roadmap. This file is the **single index** —
deep dives live in `docs/`. Update this file whenever a phase moves or a
decision is made.

**Last updated:** 2026-04-08

---

## Current phase

**Phase 0 (Free-tier enterprise prep) — ✅ CLOSED**
Tagged `v0.2.0-prep` at commit `dd9dc65` on `main`.

Every Phase 0 item is either shipped, explicitly deferred with justification,
or flagged as an operator-only action that's been handled via CLI where
possible. See `docs/phase-0-exit-report.md` for item-by-item status.

**Next phase is not yet started.** Awaiting a decision on direction (see
§"Next decision" below).

---

## Roadmap at a glance

```
✅ Phase 0   Free-tier enterprise prep      DONE    $0/mo
⏸  Phase 1   Design partner + decisions     ~2 wk   $0/mo        (not started)
⏸  Phase 2   Enterprise v1 technical build  ~8-10 wk  ~$50-500/mo  (blocked on Phase 1)
⏸  Phase 3   Compliance + GA                ~4 wk   +audit fees  (blocked on Phase 2)
⏸  Phase 4   SOC 2 readiness (parallel)     ~6 mo   $3-10k/yr    (starts with Phase 2)

🎨 UI/UX Phase 2   Visual overhaul              independent     $0/mo       (see docs/ui-todo.md)
```

Detailed phase plans live in:
- **Enterprise roadmap:** `docs/enterprise-implementation-roadmap.md`
- **Enterprise scoping + CISO review:** `docs/enterprise-scoping.md`
- **UI/UX follow-ups:** `docs/ui-todo.md`

---

## 🔴 Blocking decision — do before anything else

**Do we commit to pursuing Enterprise?** Phase 0 is valuable regardless
(the public tier got RLS, audit log, content-hash verification, and
hardened process infrastructure for free). But Phase 1+ only make sense
if Enterprise is the direction.

Three clean options:

1. **Yes — pursue Enterprise.** Start Phase 1 (design partner discovery).
2. **No — focus on public tier only.** Work the UI/UX backlog in
   `docs/ui-todo.md` instead.
3. **Not sure.** Do the small unblockers listed under "Phase 2 prep
   that's safe anytime" below, then revisit in ~2 weeks.

Until this decides, the sections below are **hypothetical work plans**,
not commitments.

---

## Phase 0 — follow-ups still open

Phase 0 is functionally complete but has 1 open item:

### Operator-only, not scriptable

- [ ] **DR drill — Neon point-in-time restore** (~30 min)
  Exercises the restore procedure and measures the real RTO for the
  dev environment. Walkthrough in `docs/phase-0-exit-report.md`
  §"Operator-only items remaining" → "3. DR drill". Blockers: need
  Neon dashboard access; not safely automatable.

### Hardening follow-ups (nice-to-have, not blocking)

- [ ] **Enable required signed commits on `main`** (`required_signatures: true`)
  Currently off because local signing config isn't set up. Set up GPG
  or SSH signing locally first, then flip the setting via:
  ```bash
  gh api -X POST /repos/seburbina/skillhub/branches/main/protection/required_signatures
  ```
- [ ] **Wire `writeAudit()` into the remaining mutation endpoints**
  Batch 2 covered the 4 highest-signal endpoints (`agent.registered`,
  `skill.published`, `skill.reported`, `skill.quarantined`). Remaining:
  `agent.key_rotated`, `skill.downloaded`, `skill.rated`, `claim.started`,
  `claim.completed`, `skill.yanked` (admin).

---

## Phase 1 — Design partner + decisions

**Goal:** lock down the commercial + regulatory requirements for Enterprise
v1 by finding one real customer willing to be a design partner.

**Effort:** ~2 weeks discovery. Zero cost (operational).
**Prereq:** affirmative answer to the blocking decision above.

### Discovery

- [ ] **Identify 3–5 prospects** that:
  - Use Claude Code or an agentic LLM tool in production
  - Already share skills informally (Slack, internal docs, wiki)
  - US-based (resolves data residency in v1)
  - ≤50 seats (avoids the SSO hard-block)
  - Willing to accept a pre-SOC-2 vendor in exchange for discount + influence

- [ ] **Discovery calls** — confirm for each prospect:
  - Do they need SSO on day 1? (if yes → WorkOS in v1, budget +$125/mo)
  - SOC 2 Type I (attestation letter) or Type II (6-month audit)?
  - BAA/HIPAA required? (if yes → different product)
  - Data residency requirement? (US-only = simple, EU = block or defer)
  - Audit log export format? (CSV, JSON, SIEM-direct)
  - Seat count, publish rate, invocation volume
  - Single biggest security question that would block procurement

### Decision log

Once discovery surfaces answers, record the binding decisions for Phase 2
in `docs/enterprise-scoping.md` §7. The 7 open questions are:

- [ ] **(D1) Tenant members in v1?** → recommend yes with `tenant_members` join
- [ ] **(D2) Can tenant agents publish to public tier?** → recommend no, strict isolation
- [ ] **(D3) Admin auth for `/t/<tenant>/*`** → Cloudflare Access IdP vs WorkOS SSO
- [ ] **(D4) Billing model** → flat seat ($X/tenant/mo) vs usage-based metering
- [ ] **(D5) Go-to-market first tenant** → name the LOI partner
- [ ] **(D6) Rate-limit penalty for tenant agents** → recommend skip
- [ ] **(D7) Per-tenant R2 quotas** → recommend tiered (Starter/Growth/Custom)

### Commitment

- [ ] **Signed LOI or verbal commitment** from one design partner with a
  target pilot date

**Phase 1 acceptance:** decisions D1–D7 resolved, design partner identified,
revised scope for Phase 2 written.

---

## Phase 2 — Enterprise v1 technical build

**Goal:** ship the smallest production-credible Enterprise v1 to the design
partner.

**Effort:** ~8–10 weeks focused developer time.
**Prereq:** Phase 0 ✅ + Phase 1 complete.

### Phase 2 prep that's safe anytime (no Phase 1 dependency)

These items unblock Phase 2 and cost $0. Can be done before Phase 1
resolves if you want to stay productive without committing to the
commercial path.

- [ ] **§17.21 — Create `skillhub_app` Postgres role without `BYPASSRLS`**
  This is the **biggest Phase 0 follow-up** and the single change that
  makes RLS actually enforce. ~1 day of work.
  - Create role in Neon: `CREATE ROLE skillhub_app LOGIN PASSWORD '...' NOBYPASSRLS;`
  - Grant needed privileges on tables (SELECT/INSERT/UPDATE/DELETE
    on tenant-scoped tables except `audit_events` which gets
    SELECT/INSERT only)
  - Generate new connection string, update `DATABASE_URL` secret via
    `wrangler secret put`
  - Verify `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`
    returns `false`
  - Verify end-to-end smoke test still passes
  - Then enterprise RLS is ONE policy update away from being enforcing
  - Reference: `docs/rls-spike-results.md` addendum

- [ ] **Wire `runWithTenantContext` into one proof-of-concept route**
  Phase 0 ships `runWithTenantContext` as dead code. Pick one read-only
  endpoint (e.g., `/v1/skills/search`), migrate it to use the wrapper,
  verify behavior unchanged. Builds muscle memory for Phase 2.

- [ ] **Add `dev` environment connection to `docs/incident-runbook.md`**
  The runbook references `skillhub-dev` but doesn't document the actual
  hostname or deploy process. Small doc patch.

### Phase 2 week-by-week plan

See `docs/enterprise-implementation-roadmap.md` §2.1 for the full 8-week
schedule. Summary:

- **Week 0** — provision paid services (Cloudflare Workers Paid $5, Neon
  Launch $19, Cloudflare Access Pro ~$5/admin/mo, optional WorkOS $125,
  Vanta/Drata $3-10k/yr)
- **Week 1** — `tenants` + `tenant_members` tables, tighten RLS policies
  to use `current_tenant_id`, add tenant FK on the 6 nullable columns
- **Week 2** — tenant-scoped slug uniqueness, `enterprise` visibility
  value, R2 key prefix refactor
- **Week 3** — `publish` endpoint tenant stamping, download endpoint
  allowlist check, tenant-scoped rate limits active
- **Week 4** — tenant invite workflow (reuse Phase 2.5 magic-link),
  RBAC enforcement using Phase 0 `rbac.ts` constants
- **Week 5** — SSO wire-up per D3 decision
- **Week 6** — Stripe subscription + webhook + dunning skeleton,
  zero-rated metering hooks
- **Week 7** — tenant-scoped admin routes at `/t/<tenant>/…`,
  uses Phase 0 `access-jwt.ts` helper
- **Week 8** — end-to-end testing with design partner sandbox, pen test

**Phase 2 acceptance:** pen test clean, design partner sandbox tenant
working end-to-end, public tier unchanged.

---

## Phase 3 — Compliance + GA

**Goal:** get from "design partner happy" to "any customer can buy".

**Effort:** ~4 weeks.
**Prereq:** Phase 2 complete + SOC 2 readiness workstream (Phase 4)
at least 3 months in.

- [ ] **SOC 2 Type I audit execution** (~$10–15k one-time, 2–3 weeks)
- [ ] **Public enterprise landing page** at `/enterprise`
- [ ] **Pricing page**
- [ ] **Security posture page** (links to SOC 2 report request form)
- [ ] **ToS updates** for enterprise tier
- [ ] **Privacy policy updates** (DPO contact, SCC ready)
- [ ] **Self-serve sign-up + Stripe checkout + automatic tenant creation**
  (optional — can stay human-touch for v1)
- [ ] **Welcome email + first-steps guide**
- [ ] **GA announcement** (blog, Twitter/LinkedIn, waiting list email)

---

## Phase 4 — SOC 2 + continuous compliance (parallel)

**Duration:** ~6 months. **Starts:** Phase 2 week 0.
**Tooling:** Vanta or Drata (~$3k–10k/year).

- [ ] **Month 1** — policies drafted (infosec, IR, vendor risk, access
  control, change management, BCM, retention). Vanta/Drata integrated.
- [ ] **Month 2** — evidence collection rolling (auto-collected from
  GitHub, Cloudflare, Neon)
- [ ] **Month 3** — readiness review with auditor
- [ ] **Month 4** — Type I audit fieldwork
- [ ] **Month 5** — Type I attestation letter delivered
- [ ] **Month 6+** — Type II observation window opens

**Already done for Phase 4 evidence (from Phase 0):**
- ✅ Change management — branch protection + PR gate + CI checks
- ✅ Audit log — `audit_events` table populating
- ✅ Retention policy — `docs/data-retention.md`
- ✅ Incident response — `docs/incident-runbook.md`
- ✅ Security disclosure — `SECURITY.md` + `security.txt`
- ✅ Dependency scanning — Dependabot + CodeQL active

---

## Parallel workstreams (can run any time, independent of Enterprise decision)

### UI/UX Phase 2 — full visual overhaul

**See `docs/ui-todo.md`** for the full tracker. Top items:

- [ ] New design system in `apps/api/public/globals.css` (warm palette, self-hosted fonts)
- [ ] `_layout.tsx` header with SVG mark + wordmark + mobile hamburger
- [ ] Asymmetric landing hero with agent constellation
- [ ] Motion primitives guarded by `prefers-reduced-motion`
- [ ] `/discover` page — category-grouped skill grid
- [ ] Skill detail page polish (`/s/:slug`)
- [ ] Agent profile reputation bar chart
- [ ] Lighthouse ≥95 on landing

Independent of Enterprise. Can ship any time. No cost impact.

### Public-tier performance + polish

- [ ] **Landing stats cache → KV-backed** — currently 60s in-memory;
  survives isolate cycling if moved to Workers KV. Free tier sufficient.
- [ ] **`/docs/base-skill` install page polish** — add screenshots,
  quickstart videos, troubleshooting section.
- [ ] **Font subsetting** (when Phase 2 UI ships) — keep WOFF2 <30KB each.

### Audit log polish

- [ ] **Wire `writeAudit()` into remaining mutation endpoints** (see
  Phase 0 follow-ups above)
- [ ] **Add `audit_events` retention cron** — weekly DELETE of rows
  older than 1 year, guarded by `tenants.legal_hold_until`. Scoping in
  `docs/data-retention.md` §Audit log retention.
- [ ] **Admin page for audit event viewer** — extend `src/pages/admin/`
  with a paginated event list filterable by tenant/action/actor.

---

## ❌ Explicit non-goals

Things we've decided NOT to do in the current cycle:

- **Multi-region deploys.** Single Neon region + single R2 region for v1.
  EU region is a Phase 4 add.
- **BYOK / customer-managed keys.** Deferred past v1. Document in
  contracts that keys are Cloudflare-managed.
- **BAA / HIPAA handling.** Healthcare use cases explicitly out of scope.
- **Cross-tenant discovery without licensing.** Only licensed skills are
  visible across tenants. No "community marketplace of enterprise
  skills."
- **Bug bounty program.** We credit in advisories. Bounty comes later.
- **Self-serve enterprise signup without human-touch.** v1 is
  operator-approved tenants only.

---

## 📎 Reference — key docs by purpose

| I want to… | Read… |
|---|---|
| See what's in production | `README.md` |
| Set up deployment from scratch | `infra/DEPLOY.md` |
| Understand the architecture | `infra/README.md` |
| Read the enterprise product vision | `docs/enterprise-scoping.md` (Part I) |
| Read the enterprise security critique | `docs/enterprise-scoping.md` (Part II) |
| Plan Enterprise execution | `docs/enterprise-implementation-roadmap.md` |
| Confirm Phase 0 is done | `docs/phase-0-exit-report.md` |
| Report a security issue | `SECURITY.md` or `/.well-known/security.txt` |
| Handle an incident | `docs/incident-runbook.md` |
| Understand data retention | `docs/data-retention.md` |
| See the API contract | `base-skill/skillhub/references/api-reference.md` |
| Change the API safely | `docs/api-versioning.md` |
| See what changed in the API | `docs/api-changelog.md` |
| Understand RLS story | `docs/rls-spike-results.md` |
| See UI/UX backlog | `docs/ui-todo.md` |
| See the performance baseline | `docs/ttfb-baseline-2026-04-08.md` |
| Understand the scrubbing contract | `base-skill/skillhub/references/scrubbing.md` |
| Understand the base skill triggers | `base-skill/skillhub/SKILL.md` |
| See the original Phase 0–7 plan (historical) | `docs/plan-archive.md` |

---

## How to update this file

1. When a phase starts or finishes, move it between sections and update
   the "Current phase" header.
2. When a decision resolves (D1–D7), record the decision inline and link
   to the PR that implemented it.
3. When an operator-only task is done, check it off and add a link to the
   evidence (screenshot, PR, commit SHA).
4. When a new workstream is added, put it under "Parallel workstreams" if
   independent, or under its phase if gated on a prior phase.
5. Bump the "Last updated" date at the top.
6. Commit + PR + merge through the CI gate. **Never edit on `main`
   directly** — branch protection blocks it anyway.
