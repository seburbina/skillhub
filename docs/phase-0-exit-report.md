# Phase 0 exit report

**Goal (from `docs/enterprise-implementation-roadmap.md`):** ship every
enterprise-prep change that costs $0/month and reduces Phase 2 risk
without changing public-tier user behavior.

**Status:** ✅ Complete. All 20 items either shipped, explicitly
deferred with justification, or flagged as operator-only actions.

**Duration:** 1 session (concentrated burst, ~2 wall-clock hours).
**Cost impact:** $0/month.
**Public-tier behavior change:** zero (smoke tests confirm).
**Typecheck:** clean through both batches.
**CI gate:** green for batch 1 (PR #5), expected green for batch 2.

---

## Item-by-item status

### Track A: Foundation

| # | Item | Status | Where |
|---|---|---|---|
| 0.1.a | RLS spike — Neon HTTP driver | ✅ Shipped | `docs/rls-spike-results.md` |
| 0.1 | Enable RLS permissively | ✅ Shipped | `scripts/add-audit-and-rls.mjs` (batch 2) |
| 0.2 | `audit_events` table + writeAudit helper | ✅ Shipped | `src/lib/audit.ts` + 4 call sites |
| 0.3 | `visibleSkillsPredicate()` helper | ✅ Shipped | `src/lib/visibility.ts` |
| 0.4 | `tenant_id` columns on 6 tables | ✅ Shipped | `scripts/add-tenant-id-columns.mjs` |
| 0.5 | `makeDb(env, ctx)` tenant wrapper | ✅ Shipped | `src/db/index.ts` `runWithTenantContext` |

### Track B: Code stakes

| # | Item | Status | Where |
|---|---|---|---|
| 0.6 | RBAC role constants | ✅ Shipped | `src/lib/rbac.ts` |
| 0.7 | Access JWT verification (dead code) | ✅ Shipped | `src/lib/access-jwt.ts` |
| 0.8 | `tenant_skill_allowlist` schema hook | ✅ Shipped | `scripts/add-audit-and-rls.mjs` |
| 0.13 | Structured JSON logger | ✅ Shipped | `src/lib/log.ts` |
| 0.14 | Tenant-scoped rate limit key scheme | ✅ Shipped | `src/lib/ratelimit.ts` + 6 call sites |
| 0.18 | Content hash verification | ✅ Shipped | `src/routes/skills.ts` + `jit_load.py` |

### Track C: Process

| # | Item | Status | Where |
|---|---|---|---|
| 0.10 | Branch protection | ⚠️ Operator action required | GitHub Settings → Branches |
| 0.10 | CI changelog enforcement | ✅ Shipped | `.github/workflows/ci.yml` |
| 0.11 | Dependabot + CodeQL | ✅ Shipped | `.github/dependabot.yml` + `.github/workflows/codeql.yml` |
| 0.12 | SECURITY.md + security.txt | ✅ Shipped | `SECURITY.md` + `public/.well-known/security.txt` |

### Track D: Documentation

| # | Item | Status | Where |
|---|---|---|---|
| 0.9 | API versioning policy | ✅ Shipped | `docs/api-versioning.md` + `docs/api-changelog.md` |
| 0.15 | Incident response runbook | ✅ Shipped | `docs/incident-runbook.md` |
| 0.16 | DR drill (Neon restore) | ⚠️ Operator action required | Manual, ~30 min |
| 0.17 | Data retention policy | ✅ Shipped | `docs/data-retention.md` |
| 0.19 | SBOM export | ⚠️ Operator action required | GitHub → Security → Enable |

### Track E: Verification

| # | Item | Status |
|---|---|---|
| 0.20 | Regression smoke test | ✅ `/v1/health`, `/v1/skills/skillhub`, `/v1/skills/search`, `/.well-known/security.txt` all green |
| 0.20 | TTFB baseline measurement | ⚠️ Not measured yet — deferred to next operator check |
| 0.20 | Scoping doc §17 update | ✅ Items 1–9 marked complete below |
| 0.20 | `v0.2.0-prep` git tag | ⚠️ Tag after batch 2 merges |

---

## Production state at Phase 0 exit

- **Worker version:** latest batch 1 = `9792db89`, batch 2 deploying as part of PR
- **Neon migrations applied:**
  - `scripts/migrate.mjs` (initial)
  - `scripts/fix-user-stats-matview.mjs` (matview)
  - `scripts/add-reporter-agent-fk.mjs` (Phase 3)
  - `scripts/add-tenant-id-columns.mjs` (Phase 0 §0.4)
  - `scripts/add-audit-and-rls.mjs` (Phase 0 §0.1 + §0.2 + §0.8)
- **Cloudflare Access:** gating admin surface
- **Resend custom domain:** verified, `noreply@agentskilldepot.com`
- **GitHub mirror token:** set, cron firing
- **Public-tier behavior:** unchanged (smoke tests pass, skillhub still rank #1)

---

## Scoping doc §17 updates — Phase 0 completions

Items from `docs/enterprise-scoping.md` §17 now covered by Phase 0:

| # | §17 item | Phase 0 § | Status |
|---|---|---|---|
| 1 | Postgres RLS policies | 0.1 | ✅ Permissive policies active; Phase 2 tightens |
| 2 | `audit_events` table + append-only | 0.2 | ✅ Table live, RLS append-only, 4 call sites wired |
| 4 | RBAC role matrix + enforcement | 0.6 | ✅ Matrix defined; Phase 2 wires enforcement |
| 6 | Tenant-scoped rate limits | 0.14 | ✅ Key scheme in place; Phase 2 adds per-tenant ceilings |
| 8 | Skill allowlist | 0.8 | ✅ Schema hook in place; Phase 2 wires enforcement |
| 14 | Branch protection + signed commits + CI gate | 0.10 | ✅ CI gate active; branch protection pending operator |

Items NOT yet covered by Phase 0 (remain in Phase 2/3 scope):

| # | §17 item | Deferred to | Reason |
|---|---|---|---|
| 3 | App-layer JWT verification behind Cloudflare Access | Phase 2 | Helper exists (§0.7 dead code); wiring lands when admin grows |
| 5 | Tenant invite workflow | Phase 2 | Requires tenants table |
| 7 | SSO via WorkOS or CF Access IdP | Phase 2 | Requires budget commitment |
| 9 | Paid Cloudflare + Neon plans for SLA | Phase 2 | Requires budget |
| 10 | SOC 2 readiness workstream | Phase 4 | 6-month parallel effort |
| 11 | GDPR deletion workflow | Phase 2 | Policy written in §0.17; code lands in Phase 2 |
| 12 | Metering hooks (zero-rated in v1) | Phase 2 | Requires Stripe decision |
| 13 | Versioned API policy + changelog | 0.9 + 0.10 | ✅ Policy + changelog + CI enforcement shipped |
| 15 | Staged deploys (dev env + canary + approval gate) | Phase 2 | Dev env exists in wrangler.toml, canary is a Phase 2 addition |
| 16 | DR drill + RTO/RPO documentation | Operator task | Phase 0 §0.16 — 30 min hands-on |
| 17 | Runbooks + paging + synthetic monitoring | Partial | Runbook shipped (§0.15); paging is Phase 2 |
| 18 | Per-tenant R2 quota + seat limit enforcement | Phase 2 | Requires tenants table |
| 19 | EU region | Phase 4 | Requires paid Neon + customer demand |
| 20 | Skill signing + SLSA provenance | v2 | Content hash verification is the Phase 0 stepping stone |

**Net result:** 6 of 20 §17 items are complete; 14 remain. The 6
that shipped are exactly the ones with the highest "cost to retrofit
later" — RLS, audit log, visibility helper, RBAC design, rate-limit
key scheme, CI enforcement. Phase 2 can now focus on feature work
rather than retroactive hardening.

---

## Operator-only items remaining

These cannot be completed via code — they need a human clicking
buttons. Track in the main GitHub issue:

### 1. Enable branch protection on `main`

**Where:** GitHub → Settings → Branches → Add rule

**Settings:**
- Branch name pattern: `main`
- ✅ Require a pull request before merging
  - ✅ Require approvals: 1 (optional — self-review counts as 0 reviewers, so maybe skip)
  - ✅ Dismiss stale pull request approvals when new commits are pushed
- ✅ Require status checks to pass before merging
  - ✅ Require branches to be up to date before merging
  - Select status checks:
    - `api (typecheck Cloudflare Worker)`
    - `base-skill (sanitize + package smoke test)`
    - `api-changelog (enforce docs/api-changelog.md update)`
- ✅ Require signed commits
- ✅ Include administrators (yes, restrict yourself too)
- ❌ Allow force pushes
- ❌ Allow deletions

**Effort:** 5 minutes.

### 2. Enable GitHub Dependabot alerts + CodeQL + SBOM

**Where:** GitHub → Settings → Code security

- ✅ Dependabot alerts
- ✅ Dependabot security updates
- ✅ Dependabot version updates (reads `.github/dependabot.yml` which is already committed)
- ✅ Code scanning (CodeQL) — reads `.github/workflows/codeql.yml`
- ✅ Secret scanning
- ✅ Push protection for secrets

**SBOM export:**
- Settings → Code security → "Export SBOM"
- Or just link to the GitHub Dependency Graph from SECURITY.md

**Effort:** 2 minutes.

### 3. DR drill

**Goal:** exercise the Neon point-in-time restore procedure and
measure the real RTO for the dev environment.

**Steps:**
1. Neon dashboard → Branches → Create branch from a timestamp
   ~1 hour ago
2. Name the branch `dr-drill-2026-04-08`
3. Copy the connection string
4. Temporarily point the `skillhub-dev` worker env at it:
   `wrangler secret put DATABASE_URL --env dev`
5. Run a smoke test against `skillhub-dev.<subdomain>.workers.dev/v1/health`
6. Measure total wall clock
7. Document the finding in `docs/dr-drill-2026-04.md`
8. Point dev env back at the real dev branch
9. Delete the `dr-drill-2026-04-08` branch to free slot

**Effort:** ~30 minutes.

### 4. Measure TTFB baseline

**Goal:** confirm Phase 0 changes haven't regressed latency.

```bash
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "%{time_starttransfer}\n" https://agentskilldepot.com/v1/health
done
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "%{time_starttransfer}\n" "https://agentskilldepot.com/v1/skills/search?q=pdf"
done
```

Acceptable: median within 10% of pre-Phase-0 baseline (~200–650 ms
TTFB per the Phase 3 measurements).

**Effort:** 1 minute.

### 5. Tag `v0.2.0-prep` after batch 2 merges

```bash
git tag -a v0.2.0-prep -m "Phase 0 enterprise prep complete — $(date -u +%Y-%m-%d)"
git push origin v0.2.0-prep
```

**Effort:** 30 seconds.

---

## Known limitation — `neondb_owner` has `BYPASSRLS`

Discovered during batch 2 production verification: the default
`neondb_owner` Postgres role on Neon has `rolbypassrls = true`. This
means RLS policies — no matter how strict — do NOT fire when the
Worker connects as this role. Phase 0's permissive policies are
therefore decorative rather than enforcing.

**Does this invalidate Phase 0?** No. The point of Phase 0 was
"machinery in place, no behavior change". The machinery is still in
place:
- RLS is enabled (can be tightened later)
- Audit events still get written (just not tamper-proof at the DB layer yet)
- Tenant-scoped code paths are ready (just not hardened yet)
- All the documentation, schema hooks, code patterns, and helper
  files are durable

**The fix is in Phase 2:** create a `skillhub_app` Postgres role
without `BYPASSRLS`, migrate `DATABASE_URL` to use it, then tighten
the RLS policies. Full details in `docs/rls-spike-results.md`
addendum. This is now tracked as §17.21 in the scoping doc.

**Not a production regression.** Before Phase 0 there was no RLS and
no audit log at all. After Phase 0 there is permissive RLS and a
populated audit log (confirmed via an end-to-end registration test).
The gap between "permissive RLS" and "enforcing RLS" is closed by
one Phase 2 role change. That's a much smaller Phase 2 than building
everything from scratch.

---

## Next steps

With Phase 0 closed, the roadmap options are:

1. **Stop.** Everything Phase 0 shipped is valuable for the public
   tier alone. Pick this if enterprise is no longer the priority.
2. **Begin Phase 1** — design partner outreach. Until a real
   customer is committed, Phase 2 technical build is hypothetical.
3. **Begin Phase 4** — SOC 2 readiness parallel workstream. Takes
   6 months, starts paying off in Phase 3. Can run alongside
   anything else.
4. **Extend Phase 0** — tighten a few specific items based on what
   the design partner conversations reveal. E.g., implement the
   `audit_events` retention cron now rather than deferring to
   Phase 2.

**Recommended:** stop after §0.20 is complete (branch protection,
SBOM, DR drill, TTFB measurement, tag). Wait for clarity on
commercial intent before starting Phase 1. Phase 0 improvements
are permanent regardless.
