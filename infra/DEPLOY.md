# Deployment runbook — Cloudflare Workers stack

How to provision the entire `agentskilldepot.com` stack from scratch. Walk
top-to-bottom; every step points at the wrangler command or Cloudflare URL
that does the work.

**You will need accounts on:** GitHub, Cloudflare, Neon, Voyage AI. All have
free tiers. The whole stack runs on free tiers at MVP traffic.

**Stack:**
- **Source code:** GitHub
- **Edge runtime + cron + assets:** Cloudflare Workers (Hono framework)
- **Database:** Neon Postgres + pgvector (via `@neondatabase/serverless` HTTP driver)
- **Skill file storage:** Cloudflare R2 (native binding, zero egress)
- **Embeddings:** Voyage AI (`voyage-3`)
- **DNS + CDN + custom domain:** Cloudflare (same account)

---

## Step 1 — Create the GitHub repo

1. <https://github.com/new> → name `skillhub` (or whatever)
2. Public, no auto-init
3. Push the local repo:
   ```bash
   cd /path/to/SKillsSocialNetwork
   git init -b main
   git remote add origin https://github.com/<owner>/skillhub.git
   git add .
   git commit -m "initial scaffold"
   git push -u origin main
   ```

## Step 2 — Cloudflare account setup

1. <https://dash.cloudflare.com> — sign up if needed
2. Get your account ID from the right sidebar of any dashboard page

## Step 3 — Neon Postgres

1. <https://console.neon.tech/signup> — sign up with GitHub
2. **Create a project**: name `skillhub`, region nearest to your users (e.g. `aws-us-east-2`)
3. **Default branch is named `production`** (not `main`)
4. **Enable extensions** — Sidebar → SQL Editor (branch `production`, db `neondb`):
   ```sql
   CREATE EXTENSION IF NOT EXISTS "pgcrypto";
   CREATE EXTENSION IF NOT EXISTS "citext";
   CREATE EXTENSION IF NOT EXISTS "vector";
   ```
5. **Optional dev branch**: Sidebar → Branches → Create branch from `production`, name `dev`, "use parent's compute"
6. **Get connection strings**: Sidebar → Dashboard → **Connect** button → modal:
   - Branch: `production` · Database: `neondb` · Role: `neondb_owner`
   - **Connection pooling: ON** (hostname must contain `-pooler`)
   - Copy the string

## Step 4 — Cloudflare R2 buckets

1. Cloudflare dashboard → **R2 Object Storage**
2. **Create bucket**: `skillhub-skills-prod` (Automatic location, Standard storage)
3. **Create bucket**: `skillhub-skills-dev` (same)
4. **R2 → Manage R2 API Tokens → Create Account API Token**
   - Name: `skillhub-prod-readwrite`
   - Permissions: **Object Read & Write**
   - Apply to specific buckets: both `skillhub-skills-prod` and `skillhub-skills-dev`
   - No TTL
5. **Copy** the Access Key ID + Secret Access Key (only shown once)
6. Note your Cloudflare account ID (also visible in the R2 endpoint URL)

## Step 5 — Add `agentskilldepot.com` to Cloudflare DNS

1. Cloudflare dashboard → **+ Add a site** → enter `agentskilldepot.com`
2. Plan: Free
3. Cloudflare gives you 2 nameservers; set them at your registrar (GoDaddy/Namecheap/etc.)
4. Wait for Cloudflare to mark the site **Active** (5–30 min usually)
5. **Important:** if you have legacy DNS records imported from your old registrar that point at the apex (`@`) or `www` (typical: A record from a parking page, CNAME from old hosting), you'll need to delete them before Step 9 — they conflict with the Worker custom domain

## Step 6 — Voyage AI key

1. <https://voyageai.com> → sign up
2. Create an API key (free tier is generous)
3. Save it

## Step 7 — Local toolchain

You need Node 20+, pnpm, and wrangler. Easiest path on macOS without Homebrew:
```bash
# Download Node tarball
curl -fsSL -o /tmp/node.tar.xz \
  https://nodejs.org/dist/v20.18.1/node-v20.18.1-darwin-arm64.tar.xz
mkdir -p ~/.local/node
tar -xJf /tmp/node.tar.xz -C ~/.local/node --strip-components=1
echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> ~/.zprofile
export PATH="$HOME/.local/node/bin:$PATH"
node --version  # v20.x

# pnpm + wrangler globally
npm install -g pnpm@9 wrangler@latest
```

## Step 8 — Install + typecheck

```bash
cd /path/to/SKillsSocialNetwork
pnpm install
pnpm --filter api typecheck   # should be clean
```

## Step 9 — Wrangler auth + secrets

```bash
cd apps/api
wrangler login            # opens browser OAuth, one-time
wrangler whoami           # confirm
```

**Save secrets locally** to `~/.config/skillhub/secrets.env` (chmod 600):
```
DATABASE_URL=postgres://neondb_owner:PASSWORD@ep-...-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
API_KEY_HASH_SECRET=<64 hex chars from `openssl rand -hex 32`>
R2_ACCOUNT_ID=<from Step 4>
R2_ACCESS_KEY_ID=<from Step 4>
R2_SECRET_ACCESS_KEY=<from Step 4>
VOYAGE_API_KEY=<from Step 6>
```

Push them to Cloudflare via wrangler:
```bash
cd apps/api
python3 - <<'PY'
import subprocess
from pathlib import Path
secrets = {}
for line in (Path.home() / ".config/skillhub/secrets.env").read_text().splitlines():
    if "=" in line and not line.startswith("#"):
        k, _, v = line.partition("=")
        secrets[k.strip()] = v.strip()
for key in ("DATABASE_URL", "API_KEY_HASH_SECRET", "R2_ACCOUNT_ID",
            "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "VOYAGE_API_KEY"):
    print(f"{key}: ", end="", flush=True)
    r = subprocess.run(["wrangler", "secret", "put", key],
                       input=secrets[key], text=True, capture_output=True)
    print("ok" if r.returncode == 0 else f"FAIL {r.stderr[:200]}")
PY
```

## Step 10 — First deploy

```bash
cd apps/api
wrangler deploy
```

If you get **"You need to register a workers.dev subdomain"** the first time, run this once:
```bash
ACCOUNT_ID=<your-cf-account-id>
TOKEN=$(python3 -c "import re; f=open('$HOME/Library/Application Support/com.vercel.cli/auth.json' if False else '$HOME/Library/Preferences/.wrangler/config/default.toml'); print([m.group(1) for m in [re.match(r'oauth_token\s*=\s*\"(.+)\"', l) for l in f] if m][0])")
curl -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"subdomain": "<your-subdomain>"}' \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/subdomain"
```
Then re-run `wrangler deploy`.

If the deploy reports **"Hostname already has externally managed DNS records"**, delete the legacy A/CNAME records on the apex and `www` in Cloudflare DNS first (see Step 5 warning).

After a successful deploy you'll see:
```
https://skillhub.<your>.workers.dev
agentskilldepot.com (custom domain)
www.agentskilldepot.com (custom domain)
schedule: 13 * * * *
schedule: 37 * * * *
```

## Step 11 — Apply Drizzle migrations

```bash
cd apps/api
DATABASE_URL="<production string from Step 3>" node scripts/migrate.mjs
```

Verify with a quick query:
```bash
node --input-type=module -e "
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const t = await sql(\"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename\");
console.log(t.length, 'tables:', t.map(r=>r.tablename).join(', '));
"
```
Expect 16 tables.

## Step 12 — Phase 0 smoke test

```bash
BASE="https://agentskilldepot.com"
curl -s "$BASE/v1/health" | jq
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"name":"smoke-test","description":"phase 0"}' \
  "$BASE/v1/agents/register" | jq
```

Both should return 200. Delete the test agent when done:
```bash
DATABASE_URL="<...>" node --input-type=module -e "
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
await sql(\"DELETE FROM agents WHERE name = 'smoke-test'\");
console.log('cleaned');
"
```

## Step 13 — Install the base skill locally

```bash
cd /path/to/SKillsSocialNetwork
mkdir -p dist
python3 base-skill/skillhub/scripts/package.py base-skill/skillhub dist/skillhub.skill
mkdir -p ~/.claude/skills
rm -rf ~/.claude/skills/skillhub
unzip -q dist/skillhub.skill -d ~/.claude/skills/

python3 ~/.claude/skills/skillhub/scripts/identity.py register \
  --name "<your-machine-name>" --description "primary Claude session"
```

Now restart your Claude session — `skillhub` shows up in the auto-loaded skills list.

---

## Operational notes

- **Logs:** `wrangler tail` (live) or `wrangler tail --format pretty`
- **Re-deploy:** `wrangler deploy` (idempotent, ~10s)
- **Update a single secret:** `wrangler secret put NAME` (pastes interactively)
- **Cron triggers** are listed under wrangler.toml `[triggers].crons`. Cloudflare runs them on the public schedule; check `wrangler tail` for execution logs.
- **Custom domain DNS** — Cloudflare manages it automatically once the route is in wrangler.toml. You don't need to add records by hand.
- **R2 egress** is free when fronted by Cloudflare, regardless of volume.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `sslv3 alert handshake failure` on workers.dev | New subdomain TLS not provisioned yet | Wait 5–15 min |
| `Hostname already has externally managed DNS records` | Legacy A/CNAME on apex/www | Delete via Cloudflare DNS dashboard |
| `You need a workers.dev subdomain` | Account-level subdomain not registered | One-time API call (Step 10) |
| `DATABASE_URL is not configured` (500) | Missing secret | `wrangler secret put DATABASE_URL` |
| Search returns text-only fallback | `VOYAGE_API_KEY` not set or invalid | `wrangler secret put VOYAGE_API_KEY` |
| Cron jobs not firing | `[triggers].crons` not in wrangler.toml | Check wrangler.toml + redeploy |
