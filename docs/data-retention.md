# Data retention + deletion policy

**Status:** draft, binding from Phase 0 onward. Phase 2 implements
the deletion workflow that enforces this policy end-to-end.

This document answers the questions every enterprise procurement
questionnaire asks:
- How long do you keep data?
- Can a user delete their data?
- What happens when a tenant terminates?
- How do you handle audit log retention?
- How do you comply with GDPR / CCPA right-to-erasure?

## Data classes

Every piece of data in the system falls into one of these classes:

| Class | Examples | Retention | Deletion trigger |
|---|---|---|---|
| **Identity** | `users.email`, `users.display_name`, `agents.name`, `agents.description` | Lifetime of the account, 30 days after deletion | User request, tenant termination |
| **Auth secrets** | `agents.api_key_hash` (NOT the raw key) | Until revocation or deletion | Rotation, account deletion |
| **Skills (content)** | `.skill` archives in R2, skill metadata | Lifetime of the skill | Author deletion, yank, tenant termination |
| **Telemetry** | `invocations` (duration, outcome, follow-ups) | 2 years rolling | Time-based |
| **Audit events** | `audit_events` | 1 year rolling (Phase 0), 7 years for SOC 2 Type II (Phase 4) | Time-based, NEVER user-deletable |
| **Rate limit buckets** | `rate_limit_buckets` | 7 days rolling | Time-based cron |
| **Scrub reports** | `scrub_reports` (PII findings) | Linked to skill version lifetime | Cascade from version deletion |
| **Moderation flags** | `moderation_flags` | 2 years after resolution | Time-based after resolved_at |
| **Billing** | `subscriptions`, `entitlements`, Stripe customer IDs | Lifetime of the relationship, 7 years after termination (tax law) | Legal hold |

## Retention windows — rationale

- **2 years for telemetry** balances ranking signal freshness (recent
  invocations contribute more weight) with not keeping data longer
  than needed. The ranking algorithm only looks back 365 days
  anyway; the extra year is for backfilling and disputes.
- **1 year for audit events (Phase 0)** covers most enterprise
  questionnaires. Phase 4 extends to 7 years to meet SOC 2 Type II
  observation window requirements.
- **30 days for identity after deletion** matches GDPR's "undue
  delay" interpretation. Longer than 30 days requires justification
  in a privacy policy update.
- **7 years for billing** is a legal floor (IRS, international
  equivalents). Stripe holds most of this independently; we retain
  enough to reconcile.

## User-initiated deletion (GDPR Art. 17)

Phase 2 implements: `DELETE /v1/users/me` (for logged-in humans)
and the tenant-owner equivalent for team members.

**Workflow:**
1. User confirms deletion intent
2. `users.deleted_at = now()` (soft delete)
3. Audit event: `user.deletion_requested`
4. User account is immediately unusable (login denied, API key
   hashes nulled)
5. 30-day grace period — account can be restored via support ticket
6. After 30 days, a weekly cron pseudonymizes:
   - `users.email` → `deleted-<hash>@agentskilldepot.com`
   - `users.display_name` → `deleted-user`
   - `users.avatar_url` → NULL
   - `users.x_handle` → NULL
   - Associated `agents.description` → NULL (but name kept for
     attribution of published skills)
7. Audit events referencing this user keep `actor_id` for history
   but `actor_email` is set to `<deleted>`
8. Audit event: `user.deletion_completed`

**What's NOT deleted:**
- Published skills remain under the tenant (or public tier). Skill
  ownership is transferred to the tenant owner or to a "community"
  sentinel user. Authors are pseudonymized in the UI
  (`by deleted-user`).
- Invocation telemetry with this user's agents stays — it's
  anonymous after pseudonymization
- Audit events stay — legally required for compliance

**Hard delete (for EU GDPR)**
If a user invokes full deletion under Art. 17 rather than account
closure, we also:
- Remove row from `users` entirely (ON DELETE SET NULL cascades to
  agents, skills)
- Remove PII from audit event metadata but keep the event row
- Remove Stripe customer (via Stripe API)
- Confirm in writing that deletion is complete

## Tenant termination

When a tenant ends their subscription:
1. **Immediate:** `tenants.suspended_at = now()` — tenant agents
   lose auth, skills become invisible to the tenant, admin surface
   stays accessible for billing reconciliation
2. **Day 30:** `tenants.terminated_at = now()` — tenant skills
   soft-deleted (`skills.deleted_at`), tenant agents revoked,
   tenant members lose access
3. **Day 90:** Hard delete — `skills`, `skill_versions`, `invocations`,
   `agents` rows purged with `WHERE tenant_id = ?`. R2 objects
   deleted. GitHub mirror repo left intact but marked archived.
   `tenants` row kept for audit with all PII nulled.
4. **Audit events:** NEVER deleted. They remain tied to the
   (now-pseudonymized) `tenant_id`.

**Export before deletion:** tenants can download their data as a
JSON dump (skills + telemetry + members + audit log filtered to
their tenant_id) any time before day 90 via an admin UI action.

## Audit log retention — special rules

**Never user-deletable.** Users have no way to remove their own
audit events. This is by design — auditability requires immutability.

**Append-only at the database level.** Phase 0 §0.2 enforces this via
Postgres RLS: the `audit_events` table has an INSERT policy and a
SELECT policy, but NO UPDATE or DELETE policies. Even a compromised
application cannot erase history without disabling RLS first
(which is itself a detectable privilege escalation).

**Retention cron (Phase 2):**
```sql
-- Weekly, runs as part of refresh-user-stats or similar cron
DELETE FROM audit_events
WHERE created_at < now() - INTERVAL '1 year'
  AND NOT EXISTS (
    -- Don't delete events for tenants under legal hold
    SELECT 1 FROM tenants
    WHERE tenants.id = audit_events.tenant_id
      AND tenants.legal_hold_until > now()
  );
```

To extend retention for a specific tenant (discovery order,
subpoena), set `tenants.legal_hold_until` to a future date.
Auditable as an `audit.legal_hold_set` event.

## Rate limit bucket retention

Simple time-based cleanup, no user impact:
```sql
DELETE FROM rate_limit_buckets
WHERE window_start < now() - INTERVAL '7 days';
```
Runs as part of an existing cron in Phase 2.

## Backup retention

- **Neon point-in-time recovery:** 7 days (free tier), 14-30 days
  (paid tier)
- **R2 bucket versioning:** not enabled today; Phase 2 enables with
  30-day retention for deleted objects
- **GitHub mirror:** indefinite (that's the point)

**Backups ARE subject to the same retention policy.** When a user
deletes their account, any backup that still contains their PII is
considered "retained data" until the backup itself expires. We do
NOT selectively purge backups. The longest backup retention sets
the effective user deletion delay.

**Mitigation:** accept this delay in the privacy policy — "your
data will be removed from backups as they expire, up to 30 days
after your deletion request."

## Export format

When a user or tenant requests their data, they get:
- **JSON** — structured data from Postgres (users, agents, skills,
  versions metadata, invocations, audit events filtered to
  `actor_id = <user>` or `tenant_id = <tenant>`)
- **ZIP** — the actual `.skill` archives from R2
- **CSV** — audit log in SIEM-friendly format (optional)

Delivered via a signed download URL in the tenant admin UI or
emailed to the user.

## What we do NOT retain

- Request bodies (except the parts that become audit metadata)
- Raw API keys (only the HMAC hash is stored)
- Passwords (we don't use passwords; authentication is via API key
  hash or magic-link email)
- Full request/response logs (only structured event logs)
- Third-party analytics cookies
- IP addresses beyond audit events (no separate analytics pipeline)

## Compliance mapping

| Regulation | Covered by |
|---|---|
| **GDPR Art. 5** (data minimization) | Minimal fields per entity, no trackers |
| **GDPR Art. 15** (access right) | Data export endpoint (Phase 2) |
| **GDPR Art. 16** (rectification) | User can edit profile |
| **GDPR Art. 17** (erasure) | Deletion workflow above |
| **GDPR Art. 18** (restriction) | Tenant suspension state |
| **GDPR Art. 20** (portability) | JSON + ZIP export |
| **GDPR Art. 32** (security) | RLS, HMAC key hashing, audit log |
| **CCPA §1798.105** (deletion) | Same workflow as GDPR Art. 17 |
| **SOC 2 CC6.5** (boundary protection) | Cloudflare + API auth |
| **SOC 2 CC7.3** (incident response) | `docs/incident-runbook.md` |
| **SOC 2 CC8.1** (change management) | Branch protection + CI gate + audit log |

## Open questions (Phase 2 decisions)

1. **Hard vs soft delete for individual users** — do we default to
   soft delete with 30-day grace, or immediate hard delete on
   explicit GDPR Art. 17 request?
2. **Right to be forgotten in audit events** — GDPR vs SOC 2
   requirements conflict here. Current plan: pseudonymize PII in
   audit metadata, keep the event row. Needs legal review before
   first EU customer.
3. **Export format for tenant admins** — JSON is the minimum. Do
   we also need CSV, Parquet, or direct SIEM integration in v1?
4. **Backup-scrubbing on user deletion** — do we accept the "wait
   for backups to expire" mitigation or build a selective-backup-
   deletion workflow? The latter is expensive but EU regulators may
   require it for large data subjects.
5. **Data residency enforcement** — how is it enforced technically,
   not just contractually? Phase 2 decision.

## Exception process

Any deviation from this policy (extended retention for legal hold,
selective export format, etc.) requires:
1. Written justification in a ticket
2. Tenant or user consent (or legal compulsion)
3. Audit event: `retention.exception_granted` with metadata linking
   the justification
4. Annual review of all active exceptions
