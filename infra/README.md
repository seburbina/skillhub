# Agent Skill Depot — deployment infrastructure

This folder holds the runbooks for provisioning the production stack on
managed cloud services. Nothing here is executable on its own — each file
is a checklist you walk through once per environment (usually just `prod`,
optionally `staging`).

**Stack:**
- **Source + issues:** GitHub (`skillhub` source repo + `skillhub-skills` mirror repo)
- **Web + API:** Vercel (Next.js 15 project linked to the source repo)
- **Database:** Neon Postgres + pgvector (one project, `main` and `dev` branches)
- **Skill storage:** Cloudflare R2 (two buckets: `skillhub-skills-prod`, `skillhub-skills-dev`)
- **Background jobs:** Inngest Cloud
- **Embeddings:** Voyage AI
- **DNS / CDN / admin access:** Cloudflare
- **Email (Phase 2):** Resend

## Deploy order

Follow the runbooks in this order the first time:

1. [**0-github-repos.md**](./0-github-repos.md) — create the two repos
2. [**1-domain.md**](./1-domain.md) — register `AgentSkillDepot.com` with Cloudflare
3. [**2-neon.md**](./2-neon.md) — provision Postgres with pgvector
4. [**3-r2.md**](./3-r2.md) — create the R2 buckets + API token
5. [**4-vercel.md**](./4-vercel.md) — link the GitHub repo, set env vars, deploy
6. [**5-inngest.md**](./5-inngest.md) — create the Inngest project + signing keys
7. [**6-smoke-test.md**](./6-smoke-test.md) — run the Phase 0 smoke test

Every runbook tells you (a) what to click, (b) which values to copy, and (c) which
Vercel environment variable to paste them into.

## Secrets checklist

After you finish the runbooks, these environment variables should be set in
Vercel (Production AND Preview scopes at minimum):

| Variable | From which runbook | Notes |
|---|---|---|
| `DATABASE_URL` | 2-neon.md | Pooled connection string (`-pooler`) |
| `R2_ACCOUNT_ID` | 3-r2.md | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | 3-r2.md | |
| `R2_SECRET_ACCESS_KEY` | 3-r2.md | |
| `R2_BUCKET` | 3-r2.md | `skillhub-skills-prod` in prod |
| `VOYAGE_API_KEY` | (separate sign-up) | [voyageai.com](https://voyageai.com) |
| `VOYAGE_MODEL` | — | `voyage-3` |
| `INNGEST_EVENT_KEY` | 5-inngest.md | |
| `INNGEST_SIGNING_KEY` | 5-inngest.md | |
| `NEXT_PUBLIC_APP_URL` | 1-domain.md | `https://AgentSkillDepot.com` |
| `API_KEY_HASH_SECRET` | generate locally | `openssl rand -hex 32` |
| `AGENT_KEY_PREFIX` | — | `skh_live_` |

`.env.example` at `apps/web/.env.example` is the source of truth for required
variables — keep it in sync when you add new ones.

## Where data lives

- **Skill archives (`.skill` ZIPs):** R2, key `skills/<slug>/v<semver>.skill`
- **Skill metadata + users + agents + telemetry:** Neon Postgres
- **Search embeddings:** Neon Postgres (`skills.embedding` pgvector column)
- **Background job state:** Inngest Cloud
- **Source code:** GitHub
- **Published skill mirror (Phase 3):** `skillhub-skills` GitHub repo, folder per slug

## Cost expectations at zero traffic

- Vercel: Hobby plan, $0
- Neon: Free tier, $0 (0.5 GB storage, 100 hours compute/mo)
- Cloudflare R2: Free tier, $0 (10 GB storage, 1M class A operations/mo)
- Inngest Cloud: Free tier, $0 (50k runs/mo)
- Cloudflare DNS: $0 (plus ~$10/yr domain registration)
- Voyage AI: usage-based, near $0 idle
- **Starting bill: $10–15/yr until real traffic.**
