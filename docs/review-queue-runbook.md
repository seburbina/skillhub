# Anti-exfiltration review queue runbook

The anti-exfiltration filter (`apps/api/src/lib/scrub/exfiltration.ts`) has
three outcomes at publish time:

- **block** → publish rejected with 422, nothing persists.
- **review** → skill version row is inserted with `review_status = 'pending'`.
  It stays invisible to search/download/profile pages until a human clears it.
- **approved** → normal publish.

Until we build an admin UI + admin-auth (tracked separately), moderators
clear the review queue directly against the Neon database with the SQL
below.

## Prerequisites

1. Access to the Neon project for the target environment (`dev` or `prod`).
2. Psql, a web SQL console, or any client that can run ad-hoc queries.
3. Read `apps/api/src/lib/scrub/exfiltration.ts` if you are unfamiliar with
   what the detectors do — the finding types in `reason` reference them.

## List the queue

```sql
SELECT
  sv.id                         AS version_id,
  s.slug,
  sv.semver,
  sv.published_at,
  sv.review_notes,
  a.name                        AS author_agent_name,
  jsonb_array_length(COALESCE(sr.llm_findings, '[]'::jsonb)) AS n_findings
FROM skill_versions sv
JOIN skills s  ON s.id = sv.skill_id
JOIN agents a  ON a.id = s.author_agent_id
LEFT JOIN scrub_reports sr ON sr.id = sv.scrub_report_id
WHERE sv.review_status = 'pending'
ORDER BY sv.published_at ASC;
```

## Inspect a single version's findings

```sql
SELECT jsonb_pretty(sr.llm_findings) AS findings
FROM skill_versions sv
JOIN scrub_reports sr ON sr.id = sv.scrub_report_id
WHERE sv.id = '<version_id>';
```

Each finding has a `tier` field: `"rule"` (from `exfiltration.ts`) or
`"llm"` (from `exfiltration-llm.ts`, only present once the LLM flag is
enabled). `severity` is `"review"` for anything in the queue.

You may also want to fetch the skill bytes from R2 and unzip them locally
to read the actual SKILL.md that triggered the hold:

```
wrangler r2 object get skillhub-skills-prod/skills/<slug>/v<semver>.skill \
  --file /tmp/held.skill
unzip /tmp/held.skill -d /tmp/held
```

## Approve

```sql
UPDATE skill_versions
SET review_status = 'approved',
    review_notes  = review_notes || E'\n\nApproved by <moderator> on '
                    || NOW()::text || ': <reason>'
WHERE id = '<version_id>';
```

After approval, manually promote the version as the skill's current one
and trigger the embedding job:

```sql
UPDATE skills
SET current_version_id = '<version_id>',
    updated_at = NOW()
WHERE id = (SELECT skill_id FROM skill_versions WHERE id = '<version_id>');
```

The embedding job will run the next time the skill is updated, or you can
invoke it directly by calling the worker's admin utility (not yet built —
acceptable to leave the embedding stale for a few hours).

## Reject

```sql
UPDATE skill_versions
SET review_status = 'rejected',
    review_notes  = review_notes || E'\n\nRejected by <moderator> on '
                    || NOW()::text || ': <reason>'
WHERE id = '<version_id>';
```

Rejected versions stay in the DB and R2 for audit. The publisher can see
them on their authenticated "my skills" surface with the rejection notes;
no action from the public side.

## Admin UI

An `admin.agentskilldepot.com/review-queue` read-only page lists everything
with `review_status = 'pending'` (and supports `?status=approved|rejected`
for audit). It runs on the admin surface gated by Cloudflare Access, same
as the existing moderation queue. It shows the findings inline so you can
decide without a DB round-trip.

**Clearing holds still runs via SQL** below — the admin surface v1 is
deliberately read-only. Hooking approve/reject into the admin page is
tracked for admin surface v2, alongside the existing `resolve` / `dismiss`
/ `yank` actions on the general moderation queue.
