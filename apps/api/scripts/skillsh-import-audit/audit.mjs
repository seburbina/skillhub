#!/usr/bin/env node
/**
 * License audit for skills.sh upstream repos.
 *
 * For each repo in repos.json, queries the GitHub API (via `gh`) for the
 * canonical LICENSE metadata, then classifies whether the skills sourced
 * from that repo can be mirrored into Agent Skill Depot.
 *
 * Output: report.md (human-readable) + report.json (machine-readable) in
 * this directory. No DB writes — mirroring/ingestion is a separate step
 * the operator runs after reviewing this report.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOS = JSON.parse(readFileSync(join(HERE, "repos.json"), "utf8")).repos;

// SPDX classification. "permissive" → safe to mirror with attribution.
// "copyleft_weak" → safe but must preserve license text + redistribute under same terms.
// "copyleft_strong" → avoid; viral to downstream users.
// "none" / "proprietary" → cannot mirror.
const CLASSIFICATION = {
  "MIT": "permissive",
  "Apache-2.0": "permissive",
  "BSD-2-Clause": "permissive",
  "BSD-3-Clause": "permissive",
  "ISC": "permissive",
  "0BSD": "permissive",
  "Unlicense": "permissive",
  "CC0-1.0": "permissive",
  "MPL-2.0": "copyleft_weak",
  "LGPL-2.1": "copyleft_weak",
  "LGPL-3.0": "copyleft_weak",
  "GPL-2.0": "copyleft_strong",
  "GPL-3.0": "copyleft_strong",
  "AGPL-3.0": "copyleft_strong",
};

function classify(spdx) {
  if (!spdx || spdx === "NOASSERTION") return "unknown";
  return CLASSIFICATION[spdx] ?? "other";
}

function canMirror(klass) {
  return klass === "permissive" || klass === "copyleft_weak";
}

async function fetchLicense(repo) {
  try {
    const raw = execSync(`gh api repos/${repo} --jq '{license: .license.spdx_id, license_name: .license.name, license_url: .license.url, description: .description, default_branch: .default_branch, html_url: .html_url, archived: .archived}'`, { stdio: ["ignore", "pipe", "pipe"] }).toString();
    return { ok: true, ...JSON.parse(raw) };
  } catch (e) {
    const stderr = (e.stderr?.toString() || e.message || "").trim();
    return { ok: false, error: stderr };
  }
}

const results = [];
for (const entry of REPOS) {
  process.stderr.write(`→ ${entry.repo}\n`);
  const info = await fetchLicense(entry.repo);
  const spdx = info.ok ? info.license : null;
  const klass = classify(spdx);
  results.push({
    repo: entry.repo,
    author: entry.author,
    skills: entry.skills,
    fetched: info.ok,
    error: info.ok ? null : info.error,
    archived: info.archived ?? null,
    html_url: info.html_url ?? `https://github.com/${entry.repo}`,
    license_spdx: spdx,
    license_name: info.license_name ?? null,
    license_url: info.license_url ?? null,
    classification: klass,
    can_mirror: canMirror(klass),
  });
}

// Summary counts
const summary = {
  total_repos: results.length,
  total_skills: results.reduce((n, r) => n + r.skills.length, 0),
  by_classification: {},
  mirrorable_skills: 0,
  non_mirrorable_skills: 0,
  failed_lookups: 0,
};
for (const r of results) {
  summary.by_classification[r.classification] = (summary.by_classification[r.classification] || 0) + 1;
  if (!r.fetched) summary.failed_lookups++;
  if (r.can_mirror) summary.mirrorable_skills += r.skills.length;
  else summary.non_mirrorable_skills += r.skills.length;
}

writeFileSync(join(HERE, "report.json"), JSON.stringify({ summary, results }, null, 2));

// Markdown report
const md = [];
md.push("# skills.sh Import License Audit");
md.push("");
md.push(`Snapshot date: 2026-04-20. ${summary.total_repos} unique upstream repos covering ${summary.total_skills} skills from the skills.sh directory.`);
md.push("");
md.push("## Summary");
md.push("");
md.push(`- Skills safe to mirror (permissive + weak copyleft): **${summary.mirrorable_skills}**`);
md.push(`- Skills NOT safe to mirror (no license / strong copyleft / unknown): **${summary.non_mirrorable_skills}**`);
md.push(`- Repos by classification:`);
for (const [k, v] of Object.entries(summary.by_classification).sort()) md.push(`  - ${k}: ${v}`);
if (summary.failed_lookups) md.push(`- Lookup failures (repo missing / private / renamed): ${summary.failed_lookups}`);
md.push("");
md.push("## Safe to mirror");
md.push("");
md.push("| Repo | Author | License | Skills |");
md.push("|---|---|---|---|");
for (const r of results.filter((r) => r.can_mirror).sort((a, b) => a.repo.localeCompare(b.repo))) {
  md.push(`| [${r.repo}](${r.html_url}) | ${r.author} | ${r.license_spdx} | ${r.skills.join(", ")} |`);
}
md.push("");
md.push("## Requires manual review");
md.push("");
md.push("| Repo | Author | License | Reason | Skills |");
md.push("|---|---|---|---|---|");
for (const r of results.filter((r) => !r.can_mirror).sort((a, b) => a.repo.localeCompare(b.repo))) {
  const reason = !r.fetched
    ? `lookup failed (${r.error?.slice(0, 80) ?? "unknown"})`
    : r.license_spdx == null
      ? "no LICENSE file detected"
      : r.classification === "copyleft_strong"
        ? "strong copyleft — would bind depot to GPL/AGPL"
        : r.classification === "unknown"
          ? "NOASSERTION from GitHub"
          : `classification: ${r.classification}`;
  md.push(`| [${r.repo}](${r.html_url}) | ${r.author} | ${r.license_spdx ?? "—"} | ${reason} | ${r.skills.join(", ")} |`);
}
md.push("");
md.push("## Attribution template");
md.push("");
md.push("For each mirrored skill, store on the `skills` row:");
md.push("");
md.push("- `upstream_url` — the repo URL");
md.push("- `original_author` — the author name above");
md.push("- `license_spdx` — the SPDX ID (already in schema)");
md.push("- Long description should prepend: *\"Mirrored from [owner/repo](url) by {author}, licensed under {SPDX}. Originally surfaced via skills.sh.\"*");
md.push("");
md.push("The `LICENSE` file from the upstream repo MUST be shipped inside the mirrored bundle (R2 object) so the license text travels with the skill per MIT/Apache-2.0/BSD terms.");
md.push("");

writeFileSync(join(HERE, "report.md"), md.join("\n"));
process.stderr.write(`\nWrote report.md and report.json (${summary.mirrorable_skills} mirrorable skills, ${summary.non_mirrorable_skills} need review)\n`);
