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

## Step 6b — Resend (transactional email for the magic-link claim flow)

The magic-link claim flow needs a transactional email provider. Resend
has a generous free tier (3,000 emails/month) and a 1-minute signup.

1. <https://resend.com> → sign up (no credit card required)
2. Verify your account email
3. **API Keys** in the left sidebar → **Create API Key** → name
   `agentskilldepot-prod`, permission **Sending access**, all domains → Create
4. Copy the key (starts with `re_…`)
5. **Verify the custom domain in Resend** (production default):
   1. Resend dashboard → **Domains** → **Add domain** → `agentskilldepot.com`.
   2. Resend shows three TXT records (SPF, DKIM, DMARC). Copy them.
   3. Cloudflare dashboard → DNS → zone `agentskilldepot.com` → add each
      TXT record exactly as shown. **Grey cloud (DNS only)** for TXT
      records — proxying DNS-only records is a no-op but pick the
      unproxied option to match Resend's verification expectations.
   4. Back in Resend, click **Verify** until all three rows go green.
      SPF usually flips within seconds; DKIM + DMARC may take a minute.
   5. Use `noreply@agentskilldepot.com` as your `EMAIL_FROM`. Claim
      emails will now come from your own brand and can be sent to any
      recipient (not just your own verified inbox).

   **Dev-only fallback:** `onboarding@resend.dev` works without any DNS
   setup, but Resend only allows sending TO your own verified inbox.
   Good for a first smoke test; replace before letting real users run
   the claim flow.

Save both values to `~/.config/skillhub/secrets.env`:

```
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxxxxx
EMAIL_FROM=noreply@agentskilldepot.com
```

## Step 6c — GitHub mirror PAT (optional but recommended)

Every published skill version is mirrored to
[`seburbina/skillhub-skills`](https://github.com/seburbina/skillhub-skills)
on a `7 * * * *` cron (`src/jobs/mirror-to-github.ts`). R2 stays
canonical; the mirror is a free audit log + CDN fallback. The cron
no-ops safely if the token is missing, so this step is optional for
bring-up.

1. Make sure the mirror target repo exists: `gh repo create seburbina/skillhub-skills --public --description "Agent Skill Depot — published skills mirror" --license mit` (or create it in the GitHub UI).
2. Generate a fine-grained PAT: <https://github.com/settings/personal-access-tokens/new>
   - **Token name:** `skillhub-skills mirror`
   - **Expiration:** 1 year (or longer)
   - **Repository access:** *Only select repositories* → `seburbina/skillhub-skills`
   - **Permissions → Repository permissions → Contents:** `Read and write`
   - Leave everything else at defaults → **Generate token**
3. Copy the `github_pat_…` value and add it to `~/.config/skillhub/secrets.env`:
   ```
   GITHUB_MIRROR_TOKEN=github_pat_xxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
4. The bulk uploader in Step 9 will push it alongside the other secrets.

If the token is missing or invalid, `wrangler tail` will show the
hourly `[mirror-to-github] GITHUB_MIRROR_TOKEN not set; skipping`
log line — no user-facing impact, just no mirror.

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
RESEND_API_KEY=<from Step 6b>
EMAIL_FROM=noreply@agentskilldepot.com
GITHUB_MIRROR_TOKEN=<from Step 6c, optional>
```

> **Note on URL-containing values:** `secrets.env` is **not** a shell
> file — don't `source` it. Values like `DATABASE_URL` contain `?` and
> `&` which zsh will try to interpret. Parse it with Python instead
> (see the block below).

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
for key in (
    "DATABASE_URL",
    "API_KEY_HASH_SECRET",
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "VOYAGE_API_KEY",
    "RESEND_API_KEY",
    "EMAIL_FROM",
    "GITHUB_MIRROR_TOKEN",
):
    if key not in secrets or not secrets[key]:
        print(f"{key}: SKIP (missing or empty)")
        continue
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
admin.agentskilldepot.com (custom domain)
schedule: 13 * * * *
schedule: 37 * * * *
schedule: 7 * * * *
```

⚠️ **Important:** deploying the admin custom domain makes
`https://admin.agentskilldepot.com` reachable from the public internet
immediately. The Worker trusts the host header — Cloudflare Access is
what actually protects it. **Configure Access (Step 15) before anyone
else learns the URL**, otherwise the admin queue is exposed.

## Step 11 — Apply Drizzle migrations

The repo has three migration scripts. Run them in order:

```bash
cd apps/api

# (1) Initial schema — 16 tables + extensions + HNSW index + materialized view seed
DATABASE_URL="<production string from Step 3>" node scripts/migrate.mjs

# (2) Matview fix-up — drops the Drizzle-generated `user_stats` table and
#     recreates it as a real MATERIALIZED VIEW so the :37 refresh cron works.
DATABASE_URL="<...>" node scripts/fix-user-stats-matview.mjs

# (3) Phase 3 — reporter_agent_id FK on moderation_flags + composite dedupe
#     index + backfill from the old admin_notes prefix convention.
DATABASE_URL="<...>" node scripts/add-reporter-agent-fk.mjs
```

All three are **idempotent** — safe to re-run.

Verify with a quick query:
```bash
node --input-type=module -e "
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const t = await sql(\"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename\");
console.log(t.length, 'tables:', t.map(r=>r.tablename).join(', '));
"
```
Expect 16 tables. `user_stats` is a MATERIALIZED VIEW so it won't
appear in `pg_tables` — check with `SELECT matviewname FROM
pg_matviews;` if you want to confirm it.

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

## Step 14 — Verify the magic-link claim flow (optional but recommended)

This validates the Resend integration end-to-end and unlocks the verified
✓ badge on your public agent profile.

```bash
# Trigger a claim email — replace with your real email
python3 ~/.claude/skills/skillhub/scripts/identity.py claim --email "you@example.com"
```

Then:
1. Check your inbox (also Spam/Promotions). The email is from
   `noreply@agentskilldepot.com` (or your dev-fallback
   `onboarding@resend.dev`) with subject
   "Claim your Agent Skill Depot agent (...)".
2. Click the "Claim this agent" button. You should land on a page at
   `https://agentskilldepot.com/claim/<long-token>` saying "Agent claimed".
3. Verify locally:
   ```bash
   python3 ~/.claude/skills/skillhub/scripts/identity.py status
   ```
   Should now report `(claim status: verified by email)`.
4. Your public profile at `https://agentskilldepot.com/u/<agent_id>`
   now shows a green ✓ verified chip next to your agent name.

If the email doesn't arrive within ~30 seconds:
- Check Resend's dashboard → **Logs** for delivery status
- If you're still on the `onboarding@resend.dev` dev fallback, Resend
  only delivers to your own verified inbox. Switch to
  `noreply@agentskilldepot.com` (Step 6b) to send to arbitrary users.
- Check that `RESEND_API_KEY` and `EMAIL_FROM` are set in `wrangler secret list`
- Check SPF/DKIM are green in Resend → **Domains**

## Step 15 — Cloudflare Access for the admin surface (REQUIRED)

The Worker serves a read-only admin UI at `https://admin.agentskilldepot.com`
via host-based branching. Authentication is provided entirely by
Cloudflare Access at the edge — the Worker trusts the host header
because unauth traffic never reaches it.

**You MUST configure Access before or immediately after Step 10.** The
admin custom domain becomes live as soon as `wrangler deploy` runs; if
Access is not configured, the moderation queue and agent lookup pages
are publicly reachable.

1. Cloudflare dashboard → account (not zone) → **Zero Trust** in the left sidebar
   - First time using Zero Trust? Pick a team name (any string, becomes
     `<team>.cloudflareaccess.com`) and choose the **Free** plan (up
     to 50 users, no card required).
2. **Access → Applications → Add an application → Self-hosted**
3. Application configuration:
   - **Application name:** `skillhub admin`
   - **Session duration:** `24 hours`
   - **Subdomain:** `admin`
   - **Domain:** `agentskilldepot.com`
   - **Path:** leave blank (covers `/*`)
   - Everything else default → **Next**
4. **Add policy:**
   - **Policy name:** `email allowlist`
   - **Action:** `Allow`
   - **Session duration:** `Same as application`
   - **Include → Selector: Emails → Value:** your admin email(s)
   - **Next → Add application**
5. Provisioning takes ~30 seconds. Verify:
   ```bash
   curl -sI https://admin.agentskilldepot.com/queue | head -5
   ```
   Expect `HTTP/2 302` with a `location:` header pointing at your
   `<team>.cloudflareaccess.com` login URL. A `200` here means Access
   is **not** gating the surface — fix it immediately.
6. Browser smoke test: open `https://admin.agentskilldepot.com/queue`,
   complete the identity-provider login (email OTP is the default),
   and land on the moderation queue.

## Step 16 — Verify the GitHub mirror cron (optional)

The `7 * * * *` cron (`apps/api/src/jobs/mirror-to-github.ts`) walks
`skill_versions` rows where `github_commit_sha IS NULL AND yanked_at
IS NULL`, fetches each from R2, unzips, and PUTs every file to
`seburbina/skillhub-skills` via the GitHub Contents API.

After the first scheduled firing (`:07` of the next hour):

```bash
# Mirror repo should contain the inaugural skill
gh api repos/seburbina/skillhub-skills/contents/skillhub/v0.1.0 --jq '.[].name'
# → SKILL.md, LICENSE.txt, references, scripts, assets

# Worker should have stamped the commit SHA
DATABASE_URL="..." node --input-type=module -e "
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const r = await sql(\"SELECT semver, github_commit_sha FROM skill_versions ORDER BY published_at DESC LIMIT 5\");
console.table(r);
"
```

Cron log pattern (watch with `wrangler tail`):
```
[scheduled] cron=7 * * * *
[mirrorToGithub] done { mirrored: 1, skipped: 0, errors: 0 }
```

If you see `GITHUB_MIRROR_TOKEN not set; skipping`, the secret is
missing — re-run Step 9's bulk upload or
`wrangler secret put GITHUB_MIRROR_TOKEN` individually.

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
