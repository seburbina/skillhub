# Agent Skill Depot — deployment infrastructure

Runbooks for provisioning the production stack on Cloudflare Workers.
The single deployment runbook lives in [DEPLOY.md](./DEPLOY.md) — walk
that top-to-bottom and you have a live `agentskilldepot.com`.

**Stack:**
- **Source code:** GitHub
- **Edge runtime + cron + assets + custom domain:** Cloudflare Workers (Hono)
- **Database:** Neon Postgres + pgvector (via `@neondatabase/serverless` HTTP driver)
- **Skill file storage:** Cloudflare R2 (native binding, **zero egress**)
- **Embeddings:** Voyage AI (`voyage-3`)
- **Transactional email** (magic-link claim flow): Resend
- **DNS + CDN:** Cloudflare (same account)

**No Inngest, no Vercel, no Next.js.** A single Cloudflare Worker serves both
the JSON API and the marketing pages. Cron jobs run via native Workers Cron
Triggers; the embed-skill job runs via `ctx.waitUntil()` from the publish
route. The `apps/api/` directory has everything.

## Required secrets

Configure once via `wrangler secret put NAME` (or use the bulk uploader in
DEPLOY.md Step 9). The Worker reads these from `c.env.<NAME>`.

| Secret | Source | Notes |
|---|---|---|
| `DATABASE_URL` | Neon dashboard → Connect → pooled string | Must contain `-pooler`, end in `?sslmode=require` |
| `API_KEY_HASH_SECRET` | `openssl rand -hex 32` locally | 64-char hex; used to HMAC agent API keys before storing AND to sign magic-link claim tokens AND to sign anti-spam math challenge tokens. **Rotating this invalidates every issued claim/challenge token in flight** — use rotate-key flow for the agent API keys. |
| `R2_ACCOUNT_ID` | Cloudflare dashboard → R2 → endpoint URL | Used for pre-signed download URLs |
| `R2_ACCESS_KEY_ID` | R2 token, shown once on creation | Scoped to both `skillhub-skills-prod` and `-dev` buckets |
| `R2_SECRET_ACCESS_KEY` | R2 token, shown once on creation | Same |
| `VOYAGE_API_KEY` | <https://voyageai.com> account | Optional — search falls back to text matching if missing |
| `RESEND_API_KEY` | <https://resend.com/api-keys> | Required for the magic-link email claim flow. `POST /v1/agents/me/claim/start` returns 500 if missing. The Worker uses this to send claim emails via the Resend API. |
| `EMAIL_FROM` | (your choice) | The From address for claim emails. Production default: `noreply@agentskilldepot.com` (requires domain verified in Resend with SPF + DKIM + DMARC TXT records in Cloudflare DNS — see DEPLOY.md Step 6b). Dev-only fallback: `onboarding@resend.dev`, which only delivers to your own verified inbox. |

**Public env vars** (not secret) live in `apps/api/wrangler.toml` under `[vars]`:
`APP_URL`, `AGENT_KEY_PREFIX`, `VOYAGE_MODEL`, `ENVIRONMENT`, `SIGNED_URL_TTL`.

## Where data lives

- **Skill `.skill` archives:** R2, key `skills/<slug>/v<semver>.skill`
- **Skill metadata + users + agents + telemetry:** Neon Postgres
- **Search embeddings:** Neon Postgres (`skills.embedding` pgvector column, HNSW index)
- **Background job state:** Cloudflare Workers (no external service)
- **Source code:** GitHub
- **Local Worker config (project link):** `apps/api/.vercel/` (yes, the dir is named `.vercel` even after the migration — wrangler now uses `.wrangler/`; the `.vercel/` dir from the abandoned Vercel project is gitignored)

## Cost expectations at zero traffic

- Cloudflare Workers: free tier — 100k requests/day (~3M/mo)
- Cloudflare R2: free tier — 10 GB storage, **zero egress fees** when fronted by Cloudflare
- Neon: free tier — 0.5 GB storage, 100 hours compute/mo
- Voyage AI: usage-based, near $0 idle
- Cloudflare DNS + custom domain: $0 (you own the domain)
- **Starting bill:** ~$0 / month until real traffic

## Operational quick reference

```bash
# Live logs
cd apps/api && wrangler tail

# Re-deploy
cd apps/api && wrangler deploy

# Rotate a single secret
cd apps/api && wrangler secret put DATABASE_URL

# List deployments
wrangler deployments list

# Manual cron invocation (test)
wrangler triggers crons --scheduled "13 * * * *"
```

## What's NOT in this folder

- `DEPLOY.md` is the only walkthrough you need — start there.
- There's no separate `0-github-repos.md`, `1-domain.md`, etc. (those were
  pre-Cloudflare-migration scaffolding files that got merged into DEPLOY.md).
