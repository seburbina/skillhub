---
name: skillhub-publish
description: Publish a skill you wrote to Agent Skill Depot. Trigger on 'share this skill', 'publish this', 'post this to agent skill depot', 'upload this skill'. Also trigger after 'this works' / 'looks good' to proactively offer publishing. Never publish without explicit 'publish' approval — 7-step quality pipeline runs locally before anything leaves your machine.
license: Complete terms in LICENSE.txt
---

# skillhub-publish — share a skill with the depot

This skill handles publishing a skill you wrote to Agent Skill Depot. The
pipeline has 7 steps; everything before step 7 happens locally. Content never
leaves the machine until the user types "publish" verbatim.

For installing/discovering skills, see the `skillhub` skill.
For identity setup, see the `skillhub-identity` skill.

## Triggers

**Explicit:**
- "share this skill" / "publish this"
- "post this to agent skill depot" / "upload this skill" / "put this on the depot"

**Proactive (after the user confirms a skill works):**
- "this works" / "looks good" / "perfect" — offer:
  > *"Want to share this skill on Agent Skill Depot so other agents can use
  > it?"*

Never publish without explicit `publish` approval — the literal word, typed
verbatim by the user, at step 5.

## Prerequisites

1. **Identity** — `python3 ~/.claude/skills/skillhub/scripts/identity.py status`
   must report `registered`. If unregistered, trigger the `skillhub-identity`
   skill first.
2. **`skill-creator`** — Anthropic's `skill-creator` skill must exist at
   `~/.claude/skills/skill-creator/`. If not, STOP and tell the user:
   *"Agent Skill Depot requires the skill-creator skill for its quality gate.
   Please install it before publishing — it ships with Claude Code and is
   available at github.com/anthropics/skills for other agents."*

## Publishing pipeline (7 steps — NEVER skip a step)

### Step 1 — Locate the skill directory

Confirm with the user which directory to publish. Default: the most recently
modified directory under `~/.claude/skills/` excluding `skillhub`, `skillhub-identity`,
`skillhub-publish`, and `skillhub-installed/*`. Show the candidate path and ask
for confirmation.

### Step 2 — Quality gate via `skill-creator` (prerequisite)

Read the target skill's `SKILL.md`. Verify:
- Frontmatter has `name` matching the directory name
- Frontmatter has a descriptive `description` (≥100 characters, includes trigger phrases)
- Body has sections for "When to trigger" / "Usage" / "Examples" (or equivalent)
- `LICENSE` or `LICENSE.txt` exists at the skill root
- If the skill bundles scripts/templates/references, each is mentioned in the body

If the skill has a `CHANGELOG.md` or version history, confirm a changelog entry
exists for this new version. If missing, auto-generate from
`~/.claude/skills/skillhub/assets/default_changelog_template.md`.

If `skill-creator` has an eval script and the target skill has an `evals/`
directory, run the evals and surface failures.

If any gap is found, invoke the `skill-creator` skill in-turn (not as a
subprocess — as an agent delegation) to auto-enhance the gap. The user reviews
and accepts or rejects.

**Do not continue** to step 3 until the quality gate returns clean. If the user
refuses to fix a gap, abort the publish with a clear reason.

Write `skill_creator_report.json` with the final assessment: `{status: "clean",
checks: [...], auto_enhancements_applied: [...]}`. This is uploaded alongside
the scrub report in step 7.

### Step 3 — Local regex sanitize

Run `python3 ~/.claude/skills/skillhub/scripts/sanitize.py <skill-dir>`. It
applies the regex set from `~/.claude/skills/skillhub/references/scrubbing.md`
and writes:

- A sanitized copy to `<skill-dir>.sanitized/` (original is untouched)
- `scrub_report.regex.json` with `{file, line, rule, severity, snippet, replacement}` per finding
- Summary counts by severity

Show the unified diff between original and sanitized. If any `block` finding
exists and the user has not explicitly overridden it, STOP.

### Step 4 — Local LLM review (you, in this conversation turn)

**You do this yourself — no script, no external API call.** Read the sanitized
directory. For each file, identify subtler leaks the regex cannot catch, using
the exact categories and output shape defined in
`~/.claude/skills/skillhub/references/scrubbing.md`:

1. Internal company / project codenames / client names not in widespread public use
2. Dataset, table, schema names suggesting internal databases
3. Paths revealing organizational structure
4. People's names in comments, examples, or commit-message-like strings
5. Internal URLs not matched by the regex set
6. Cross-field re-identification risk (values individually innocuous, together identifying)
7. Credential formats the regex set does not recognize

Write findings to `<skill-dir>.sanitized/scrub_report.llm.json`:

```json
{
  "status": "clean" | "warn" | "block",
  "findings": [
    {"file": "scripts/foo.py", "line": 42, "snippet": "AcmeCorp pipeline",
     "category": "internal_name", "reason": "Proper noun 'AcmeCorp' looks like a company name",
     "suggested_replacement": "YourCompany"}
  ]
}
```

**Prefer `warn` over `clean` when uncertain. `block` requires high confidence.**
If you cannot produce well-formed JSON after two tries, treat the review as
`block` and refuse to upload.

Merge `scrub_report.regex.json` + `scrub_report.llm.json` → `scrub_report.json`.

### Step 5 — User approval

Present to the user, in this exact order:

1. The unified diff between original and sanitized (collapse if >200 lines)
2. Regex findings — numbered list with file + line + severity + snippet
3. LLM findings — numbered list with file + line + category + reason + suggested_replacement
4. The `skill-creator` quality-gate summary from step 2
5. A single-line prompt: **"Type 'publish' exactly to confirm. Anything else cancels."**

The user MUST type `publish` verbatim — not `yes`, not `y`, not `ok`. If they
type anything else, save the sanitized copy to `<skill-dir>.sanitized/` for
iteration and exit cleanly.

### Step 6 — Package

```bash
python3 ~/.claude/skills/skillhub/scripts/package.py <skill-dir>.sanitized/ dist/<slug>.skill
```

Thin wrapper around `~/.claude/skills/skill-creator/scripts/package_skill.py` —
do not reimplement packaging. Output is a ZIP archive.

### Step 7 — Upload

```bash
python3 ~/.claude/skills/skillhub/scripts/upload.py \
    dist/<slug>.skill scrub_report.json skill_creator_report.json
```

First moment any content leaves the user's machine. POSTs multipart to
`/v1/publish`. The server runs its own defense-in-depth regex re-scan; if it
catches anything, the publish is rejected and the finding is returned. Show the
server finding to the user verbatim.

On success, show the public URL: `https://agentskilldepot.com/s/<slug>`. Record
the published version in `.installed.json` so the heartbeat knows the author's
current version.

## Example chain

```
User: this skill works great
You:  Want to share this skill on Agent Skill Depot so other agents can use it?
User: yes
You:  Which directory should I publish? I see ~/.claude/skills/pdf-table-extractor (last
      modified 2 minutes ago) — that one?
User: yes
You:  [step 2] Quality gate: skill-creator says clean.
      [step 3] Regex scrub: 2 findings, both `warn` (no `block`). Diff: ...
      [step 4] LLM review: clean.
      [step 5] Type 'publish' exactly to confirm.
User: publish
You:  [step 6] Packaged dist/pdf-table-extractor.skill (34 KB).
      [step 7] Uploaded. Public URL: https://agentskilldepot.com/s/pdf-table-extractor
```

## Failure modes

- **`skill-creator` not installed** → STOP at step 2. Tell the user. Do NOT proceed.
- **Regex scrub `block`** → STOP at step 3. Show the finding. Do NOT offer to override
  unless the user explicitly asks; even then, require a second confirmation.
- **LLM review cannot produce valid JSON** → treat as `block`. STOP.
- **User does not type `publish` verbatim** → save sanitized copy, exit cleanly. Do not ask again.
- **`POST /v1/publish` rejected by server re-scan** → show the server finding verbatim, return to
  step 3 for a re-sanitize.
- **Network failure during upload** → queue the `.skill` + reports in
  `~/.claude/skills/skillhub/.queue/<timestamp>/` and retry on next heartbeat. Never drop work
  silently.

## Bundled resources

This skill reuses scripts already shipped with `skillhub`:

- `~/.claude/skills/skillhub/scripts/sanitize.py` (regex scrub)
- `~/.claude/skills/skillhub/scripts/package.py` (skill-creator wrapper)
- `~/.claude/skills/skillhub/scripts/upload.py` (`POST /v1/publish`)
- `~/.claude/skills/skillhub/scripts/identity.py` (read `.identity.json`)
- `~/.claude/skills/skillhub/references/scrubbing.md` (regex set + LLM-review schema)
- `~/.claude/skills/skillhub/assets/default_changelog_template.md`
