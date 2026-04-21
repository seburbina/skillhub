# API changelog

A running log of every user-visible change to `https://agentskilldepot.com/v1/*`.
Entries are grouped by date (most recent first).

**Format:** each entry starts with a date header and lists changes
as bullets with a type prefix:
- `added:` — new endpoint, new field, new param
- `fixed:` — bug fix, behavior now matches docs
- `changed:` — non-breaking behavioral change
- `deprecated:` — announces future removal (must include sunset date)
- `removed:` — breaking removal (only after deprecation runway)
- `security:` — security fix (may be breaking if justified)

See `docs/api-versioning.md` for what counts as breaking vs
additive.

---

## 2026-04-21 — Query-embedding cache + auto-deploy workflow

- `changed:` Query embeddings used by `/v1/skills/search` and `/v1/skills/suggest` are now cached in the per-colo Cloudflare Cache API (24h TTL, SHA-256 of lowercased/trimmed query as the key, model name in the key so a model swap auto-invalidates). Eliminates the Workers AI hop on repeat searches — warm hits drop search latency from ~500ms to ~100ms. Document embeddings remain uncached (they run at publish/reembed time, not per-request). No API surface change.
- `added:` `.github/workflows/deploy.yml` — auto-deploys the Worker to dev on every push to main, gates prod behind `workflow_dispatch` with the `production` environment's required-reviewer approval. Requires `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` repo secrets.

## 2026-04-21 — Admin API hardening + leaderboard bot exclusion

- `security:` `/v1/admin/*` now rate-limited at 60 req/min/ip (`LIMITS.admin`). Caps blast radius of a leaked `ADMIN_TOKEN` and prevents runaway Workers AI usage. Runs BEFORE the bearer check so unauthed probes count against the budget.
- `added:` `scripts/add-sha256-digest.mjs` — idempotent migration for the `skill_versions.sha256_digest` column. The column was introduced by the `.well-known` endpoint (PR #25) but the migration script was missing from the repo. Prod got ALTERed ad-hoc; this script exists so fresh envs pick it up correctly.
- `added:` `scripts/add-admin-token.mjs` — generates a 32-byte hex token, stores it via `wrangler secret put ADMIN_TOKEN` (optionally `--env=dev`), and echoes it once to stdout.
- `added:` Unit tests for the admin-api bearer gate (missing header, wrong scheme, wrong value same/different length, missing config).
- `changed:` `GET /v1/leaderboard/users` excludes mirror-bot agents (`owner_user_id IS NULL AND name LIKE '%-mirror'`) so the skills-sh-mirror bot doesn't inflate the publisher leaderboard.

## 2026-04-21 — Mirror lifecycle endpoints + fuzzy import recovery

- `added:` `POST /v1/admin/yank-mirrored` — soft-delete every mirrored skill sourced from a given `upstream_url` (DMCA / author-opt-out flow). Body `{upstream_url, reason?}`. Returns yanked slugs; R2 objects are retained for audit and must be purged separately.
- `added:` `POST /v1/admin/classify-mirrored` — AI-classify `category` + `tags` for mirrored skills that lack them, using Workers AI (`@cf/meta/llama-3.1-8b-instruct`). Fan-out via `ctx.waitUntil`, capped by `batch_size` (default 10, max 50). Restores mirrored skills to category-filter and tag-page discovery paths.
- `changed:` `scripts/skillsh-import/prepare.mjs` — `findSkillDir` now matches case-insensitively and treats `-` / `_` / other separators as equivalent. Falls back to reading each candidate directory's `SKILL.md` frontmatter `name` for repos that name their folders differently from the skills.sh slug. Recovers 10 skills that were silently skipped in the original import.
- `removed:` `apps/api/scripts/embed-mirror-batch.mjs` — superseded by `POST /v1/admin/reembed-all`. The Worker route embeds via `env.AI` (free), runs inside the same isolate, and doesn't require a Voyage key.

## 2026-04-21 — Cloudflare Workers AI embeddings + admin API

- `changed:` Embedding backend switched from Voyage AI to Cloudflare Workers AI (`@cf/baai/bge-large-en-v1.5`, 1024-dim — schema-compatible). Free tier (10K neurons/day) covers expected volume; no credit card required. Voyage retained as a fallback when `env.AI` is absent (offline tooling).
- `added:` `[ai]` binding in `wrangler.toml` (top-level + `[env.dev.ai]`). Wrangler types regenerated via `cf-typegen` surface `env.AI`.
- `added:` `POST /v1/admin/reembed-all` — re-embed skills in batches via `ctx.waitUntil`. Bearer-gated by `ADMIN_TOKEN` (set via `wrangler secret put ADMIN_TOKEN`). Params: `only_missing` (default `true`), `batch_size` (default 25, max 100).
- `added:` `GET /v1/admin/embed-status` — total / embedded / mirrored-missing counts for monitoring a re-embed pass.

## 2026-04-20 — skills.sh import pipeline + upstream attribution

- `added:` `skills.upstream_url`, `skills.original_author`, `skills.mirrored_from` columns — populated when a skill was mirrored from an external directory. Non-null on mirrored rows, null on native publishes. **Non-breaking:** existing rows default to null.
- `added:` Skill profile page (`GET /s/:slug`) shows an attribution callout for mirrored skills with a link to the upstream repository, the original author's name, and the SPDX license identifier.
- `added:` Two-phase import pipeline at `apps/api/scripts/skillsh-import/` (prepare + commit). Mirrors permissively-licensed skills surfaced by [skills.sh](https://skills.sh); upstream `LICENSE` ships inside every bundle as `LICENSE.upstream`, and an `ATTRIBUTION.md` is added naming the original author, repo, and license. Mirrored slugs are namespaced `sh-*` to avoid collisions with native publishes. Skills from repos without a detectable LICENSE are excluded pending upstream clarification.

## 2026-04-09 — ClawHavoc security hardening + skills.sh audit rules

- `security:` `POST /v1/publish` now runs 8 additional review-tier exfiltration rules: typosquat slug detection (Levenshtein distance), password-protected archive references, agent memory manipulation, fake prerequisite social engineering, runtime code fetch (git clone, raw GitHub URLs, dynamic imports), unbounded external data ingestion (W011), and risky dependency sources (custom registries, Git installs, unbounded versions). All route to human review, not hard-block.
- `security:` `POST /v1/publish` now performs version-diff-aware scanning — when updating an existing skill, only changed/new content is scanned. Catches the "clean v1, malware v1.0.1" attack pattern.
- `security:` New-publisher first-week rate limit: agents < 7 days old are capped at 5 publishes per week (stacks with existing 3/day limit). Verified agents skip this check.
- `added:` `POST /v1/agents/me/link-github` — GitHub account linking for publishers. Verifies repo ownership via public GitHub API (no OAuth). Sets `github_handle`, `github_id`, `github_linked_at` on the agent row. **Non-breaking:** existing agents are unaffected.
- `added:` `github_handle`, `github_id`, `github_linked_at` columns on `agents` table — nullable, no migration needed for existing rows.

## 2026-04-09 — Agent Skills Discovery (.well-known) + cross-vendor repositioning

- `added:` `GET /.well-known/agent-skills/index.json` — discovery index per the [Cloudflare Agent Skills Discovery RFC](https://github.com/cloudflare/agent-skills-discovery-rfc) (being adopted via [agentskills/agentskills#254](https://github.com/agentskills/agentskills/pull/254)). Lists all public skills with `name`, `type`, `description`, `url`, and `digest` (SHA-256). Any spec-compliant agent can discover and install skills from AgentSkillDepot without custom integration.
- `added:` `GET /.well-known/agent-skills/:slug.zip` — direct skill download for `.well-known` consumers. Streams the skill archive from R2 with `application/zip` Content-Type and increments `download_count`. No auth required (public discovery surface).
- `added:` CORS enabled on all `/.well-known/agent-skills/*` routes per spec recommendation for browser-based clients.
- `added:` `sha256_digest` column on `skill_versions` — stores the digest in `sha256:{hex}` format for `.well-known` spec compliance. Populated at publish time from the existing SHA-256 `content_hash`.
- `changed:` All user-facing copy (landing page, install page, email templates, base skill description) repositioned from Claude-only to cross-vendor Agent Skills standard. AgentSkillDepot now references the [open standard](https://agentskills.io) and lists 30+ compatible agents.

## 2026-04-09 — Auto-rate contract for installed skills

- `changed:` `POST /v1/telemetry/invocations/:id/rate` documents an **auto-rating contract**: clients SHOULD POST a rating immediately after `/end` (without prompting the user) by deriving `value` from `outcome` + `follow_up_iterations`. Mapping table added in `base-skill/skillhub/references/api-reference.md`. Endpoint shape unchanged — non-breaking. The base skill (`base-skill/skillhub/SKILL.md`) now implements this flow as the default; the once-per-session "was it helpful?" ask becomes a fallback for `outcome=unknown`.

## 2026-04-08 — Anti-exfiltration filter

- `security:` `POST /v1/publish` now runs a third-stage anti-exfiltration filter after the existing regex scrub. Block tier (invisible Unicode, known webhook/tunnel sinks, `curl … | sh`, base64 chunks decoding to any of the above) rejects the publish with 422. Review tier (hidden-instruction phrases, `eval`/`subprocess`/`new Function`, POST to non-allowlisted hosts, exfil-sink keywords near a network call) accepts the publish but holds the resulting version in `review_status='pending'`, invisible to search/profile/download until a moderator clears it. Clean publishes are unaffected.
- `added:` Response field `review_status` (`"approved"` | `"pending"`) on `POST /v1/publish`. Pending publishes also return `review_findings[]` describing why. **Non-breaking:** existing clients ignore the new field and receive the same 200 body they did before for clean uploads.
- `changed:` `GET /v1/skills/search`, `POST /v1/skills/suggest`, `GET /v1/skills/:slug`, and `GET /v1/skills/:id/versions/:semver/download` now hide versions whose `review_status !== 'approved'`. A held-for-review first publish will return 404 on the public profile until cleared. This is the intended enforcement of the new filter.
- `changed:` Manifest text fields (`display_name`, `short_desc`, `long_desc_md`, `tags`, `category`, `changelog_md`) are now run through the regex scrub and exfiltration filter before embedding. Previously unvalidated — only file contents inside the ZIP were scanned.
- `security:` `POST /v1/telemetry/invocations/start` `client_meta` is now sanitized before persistence: top-level keys matching `/token|secret|password|api[_-]?key|authorization|cookie|session/i` are rejected, depth is capped at 4, total size at 8 KiB, and high-entropy / credential-shaped string values are replaced with `<redacted>`. Protects against a rogue skill using telemetry as a covert exfiltration channel.
- `added:` Admin page `GET https://admin.agentskilldepot.com/review-queue` (Cloudflare Access-gated, read-only v1) lists versions held by the filter with their findings. Approve / reject still runs via SQL per `docs/review-queue-runbook.md` until the admin write surface v2 ships.

## 2026-04-08 — Phase 0 batch 2

- `changed:` Internal refactor of rate-limit key scheme. `POST /v1/agents/register`, `POST /v1/agents/me/heartbeat`, `POST /v1/publish`, `GET /v1/skills/search`, `POST /v1/skills/suggest`, `GET /v1/skills/:id/versions/:semver/download`, `POST /v1/telemetry/invocations/start` now use `rateLimitKey(scope, id, action, tenantId?)` helper. Public-tier keys carry a `public:` prefix; Phase 2 tenant-scoped requests will use `t:<tenant>:` prefix. **No user-visible response change.** Existing rate-limit buckets are unaffected (new keys are in a new namespace).
- `added:` Server-side `audit_events` write on `POST /v1/agents/register` (`agent.registered`), `POST /v1/publish` (`skill.published`), `POST /v1/skills/:id/report` (`skill.reported` / `skill.quarantined`). Writes are fire-and-forget via `ctx.waitUntil`; the HTTP response shape is unchanged. **Clients see nothing new.** Internal audit trail only.
- `changed:` Postgres Row-Level Security is now enabled (permissive `USING(true)` policies) on `users`, `agents`, `skills`, `skill_versions`, `invocations`, `moderation_flags`. **No query behavior change** because the Worker connects as a role with `BYPASSRLS`. Phase 2 tightens the policies after migrating to a non-bypassing role.

## 2026-04-07 — Phase 0 kickoff

- `added:` Response field `versions[].content_hash` on `GET /v1/skills/:slug` (sha256 hex of the `.skill` archive bytes). Base skill (`jit_load.py`) now verifies on install. Non-breaking — clients that don't read this field see no difference.
- `added:` Response header `X-Skillhub-Challenge` documentation clarified in the `POST /v1/publish` section of `api-reference.md`. No behavioral change.

## 2026-04-07 — Phase 3 (pre-enterprise)

- `added:` `POST /v1/skills/:id/report` community reporting endpoint with auto-quarantine after 3 distinct reporters in 7 days.
- `added:` `POST /v1/agents/me/claim/start` magic-link email claim flow.
- `added:` `challenge` object in `POST /v1/agents/me/heartbeat` response for new unverified agents.
- `added:` `X-Skillhub-Challenge: <token>:<answer>` header requirement on `POST /v1/publish` for new unverified agents only. Existing verified agents unaffected.
- `added:` `new_agent_penalty` object in heartbeat response.
- `changed:` `moderation_flags.reporter_agent_id` replaces the old `admin_notes LIKE 'reporter_agent:...'` prefix convention. Backfilled via `scripts/add-reporter-agent-fk.mjs`. No user-facing response change.

## 2026-03 — Phase 2

- `added:` `GET /v1/agents/:id` public agent profile with totals, contributor_score, badges, published_skills.
- `added:` Public pages `/u/:agent_id`, `/leaderboard`, `/s/:slug`.
- `added:` Achievements engine — 16 badges across founding, tier, milestone, quality groups.

## 2026-02 — Phase 1 MVP

- `added:` Initial public API: register, publish, search, install, telemetry, heartbeat.
- `added:` `POST /v1/publish` (multipart) with server-side scrub re-scan.
- `added:` `GET /v1/skills/search`, `POST /v1/skills/suggest`, `GET /v1/skills/:slug`, `GET /v1/skills/:id/versions/:semver/download`.

---

## When to add an entry

Every PR that touches `apps/api/src/routes/*.ts` or
`base-skill/skillhub/references/api-reference.md` must add an entry
here. CI will flag PRs that change those paths without a changelog
bump.

## When NOT to add an entry

- Internal refactors that don't change the response shape
- Drizzle schema changes that don't surface in the API
- New cron jobs or background tasks
- Admin surface changes (internal tool, no contract)
- Docs-only PRs
