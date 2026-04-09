# Incident response runbook

**When to use this:** something is wrong with production and you need
to act. This document replaces guessing with tested procedures.

Phase 0 §0.15 — written calm, used under pressure.

---

## Severity levels

| Level | Examples | First-response time |
|---|---|---|
| **SEV-1** | Site down, active data loss, active attack, cross-tenant leak, credential exposure | Immediate |
| **SEV-2** | Major feature broken (publish fails, search returns nothing, admin locked out), no data loss | <1 hour |
| **SEV-3** | Minor degradation with workaround, isolated user reports | <1 day |
| **SEV-4** | Cosmetic, observation without user impact | Next sprint |

When in doubt, call it one level higher and reclassify later.

---

## First 5 minutes — triage (any severity)

1. **Acknowledge.** Write down the time. Everything below has a
   timestamp associated with it for the postmortem.
2. **Check `/v1/health`:**
   ```bash
   curl -sS https://agentskilldepot.com/v1/health | jq
   ```
   - Returns `{"status":"ok"...}` → Worker is alive
   - 502/503/timeout → Worker is down or Cloudflare is having an issue
   - Returns but with unexpected fields → deploy corruption
3. **Check `wrangler tail`:**
   ```bash
   cd apps/api && ./node_modules/.bin/wrangler tail
   ```
   Watch for `[onError]`, error-level logs, unusual cron output.
4. **Check the Cloudflare dashboard:**
   - Workers → skillhub → Metrics (errors, CPU, memory)
   - R2 → skillhub-skills-prod (request errors)
   - DNS → agentskilldepot.com (propagation issues)
5. **Check the Neon dashboard:**
   - Branches → production → status
   - Metrics (connections, compute hours, storage)
6. **Check upstream status pages:**
   - <https://www.cloudflarestatus.com>
   - <https://status.neon.tech>
   - <https://status.resend.com>
   - <https://status.voyageai.com>

If the upstream is down, you're waiting. Post a status update,
subscribe to their incident page, and move to Section "Waiting on
upstream" below.

---

## Common procedures

### Rollback the Worker (SEV-1, last-resort)

`wrangler rollback` returns the Worker to its previous version.
Instant, idempotent, safe.

```bash
cd apps/api
./node_modules/.bin/wrangler rollback
```

When to use: a deploy just shipped and broke production. Rollback
first, debug afterward. Minimize user impact.

### Rollback is dangerous when

- The rollback target depends on a schema version that no longer
  exists (e.g., you deployed schema change + code change in one PR,
  rolled back the code, but the schema is still migrated). In that
  case, also apply the reverse migration (if you have one) or
  re-deploy forward after a quick fix.
- The rollback target has a secret the current version doesn't
  (e.g., you rotated a secret between deploys). Re-set any dependent
  secrets first.

### Inspect recent deployments

```bash
cd apps/api
./node_modules/.bin/wrangler deployments list
```

Each entry has a version ID. `wrangler rollback <version-id>` can
target a specific earlier version.

### View live logs

```bash
cd apps/api
./node_modules/.bin/wrangler tail                 # human-readable
./node_modules/.bin/wrangler tail --format json   # structured
./node_modules/.bin/wrangler tail --search "tenant_id"  # filter
```

Logs include structured JSON lines from Phase 0 §0.13 with
`tenant_id`, `event`, `level`, and timing. Pipe to `jq` for
filtering.

### Check database health

```bash
export DATABASE_URL="$(python3 -c "
from pathlib import Path
for l in (Path.home()/'.config/skillhub/secrets.env').read_text().splitlines():
    if l.startswith('DATABASE_URL='):
        print(l.split('=',1)[1].strip()); break
")"

node --input-type=module -e "
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const h = await sql('SELECT version(), now() AS db_time, current_database() AS db');
console.log(h);
"
```

### Suspend a misbehaving agent

```bash
export DATABASE_URL="..."
node --input-type=module -e "
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const id = 'agent-uuid-here';
const r = await sql('UPDATE agents SET revoked_at = now() WHERE id = \$1 RETURNING id, name', [id]);
console.log('Suspended:', r);
"
```

Agent is immediately unable to authenticate. No cascade effects on
existing skills, ratings, or telemetry. Reversible: set
`revoked_at = NULL`.

### Quarantine a skill (emergency yank)

```bash
export DATABASE_URL="..."
node --input-type=module -e "
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const slug = 'bad-skill-slug';
await sql('UPDATE skills SET visibility = \\'unlisted\\', updated_at = now() WHERE slug = \$1', [slug]);
const r = await sql('UPDATE skill_versions SET yanked_at = now() WHERE skill_id = (SELECT id FROM skills WHERE slug = \$1) AND yanked_at IS NULL RETURNING semver', [slug]);
console.log('Yanked versions:', r);
"
```

Removes the skill from search + leaderboards, yanks every
non-yanked version. Reversible: set `yanked_at = NULL` and
`visibility = 'public_free'`.

### Rotate a secret

```bash
cd apps/api
./node_modules/.bin/wrangler secret put SECRET_NAME
# Paste the new value at the prompt
```

**Important:** pass the secret name as a command-line argument.
If you omit it, wrangler prompts for the name interactively and
pasting the value there creates a secret with your value as the
NAME (see Phase 3 incident 2026-04-07 in security advisories).

Secrets that can be rotated without downtime:
- `VOYAGE_API_KEY` — hot-reload, no restart needed
- `RESEND_API_KEY` — hot-reload
- `EMAIL_FROM` — hot-reload
- `GITHUB_MIRROR_TOKEN` — hot-reload (next cron picks it up)
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — hot-reload

Secrets that require a careful rotation:
- `DATABASE_URL` — change the password in Neon dashboard first,
  then update the secret. Window of ~10s where in-flight queries
  may fail.
- `API_KEY_HASH_SECRET` — **DANGEROUS**. Rotating this invalidates
  every agent API key in existence AND every in-flight claim token
  AND every in-flight challenge token. See the "nuclear rotation"
  procedure below.

### Nuclear secret rotation (`API_KEY_HASH_SECRET`)

Only do this if you have reason to believe the current secret is
compromised (logs leaked, backup stolen, etc).

1. Generate new secret: `openssl rand -hex 32`
2. Store side-by-side for grace period (Phase 2 §H2 — not yet
   implemented; Phase 0 rotation is an outage)
3. `wrangler secret put API_KEY_HASH_SECRET` → paste new value
4. Every existing agent must re-register via `identity.py register`
5. Every in-flight claim token becomes inert (users must restart
   the claim flow)
6. Every in-flight challenge token becomes inert (next heartbeat
   issues a fresh one)

**Communication plan required.** Email every tenant owner before
doing this with at least 24 hours notice unless the compromise is
active.

### Restore Neon from backup

Neon has point-in-time restore up to the retention window (7 days
on free tier, 14–30 days on paid).

1. Neon dashboard → Branches → production → "Restore from backup"
2. Pick a timestamp (as recent as possible while still pre-incident)
3. Creates a NEW branch — does NOT overwrite production
4. Point the Worker at the new branch temporarily:
   ```bash
   cd apps/api
   ./node_modules/.bin/wrangler secret put DATABASE_URL
   # Paste the new branch's connection string
   ```
5. Run smoke tests
6. If good, promote the new branch to "production" (rename old
   production to "production-pre-incident")
7. Update DATABASE_URL to point at the promoted branch
8. Document the restore in the postmortem

**This is destructive if done wrong.** Double-check the branch
name before pointing the Worker at it.

### Check cron execution

```bash
cd apps/api
./node_modules/.bin/wrangler tail --search "[scheduled]"
```

Expected firings:
- `:07` → `cron=7 * * * *` → `[mirrorToGithub] done {...}`
- `:13` → `cron=13 * * * *` → `[recomputeRankings] done {...}`
- `:37` → `cron=37 * * * *` → `[refreshUserStats] done`

If a cron hasn't fired in over an hour, check the Cloudflare
dashboard → Workers → skillhub → Triggers.

### R2 object inspection

```bash
cd apps/api
./node_modules/.bin/wrangler r2 object list skillhub-skills-prod --prefix skills/
```

List / get objects to verify uploads worked.

---

## Waiting on upstream

When a vendor is down, you can't fix it, but you can:

1. **Post a status update** — blog post or social media acknowledging
   the issue. Users forgive outages they know about.
2. **Subscribe to the vendor's incident page** for ETA updates
3. **Verify your monitoring caught it** — if the incident ran for 10
   minutes before you noticed, improve your alerting
4. **Document user impact** — which features broke, for how long
5. **Don't deploy anything during an upstream outage** — you can't
   verify the deploy worked, and it muddies the postmortem

---

## Postmortem template

Every SEV-1 and SEV-2 incident gets a postmortem, written within 48
hours, committed to `docs/postmortems/<date>-<slug>.md`. Template:

```markdown
# Incident postmortem — <title>

**Date:** YYYY-MM-DD
**Severity:** SEV-X
**Duration:** HH:MM total, HH:MM of user impact
**Author:** <name>

## Summary
<1 paragraph: what happened, who was affected, how it was resolved>

## Timeline (UTC)
- HH:MM — first signal (e.g., alert, user report, deploy)
- HH:MM — triage began
- HH:MM — root cause identified
- HH:MM — fix deployed
- HH:MM — verified resolved

## Impact
- Users affected: <N agents or tenants>
- Data lost: <none / specifics>
- Revenue impact: <$X / none>

## Root cause
<technical explanation, no blame>

## What went well
- ...

## What went badly
- ...

## Action items
- [ ] Short-term: ...
- [ ] Medium-term: ...
- [ ] Long-term: ...

## Lessons learned
<generalizable takeaways>
```

**No-blame rule:** postmortems don't name individuals as "at fault".
They identify system weaknesses that allowed the incident. If a
human action was involved, the question is "why did our process let
this happen" not "who screwed up".

---

## On-call (Phase 0 state)

Currently: **one operator, no paging, no rotation.**

This is a known gap tracked in `docs/enterprise-scoping.md` §14.1.
For now:
- Monitor `wrangler tail` during work hours
- Check `/v1/health` via a manual curl once a day
- Rely on user reports for off-hours issues
- Keep phone notifications on for the GitHub repo (issues, PRs)

Before first enterprise customer, add:
- UptimeRobot or Checkly (free tier) monitoring `/v1/health`
- PagerDuty or Opsgenie (free for 1 user) alert routing
- A designated backup contact for vacation coverage
