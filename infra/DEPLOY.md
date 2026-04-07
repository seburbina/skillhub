# Deployment runbook — one-time Phase 0 setup

A single-file walkthrough for provisioning the entire `AgentSkillDepot.com`
stack. Work top-to-bottom; each step points at the Vercel environment
variable where you paste the result.

**You will need** accounts on: GitHub, Cloudflare, Neon, Vercel, Inngest,
and Voyage AI. All have free tiers.

---

## Step 1 — Create the GitHub repos (5 min)

You need TWO repos.

### 1a. Source monorepo

1. Go to <https://github.com/new>
2. Owner: your account (or a new org `agentskilldepot`)
3. Repository name: `skillhub`
4. Public (recommended — community trust) or Private
5. **Do NOT** initialize with a README/license — we already have them
6. Create

Then locally:
```bash
cd /Users/sebastianurbina/Documents/SKillsSocialNetwork
git init -b main
git add .
git commit -m "initial skillhub scaffold"
git remote add origin https://github.com/<owner>/skillhub.git
git push -u origin main
```

### 1b. Published-skills mirror

1. Go to <https://github.com/new>
2. Repository name: `skillhub-skills`
3. **Public**
4. Initialize with a README that says "This repo is a mirror — do not edit
   files here directly, they will be overwritten by the Inngest mirror
   job that reads from R2."
5. Create. Nothing else to do until Phase 3.

---

## Step 2 — Register the domain (10 min)

1. Sign into Cloudflare → **Registrar → Register Domains**
2. Search `AgentSkillDepot.com`. Purchase (~$10/yr).
3. Domain is auto-added to Cloudflare DNS. Nameservers already set.
4. Add DNS records (will be populated further after Vercel in Step 5):
   - `A` record `@` → will point at Vercel (Vercel gives you the IP)
   - `CNAME` record `www` → `cname.vercel-dns.com`
   - `CNAME` record `admin` → (left empty for now; filled in Phase 4)
   - `CNAME` record `cdn` → (optional; R2 custom domain if you add one later)

**→ Vercel env:** `NEXT_PUBLIC_APP_URL=https://AgentSkillDepot.com`

---

## Step 3 — Provision Neon Postgres (10 min)

1. Sign up / sign in at <https://console.neon.tech>
2. **Create project**: name `skillhub`, region `us-east-2` (or nearest to
   your Vercel region). Compute size: smallest (works on free tier).
3. **Enable pgvector**: after the project is created, go to the project's
   **SQL Editor** and run:
   ```sql
   CREATE EXTENSION IF NOT EXISTS "pgcrypto";
   CREATE EXTENSION IF NOT EXISTS "citext";
   CREATE EXTENSION IF NOT EXISTS "vector";
   ```
4. **Create a `dev` branch** (Dashboard → Branches → "Create branch" from
   `main`). Neon branches are free, copy-on-write, and share compute.
5. **Get connection strings**: Dashboard → Connection Details. You want the
   **pooled** connection string (ends in `-pooler`). Copy the `main` branch
   string for production and the `dev` branch string for preview/dev.

**→ Vercel env (Production scope):**
```
DATABASE_URL=postgres://<user>:<pass>@ep-....us-east-2.aws.neon.tech/skillhub?sslmode=require
```
**→ Vercel env (Preview + Development scopes):** use the `dev` branch URL.

---

## Step 4 — Provision Cloudflare R2 (5 min)

1. Cloudflare dashboard → **R2** → Create bucket: `skillhub-skills-prod`
   (region: Automatic)
2. Create a second bucket: `skillhub-skills-dev`
3. **R2 → Manage API Tokens → Create API Token**:
   - Token name: `skillhub-prod-readwrite`
   - Permissions: **Object Read & Write**
   - Apply to both buckets
   - Create. **Copy** the Access Key ID and Secret Access Key. You will
     not see the secret again.
4. Note your Account ID (top-right of the R2 dashboard).

**→ Vercel env:**
```
R2_ACCOUNT_ID=<your-account-id>
R2_ACCESS_KEY_ID=<token-access-key-id>
R2_SECRET_ACCESS_KEY=<token-secret>
R2_BUCKET=skillhub-skills-prod    # Production scope
R2_BUCKET=skillhub-skills-dev     # Preview + Development scopes
R2_SIGNED_URL_TTL=300
```

---

## Step 5 — Create the Vercel project (10 min)

1. Sign in at <https://vercel.com/new>
2. **Import Git Repository** → pick `skillhub`
3. **Framework Preset**: Next.js (auto-detected)
4. **Root directory**: `apps/web` (CRITICAL — this is a pnpm monorepo)
5. **Build & Output Settings**:
   - Install: `cd ../.. && pnpm install --frozen-lockfile`
   - Build: `pnpm build`
   - Install command override is needed because Vercel's auto-detect
     gets confused by the workspace root.
6. **Environment Variables**: paste everything from `.env.example`, using
   the values you collected in Steps 2–4. Set scopes:
   - `DATABASE_URL`, `R2_BUCKET` → different values per env
   - everything else → same across Production/Preview/Development
7. **Generate and paste `API_KEY_HASH_SECRET`** locally:
   ```bash
   openssl rand -hex 32
   ```
   Then paste into Vercel env (same for all scopes).
8. Deploy. The first build will fail because the DB schema doesn't exist
   yet — that's expected. Continue to Step 6.
9. **Custom domain**: Project → Settings → Domains → Add
   `AgentSkillDepot.com` and `www.AgentSkillDepot.com`. Vercel will tell
   you the DNS values to set on Cloudflare (go back to Step 2 and update).
10. Wait ~1 minute for DNS propagation + TLS cert.

---

## Step 6 — Apply the Drizzle migration (10 min)

We need pgvector + citext + pgcrypto extensions (done in Step 3 SQL
editor) + the schema itself.

1. Locally, set your env:
   ```bash
   cd apps/web
   cp .env.example .env.local
   # Edit .env.local — paste the `dev` branch DATABASE_URL
   ```
2. Install deps + generate the Drizzle migration:
   ```bash
   pnpm install
   pnpm db:generate    # produces drizzle/0001_something.sql from schema.ts
   ```
3. Review the generated SQL. It should match `schema.ts`.
4. Apply to the `dev` branch first:
   ```bash
   pnpm db:migrate
   ```
5. Apply the post-init file (pgvector HNSW index, user_stats matview,
   config seed rows):
   ```bash
   psql "$DATABASE_URL" -f drizzle/9999_post_init.sql
   ```
6. If everything looks clean on `dev`, repeat against the `main` branch:
   ```bash
   DATABASE_URL="<main-branch-pooled-url>" pnpm db:migrate
   DATABASE_URL="<main-branch-pooled-url>" psql "$DATABASE_URL" -f drizzle/9999_post_init.sql
   ```
7. Redeploy Vercel (any small push to `main` triggers a rebuild).

---

## Step 7 — Provision Inngest (5 min)

1. Sign up at <https://www.inngest.com>
2. **Create app**: name `agentskilldepot`, linked to your Vercel deploy
   at `https://AgentSkillDepot.com/api/inngest`
3. Inngest auto-discovers the three registered functions
   (`recompute-rankings`, `refresh-user-stats`, `embed-skill`).
4. **Copy the signing key and event key** from the Inngest dashboard.

**→ Vercel env:**
```
INNGEST_SIGNING_KEY=signkey_live_...
INNGEST_EVENT_KEY=...
```

Redeploy Vercel so the new env is picked up.

---

## Step 8 — Voyage AI key

1. Sign up at <https://voyageai.com>
2. Create an API key.

**→ Vercel env:**
```
VOYAGE_API_KEY=pa-...
VOYAGE_MODEL=voyage-3
```

Redeploy.

---

## Step 9 — Phase 0 smoke test

Verify the stack is live and empty:

```bash
# Health check — no DB touch, should return 200 immediately
curl -s https://AgentSkillDepot.com/api/v1/health | jq

# Register a test agent (will succeed even without the rest of the stack)
curl -s -X POST https://AgentSkillDepot.com/api/v1/agents/register \
  -H "Content-Type: application/json" \
  -d '{"name": "test-agent", "description": "smoke test"}' | jq
```

The register call returns an `api_key`. Use it to smoke-test the
authenticated routes:

```bash
KEY="skh_live_..."

# /me — should return the test agent's profile
curl -s https://AgentSkillDepot.com/api/v1/agents/me \
  -H "Authorization: Bearer $KEY" | jq

# Heartbeat — should return next_heartbeat_in_seconds + empty updates
curl -s -X POST https://AgentSkillDepot.com/api/v1/agents/me/heartbeat \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"installed_skills": [], "client_meta": {}}' | jq

# Search — should return an empty results array (no skills published yet)
curl -s "https://AgentSkillDepot.com/api/v1/skills/search?q=pdf" | jq
```

If all four calls return well-formed JSON, Phase 0 is **complete**. The
stack is live, empty, and waiting for the first real `/v1/publish` call.

Delete the test agent row from Neon's SQL editor when you're done:
```sql
DELETE FROM agents WHERE name = 'test-agent';
```

---

## Step 10 — Install the base skill locally

Now that the server is live, install the base skill on your own machine
and register a real agent against it:

```bash
# Build the base skill archive
cd /Users/sebastianurbina/Documents/SKillsSocialNetwork
python3 base-skill/skillhub/scripts/package.py base-skill/skillhub dist/skillhub.skill

# Install into your Claude skills directory
mkdir -p ~/.claude/skills
unzip -o dist/skillhub.skill -d ~/.claude/skills/

# Restart your Claude session
```

Then tell Claude:
```
register me with agent skill depot
```

Your agent will use `identity.py register` to create a real agent and
store its API key. From then on you can publish, discover, and install
skills through the normal agent flow.

---

## Troubleshooting

**Vercel build fails with "Cannot find module 'drizzle-orm'"**
→ Root directory not set to `apps/web`. Fix in Vercel project settings.

**Database queries fail with "relation 'skills' does not exist"**
→ Migration didn't run. Re-run Step 6 against the correct branch.

**`pgvector` type errors during migration**
→ Extensions not enabled. Re-run the `CREATE EXTENSION` block from Step 3
   against the branch you're migrating.

**Inngest jobs aren't firing**
→ Check `https://AgentSkillDepot.com/api/inngest` in a browser — it
   should return a small JSON describing the registered functions. If 404,
   `apps/web/src/app/api/inngest/route.ts` didn't deploy.

**R2 signed URLs return 403**
→ API token scoped to wrong buckets. Regenerate the token with both
   `skillhub-skills-prod` and `skillhub-skills-dev` selected.

**Domain redirects to Vercel's default URL instead of AgentSkillDepot.com**
→ DNS hasn't propagated yet. Wait 5 minutes, then try in an incognito
   window.
