# Branch protection — main

## Current state (verified 2026-05-06)

Required status checks (strict mode ON — PRs must be up-to-date with main before merge):

- api (typecheck Cloudflare Worker)
- base-skill (sanitize + package smoke test)
- api-changelog (enforce docs/api-changelog.md update)

Source: `gh api repos/seburbina/skillhub/branches/main/protection`.

Verified output (`--jq '{strict: .required_status_checks.strict, contexts: .required_status_checks.contexts}'`):

```json
{
  "strict": true,
  "contexts": [
    "api (typecheck Cloudflare Worker)",
    "base-skill (sanitize + package smoke test)",
    "api-changelog (enforce docs/api-changelog.md update)"
  ]
}
```

## The strict-mode tradeoff

**For:** catches semantic conflicts that static checks miss. Two PRs that each pass tests independently can break main when merged together — strict mode forces the second PR to rebase, re-run, and prove the combined state still passes.

**Against:** adds latency proportional to merge rate. Each merge invalidates every other open PR's freshness, requiring a re-run before each one can merge. Manifests as: green PR sits for 60s, then "Update branch" button appears, then ~3 min for re-run.

## Recommendation: keep strict, add `--auto`

Add `gh pr merge --auto --squash --delete-branch` to PR-creation workflows so PRs auto-merge themselves once green AND up-to-date — the rebase-then-merge step happens without operator intervention.

Cost: zero. Operator sees PR open, walks away, gets notification when merged.

## Alternative if friction continues to bite: drop strict

If `--auto` proves insufficient (e.g. a very chatty release cycle), drop `strict: true`. Required-checks still enforced, but PRs that passed once stay passable until merged. Downside: rare semantic-conflict bugs land. Backstop: post-merge CI on main catches them within minutes.

## How to change (operator action)

GitHub UI: Settings → Branches → Branch protection rules → main → uncheck "Require branches to be up to date before merging".

Or CLI:
```bash
gh api repos/seburbina/skillhub/branches/main/protection -X PUT --input - <<EOF
{
  "required_status_checks": {
    "strict": false,
    "contexts": [
      "api (typecheck Cloudflare Worker)",
      "base-skill (sanitize + package smoke test)",
      "api-changelog (enforce docs/api-changelog.md update)"
    ]
  },
  ...
}
EOF
```

## Decision log

- 2026-04-21: original strict mode set up (history unrecorded)
- 2026-05-06: documented; recommendation is `--auto` first, drop-strict as fallback
