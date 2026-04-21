# skills.sh import pipeline

Mirrors permissively-licensed skills from the [skills.sh](https://skills.sh) directory into Agent Skill Depot with full upstream attribution. Paired with the license audit in `../skillsh-import-audit/`.

## Two phases

**Phase A — `prepare.mjs`** (offline, no secrets):
- Reads `../skillsh-import-audit/report.json`
- Clones each mirrorable repo into `scratch/` (shallow)
- Locates each skill directory by slug match
- Copies upstream `LICENSE` into the bundle as `LICENSE.upstream`
- Writes an `ATTRIBUTION.md` into the bundle with repo + author + license
- Packages each skill as a zip under `staging/bundles/`
- Emits `staging/manifest.json` listing every staged skill

**Phase B — `commit.mjs`** (requires DB + R2):
- Ensures the `skills-sh-mirror` bot agent exists
- For each staged skill: uploads the zip to R2 via `wrangler r2 object put`
- Inserts `skills` + `skill_versions` rows with `mirrored_from='skills.sh'`, `upstream_url`, `original_author`
- Idempotent on slug — re-running skips what already committed

## Running

```sh
# Phase A
node scripts/skillsh-import/prepare.mjs

# Phase B (dry run first!)
node scripts/skillsh-import/commit.mjs --dry-run
DATABASE_URL=postgres://... R2_BUCKET_NAME=skillhub-skills-prod WRANGLER_ENV=production \
  node scripts/skillsh-import/commit.mjs
```

## Slug convention

Mirrored skills are namespaced with `sh-` prefix (e.g. `sh-turborepo`, `sh-vue`) so they can never collide with native publishes. The original slug is preserved in `skills.upstream_url` and in `ATTRIBUTION.md` inside the bundle.

## Attribution requirements

Per MIT / Apache-2.0 / BSD license terms:
- The upstream `LICENSE` ships inside every bundle as `LICENSE.upstream`
- An `ATTRIBUTION.md` inside the bundle names the original author + repo
- The `skills` row persists `original_author` and `upstream_url` for UI display

## Re-sync

`prepare.mjs` fetches `FETCH_HEAD` on subsequent runs. To pull upstream updates, re-run prepare, then run `commit.mjs` — idempotent on slug, so updated versions need a version bump (future work: diff-aware resync producing a new semver).
