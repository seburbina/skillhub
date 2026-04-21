#!/usr/bin/env node
/**
 * skills.sh import — Phase B (commit).
 *
 * Reads staging/manifest.json produced by prepare.mjs, then:
 *   1. Ensures a bot agent `skills-sh-mirror` exists (creates with a random
 *      api_key_hash the operator will never use — the bot owns mirrored
 *      skills on paper; it never publishes via the API).
 *   2. For each staged skill: uploads the zip to R2 via `wrangler r2 object
 *      put`, then inserts `skills` and `skill_versions` rows.
 *   3. Idempotent on mirrored_slug — skips anything already present.
 *
 * Required env:
 *   DATABASE_URL          Neon connection string
 *   R2_BUCKET_NAME        e.g. skillhub-skills-prod or skillhub-skills-dev
 *   WRANGLER_ENV          Optional. Pass `dev` to target [env.dev] in
 *                         wrangler.toml. Leave UNSET for production —
 *                         wrangler.toml does not declare [env.production],
 *                         prod is the top-level (default) environment.
 *
 * Usage:
 *   # dev
 *   DATABASE_URL=... R2_BUCKET_NAME=skillhub-skills-dev WRANGLER_ENV=dev \
 *     node scripts/skillsh-import/commit.mjs
 *   # prod (no WRANGLER_ENV)
 *   DATABASE_URL=... R2_BUCKET_NAME=skillhub-skills-prod \
 *     node scripts/skillsh-import/commit.mjs
 *   # add --dry-run to skip R2 + DB writes (prints what it would do)
 */
import { neon } from "@neondatabase/serverless";
import { execSync, spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, "staging", "manifest.json");

const DRY = process.argv.includes("--dry-run");
const { DATABASE_URL, R2_BUCKET_NAME, WRANGLER_ENV } = process.env;

if (!DRY && !DATABASE_URL) { console.error("DATABASE_URL required (or pass --dry-run)"); process.exit(1); }
if (!DRY && !R2_BUCKET_NAME) { console.error("R2_BUCKET_NAME required (or pass --dry-run)"); process.exit(1); }

const sql = DRY ? null : neon(DATABASE_URL);
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
console.log(`[commit] ${manifest.count_staged} skills staged (dry-run=${DRY})`);

// ---- Ensure bot agent --------------------------------------------------

async function ensureBotAgent() {
  if (DRY) return "00000000-0000-0000-0000-000000000000";
  const existing = await sql(`SELECT id FROM agents WHERE name = $1 AND owner_user_id IS NULL LIMIT 1`, [manifest.bot_agent_name]);
  if (existing.length > 0) return existing[0].id;
  // Create with an unusable API key. The bot never authenticates — it's
  // just an owner-of-record for mirrored skills.
  const key = randomBytes(32).toString("hex");
  const apiKeyHash = createHash("sha256").update(key).digest("hex");
  const rows = await sql(
    `INSERT INTO agents (name, description, api_key_hash, api_key_prefix)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      manifest.bot_agent_name,
      "Bot agent that owns skills mirrored from skills.sh. Never publishes via the API.",
      apiKeyHash,
      "skillsh_mirror_",
    ],
  );
  return rows[0].id;
}

// ---- R2 upload via wrangler --------------------------------------------

function uploadToR2(bundlePath, r2Key) {
  const absBundle = resolve(HERE, bundlePath);
  if (DRY) { console.log(`    [dry] wrangler r2 object put ${R2_BUCKET_NAME}/${r2Key} --file=${absBundle}`); return; }
  const wranglerBin = process.env.WRANGLER_BIN || "pnpm";
  const wranglerArgs = wranglerBin === "pnpm" ? ["exec", "wrangler"] : [];
  const args = [
    ...wranglerArgs,
    "r2", "object", "put",
    `${R2_BUCKET_NAME}/${r2Key}`,
    `--file=${absBundle}`,
    "--content-type=application/zip",
  ];
  if (WRANGLER_ENV) args.push(`--env=${WRANGLER_ENV}`);
  const res = spawnSync(wranglerBin, args, { stdio: "inherit" });
  if (res.status !== 0) throw new Error(`wrangler r2 put failed for ${r2Key}`);
}

// ---- Main --------------------------------------------------------------

const botId = await ensureBotAgent();
console.log(`[commit] bot agent id = ${botId}`);

let inserted = 0;
let skipped = 0;
let failed = 0;

for (const s of manifest.skills) {
  try {
    // Idempotency check.
    if (!DRY) {
      const existing = await sql(`SELECT id FROM skills WHERE slug = $1 LIMIT 1`, [s.mirrored_slug]);
      if (existing.length > 0) { skipped++; console.log(`  = ${s.mirrored_slug} (already present)`); continue; }
    }

    uploadToR2(s.bundle_path, s.r2_key);

    if (DRY) { inserted++; console.log(`  [dry] + ${s.mirrored_slug}`); continue; }

    const [skillRow] = await sql(
      `INSERT INTO skills (
         slug, author_agent_id, display_name, short_desc, long_desc_md,
         category, tags, license_spdx,
         upstream_url, original_author, mirrored_from
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8,
         $9, $10, $11
       ) RETURNING id`,
      [
        s.mirrored_slug, botId, s.display_name, s.short_desc, s.long_desc_md,
        null, [], s.license_spdx,
        s.upstream_url, s.original_author, "skills.sh",
      ],
    );
    const skillId = skillRow.id;

    // Populate sha256_digest if the column exists on this DB (it was added
    // with the .well-known endpoint migration — may be absent on older
    // environments).
    const hasDigest = await sql(
      `SELECT 1 FROM information_schema.columns WHERE table_name='skill_versions' AND column_name='sha256_digest' LIMIT 1`,
    ).then((r) => r.length > 0).catch(() => false);

    const [versionRow] = hasDigest
      ? await sql(
          `INSERT INTO skill_versions (skill_id, semver, content_hash, sha256_digest, size_bytes, r2_key, review_status)
           VALUES ($1, $2, $3, $4, $5, $6, 'approved') RETURNING id`,
          [skillId, s.version, s.content_hash, `sha256:${s.content_hash}`, s.size_bytes, s.r2_key],
        )
      : await sql(
          `INSERT INTO skill_versions (skill_id, semver, content_hash, size_bytes, r2_key, review_status)
           VALUES ($1, $2, $3, $4, $5, 'approved') RETURNING id`,
          [skillId, s.version, s.content_hash, s.size_bytes, s.r2_key],
        );

    await sql(`UPDATE skills SET current_version_id = $1 WHERE id = $2`, [versionRow.id, skillId]);

    inserted++;
    console.log(`  + ${s.mirrored_slug} (v${s.version})`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${s.mirrored_slug}: ${e.message}`);
  }
}

console.log(`\n[commit] inserted=${inserted} skipped=${skipped} failed=${failed}`);
if (!DRY) console.log(`[commit] next: run scripts/embed-mirror-batch.mjs to populate embeddings (optional)`);
