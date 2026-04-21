#!/usr/bin/env node
/**
 * skills.sh import — Phase A (prepare).
 *
 * Reads ../skillsh-import-audit/report.json, filters to the repos classified
 * mirrorable (permissive or weak copyleft license), shallow-clones each
 * upstream into scratch/, finds the skill directories whose basenames match
 * the skills.sh slugs we care about, and packages each as a zip bundle.
 *
 * Every packaged bundle includes the upstream LICENSE at its root so the
 * license text travels with the skill — this is the attribution requirement
 * for MIT/Apache-2.0/BSD.
 *
 * Output: staging/manifest.json (one entry per prepared skill) plus the
 * zipped bundles in staging/bundles/. Phase B (commit.mjs) reads this
 * staging dir and writes to the DB + R2.
 *
 * No DB, no R2, no secrets required for Phase A.
 *
 * Usage:
 *   node scripts/skillsh-import/prepare.mjs [--skip-clone]
 */
import { execSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIT_REPORT = join(HERE, "..", "skillsh-import-audit", "report.json");
const SCRATCH = join(HERE, "scratch");
const STAGING = join(HERE, "staging");
const BUNDLES = join(STAGING, "bundles");

const SKIP_CLONE = process.argv.includes("--skip-clone");

mkdirSync(SCRATCH, { recursive: true });
mkdirSync(BUNDLES, { recursive: true });

const { results } = JSON.parse(readFileSync(AUDIT_REPORT, "utf8"));
const SAFE = results.filter((r) => r.can_mirror);

console.log(`[prepare] ${SAFE.length} safe repos, ${SAFE.reduce((n, r) => n + r.skills.length, 0)} candidate skills`);

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], ...opts }).toString();
}

function cloneOrUpdate(repo) {
  const dir = join(SCRATCH, repo.replace("/", "__"));
  if (SKIP_CLONE && existsSync(dir)) return dir;
  if (existsSync(dir)) {
    try { run(`git -C "${dir}" fetch --depth=1 origin HEAD`); } catch {}
    try { run(`git -C "${dir}" reset --hard FETCH_HEAD`); } catch {}
    return dir;
  }
  const url = `https://github.com/${repo}.git`;
  console.log(`  clone ${repo}`);
  const res = spawnSync("git", ["clone", "--depth=1", url, dir], { stdio: "inherit" });
  if (res.status !== 0) throw new Error(`clone failed: ${repo}`);
  return dir;
}

/** Canonicalize a name for fuzzy directory matching: lowercase, replace
 *  non-alphanumeric with a single separator, trim. "Use_case Study" → "use-case-study". */
function canonicalize(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Find a directory matching `slug` anywhere inside `root`. Prefers:
 *   1. Exact basename match at shallowest depth.
 *   2. Canonicalized match (case-insensitive, '-'/'_' interchangeable) at
 *      shallowest depth.
 *   3. Canonicalized match on a SKILL.md frontmatter `name` field (some
 *      repos name their directories differently from the skills.sh slug).
 * Returns null if no candidate found.
 */
function findSkillDir(root, slug) {
  const canonSlug = canonicalize(slug);
  const exact = [];
  const fuzzy = [];
  const byFrontmatter = [];

  function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === ".git" || e.name === "node_modules") continue;
      const full = join(dir, e.name);
      if (e.name === slug) exact.push({ path: full, depth });
      else if (canonicalize(e.name) === canonSlug) fuzzy.push({ path: full, depth });
      else {
        // Check SKILL.md frontmatter 'name' only for reasonably shallow
        // dirs to keep this cheap.
        if (depth <= 3) {
          const skillMd = join(full, "SKILL.md");
          if (existsSync(skillMd)) {
            try {
              const fm = readSkillFrontmatterAt(skillMd);
              if (fm?.name && canonicalize(fm.name) === canonSlug) {
                byFrontmatter.push({ path: full, depth });
              }
            } catch { /* ignore */ }
          }
        }
      }
      walk(full, depth + 1);
    }
  }
  walk(root, 0);
  const pool = exact.length > 0 ? exact : fuzzy.length > 0 ? fuzzy : byFrontmatter;
  pool.sort((a, b) => a.depth - b.depth);
  return pool[0]?.path ?? null;
}

/** Lightweight frontmatter reader used by findSkillDir (parse reduced here
 *  to avoid forward-reference to readSkillFrontmatter defined later). */
function readSkillFrontmatterAt(path) {
  const txt = readFileSync(path, "utf8");
  const m = /^---\n([\s\S]*?)\n---/m.exec(txt);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = /^\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    let val = kv[2];
    if ((val.startsWith("\"") && val.endsWith("\"")) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[kv[1].toLowerCase()] = val;
  }
  return out;
}

/** Locate the LICENSE file at repo root. */
function findLicense(root) {
  const candidates = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"];
  for (const name of candidates) {
    const p = join(root, name);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

/** Read SKILL.md YAML-ish frontmatter. Returns {name, description, version} where present. */
function readSkillFrontmatter(skillDir) {
  const skillMd = join(skillDir, "SKILL.md");
  if (!existsSync(skillMd)) return null;
  const txt = readFileSync(skillMd, "utf8");
  const m = /^---\n([\s\S]*?)\n---/m.exec(txt);
  if (!m) return { raw: true };
  const frontmatter = m[1];
  const out = {};
  for (const line of frontmatter.split("\n")) {
    const kv = /^\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    let val = kv[2];
    if ((val.startsWith("\"") && val.endsWith("\"")) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[kv[1].toLowerCase()] = val;
  }
  return out;
}

/** Zip a directory (using the system `zip` binary — ubiquitous on macOS/Linux). */
function zipDir(srcDir, outZip) {
  if (existsSync(outZip)) rmSync(outZip);
  const res = spawnSync("zip", ["-r", "-q", outZip, "."], { cwd: srcDir });
  if (res.status !== 0) throw new Error(`zip failed for ${srcDir}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const MIRROR_PREFIX = "sh-"; // skills.sh namespace prefix — avoids collisions with native publishes.
const staged = [];
const skipped = [];

for (const repoEntry of SAFE) {
  let repoDir;
  try { repoDir = cloneOrUpdate(repoEntry.repo); }
  catch (e) {
    console.warn(`  skip repo ${repoEntry.repo}: ${e.message}`);
    for (const s of repoEntry.skills) skipped.push({ slug: s, reason: "clone_failed", repo: repoEntry.repo });
    continue;
  }

  const licensePath = findLicense(repoDir);
  if (!licensePath) {
    console.warn(`  skip repo ${repoEntry.repo}: no LICENSE file on disk despite GitHub metadata`);
    for (const s of repoEntry.skills) skipped.push({ slug: s, reason: "no_license_file_on_disk", repo: repoEntry.repo });
    continue;
  }

  for (const slug of repoEntry.skills) {
    const skillDir = findSkillDir(repoDir, slug);
    if (!skillDir) {
      skipped.push({ slug, reason: "skill_dir_not_found", repo: repoEntry.repo });
      continue;
    }

    const fm = readSkillFrontmatter(skillDir) ?? {};
    const mirroredSlug = `${MIRROR_PREFIX}${slug}`;
    const version = fm.version || "1.0.0";
    const displayName = fm.name || slug;
    const shortDesc = (fm.description || `Mirror of ${slug} from ${repoEntry.repo}.`).slice(0, 290);

    // Stage a copy we can modify (add LICENSE + ATTRIBUTION.md) without mutating the clone.
    const stageDir = join(STAGING, "work", mirroredSlug);
    if (existsSync(stageDir)) rmSync(stageDir, { recursive: true });
    cpSync(skillDir, stageDir, { recursive: true });

    // Preserve upstream LICENSE inside the bundle (SPDX attribution requirement).
    cpSync(licensePath, join(stageDir, "LICENSE.upstream"));

    // Attribution note — makes provenance visible even without the manifest.
    const attribution = [
      `# Attribution`,
      ``,
      `This skill is mirrored by Agent Skill Depot from the upstream repository:`,
      ``,
      `- Upstream: ${repoEntry.html_url}`,
      `- Original author: ${repoEntry.author}`,
      `- Original slug: \`${slug}\``,
      `- License: ${repoEntry.license_spdx} (see LICENSE.upstream)`,
      `- Surfaced via: skills.sh`,
      ``,
      `All modifications made by Agent Skill Depot during mirroring are limited to`,
      `adding this ATTRIBUTION.md and LICENSE.upstream.`,
      ``,
    ].join("\n");
    writeFileSync(join(stageDir, "ATTRIBUTION.md"), attribution);

    // Package.
    const outZip = join(BUNDLES, `${mirroredSlug}__${version}.zip`);
    zipDir(stageDir, outZip);
    const zipBytes = readFileSync(outZip);
    const contentHash = sha256(zipBytes);

    staged.push({
      mirrored_slug: mirroredSlug,
      original_slug: slug,
      upstream_repo: repoEntry.repo,
      upstream_url: repoEntry.html_url,
      original_author: repoEntry.author,
      license_spdx: repoEntry.license_spdx,
      display_name: displayName,
      short_desc: shortDesc,
      long_desc_md: attribution,
      version,
      bundle_path: relative(HERE, outZip),
      size_bytes: zipBytes.length,
      content_hash: contentHash,
      r2_key: `skills/${mirroredSlug}/v${version}.skill`,
    });
    console.log(`  ✓ ${mirroredSlug} (${(zipBytes.length / 1024).toFixed(1)} KB)`);
  }
}

const manifest = {
  prepared_at: new Date().toISOString(),
  mirror_source: "skills.sh",
  bot_agent_name: "skills-sh-mirror",
  count_staged: staged.length,
  count_skipped: skipped.length,
  skipped,
  skills: staged,
};
writeFileSync(join(STAGING, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log(`\n[prepare] staged=${staged.length} skipped=${skipped.length}`);
console.log(`[prepare] manifest → ${relative(process.cwd(), join(STAGING, "manifest.json"))}`);
console.log(`[prepare] next: run commit.mjs with DATABASE_URL + wrangler configured`);
