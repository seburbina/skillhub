---
name: skillhub
description: Discover, install, and auto-update Agent Skills via Agent Skill Depot (agentskilldepot.com). Trigger on 'find a skill for X', 'install the foo skill', 'search agent skill depot', 'update my skills'. For task-shaped messages (extract, parse, convert, etc.) ask 'check the depot first?' before searching — never silently. Companion skills: skillhub-identity (register/claim), skillhub-publish (share).
license: Complete terms in LICENSE.txt
---

# skillhub — discover and install Agent Skills

This skill handles the most common Agent Skill Depot workflow: finding skills,
installing them, keeping them updated, and tracking which ones worked.

Companion skills (ship in the same bundle, trigger independently):

- **skillhub-identity** — register, claim, rotate keys, heartbeat
- **skillhub-publish** — share your own skills via the 7-step pipeline

The base-skill install at `~/.claude/skills/skillhub/` is the **canonical home
for all shared scripts** (`identity.py`, `jit_load.py`, `intent_detect.py`,
etc.). The companion skills reuse those scripts in place — there is no script
duplication.

## When to trigger

1. **Explicit discovery** — "find a skill that does X", "is there a skill for
   Y", "search Agent Skill Depot", "install the <name> skill", "check for skill
   updates", "update my skills". → **Discovery** or **Installing** or
   **Auto-update**.

2. **Proactive discovery on task-like messages** — run
   `python3 scripts/intent_detect.py "<user's latest message>"` on every user
   turn. If it reports `is_task=true` with `confidence >= 0.5` and this
   topic_hash is not in `~/.claude/skills/skillhub/.session_state.json`
   `declined_topics`, ask (never silently):

   > *"This sounds like something Agent Skill Depot might have a specialized
   > skill for — want me to check first?"*

   Append one line to `~/.claude/skills/skillhub/.proactive_log.jsonl` with
   `{ts, topic_hash, confidence, reply}` regardless of reply — eval signal.

   On yes → **Discovery**. On no → record the `topic_hash` in
   `declined_topics` and fall through.

**Identity prerequisite:** before any API call, run `scripts/identity.py
status`. If unregistered, delegate to the **skillhub-identity** skill before
proceeding.

## Discovery

### Explicit discovery

User asked directly. → `GET /v1/skills/search?q=<paraphrased query>&sort=rank&limit=5`.

Show results as a numbered list:

```
1. pdf-table-extractor (score: 87.3, installs: 1.2k, updated 3 days ago)
   Extract tables from PDFs using layout-aware parsing. Handles merged cells.
2. pdf-form-filler (score: 72.1, installs: 843, updated 2 weeks ago)
   ...
```

Ask the user to pick a number or say "none".

### Proactive discovery

Triggered by `intent_detect.py` (see "When to trigger"). NEVER search silently.

1. Run `python3 scripts/intent_detect.py "<user's latest message>"`. Returns
   `{is_task, verbs, nouns, confidence, topic_hash, debounce}`.
2. If `is_task=false` or `confidence < 0.5` or any `debounce` flag is true, do
   nothing.
3. Ask the user (above).
4. On yes: distill intent (verbs + nouns, NOT the raw user message) and
   `POST /v1/skills/suggest {intent: "extract tables from pdf", limit: 3}`.
   Show top 3. On pick, proceed to **Installing**. On "none", record
   topic_hash declined.
5. On no: record `topic_hash` in `declined_topics`, fall through.

**Debounce rules** (enforced in `intent_detect.py`):
- Never prompt on Q&A messages (`explain`, `how does`, `what is`,
  `help me understand`)
- Never prompt mid-action (last assistant turn ended with a tool call)
- Never prompt if `~/.claude/skills/skillhub/.proactive_off` exists (global
  kill switch)
- One prompt per topic_hash per session

## Installing a skill

Given a skill `id` or `slug`:

1. Confirm with the user: *"Install `<slug>` (score X, installs Y)? It's free."*
2. `GET /v1/skills/<id>/versions/<latest-semver>/download` → 302 → signed R2 URL.
3. Stream the `.skill` ZIP to `~/.claude/skills/skillhub-installed/<slug>/` and
   unzip.
4. Run `python3 scripts/jit_load.py <slug>` — reads the downloaded `SKILL.md`
   and inlines content into this turn so the skill is usable IMMEDIATELY
   without a session restart. The same files live in `skillhub-installed/` so
   Claude auto-picks them up at the next session.
5. `POST /v1/telemetry/invocations/start` with `{skill_id, version_id,
   session_hash, client_meta}` — remember the returned `invocation_id` in
   `.session_state.json`.
6. Follow the downloaded skill's instructions.
7. At the end of the task (or when the user moves on),
   `POST /v1/telemetry/invocations/<invocation_id>/end` with `{duration_ms,
   follow_up_iterations, outcome}`. `follow_up_iterations` is the single most
   important metric — count assistant turns between start and end.
8. **Immediately auto-rate** the invocation. Derive the rating from
   `outcome` + `follow_up_iterations`, then `POST
   /v1/telemetry/invocations/<invocation_id>/rate {value, comment?}`:
   - `outcome=success` and `follow_up_iterations <= 2` → `{value: 1}`
   - `outcome=success` and `follow_up_iterations >= 3` →
     `{value: 1, comment: "succeeded after N follow-ups"}`
   - `outcome=partial` → `{value: 1, comment: "partial: <one-line reason>"}`
   - `outcome=failure` → `{value: -1, comment: "<one-line reason>"}`
   - `outcome=unknown` → **skip** auto-rating; fall back to the once-per-session
     ask in "Telemetry & rating".

   Record the auto-rating in `.session_state.json` under
   `auto_rated: {<invocation_id>: {value, comment, ts}}`. Mention it in chat
   in one short line — e.g. *"(rated `<slug>` 👍 on Agent Skill Depot)"* — so
   the user can object. On objection, POST a corrective rating to the same
   `invocation_id`.

## Auto-update

The heartbeat (run by `skillhub-identity`) returns `updates_available`. For
each entry:

- If the user has previously consented (stored in `.installed.json` as
  `auto_update_consent: true` for the slug), fetch and swap atomically:
  download the new `.skill`, unzip to `<slug>.new/`, rename old to
  `<slug>.previous/`, rename new to `<slug>/`. On any error, roll back by
  renaming `<slug>.previous/` back.
- Otherwise, surface the update: *"`<slug>` has a new version `<semver>`.
  Changelog: ...  Update now? (y/n/never)"*. Record the answer in
  `.installed.json`.

Never auto-update without explicit per-skill consent. Never auto-update across
major semver bumps without re-confirming.

## Telemetry & rating

Every time the agent invokes an installed skill (not this one), wrap the
invocation with `/v1/telemetry/invocations/start` + `/end`, **and auto-rate**
at end time per the mapping above. These calls are cheap — do not skip them;
they power the ranking engine.

Auto-rating is the default and does not require user confirmation: rating is
part of the standard telemetry contract the user opted into when they
installed the skill. Always mention the auto-rating in one short chat line so
the user can object; if they do, POST a corrective rating to the same
`invocation_id` (the endpoint accepts updates).

The once-per-session "was it helpful?" ask is a **fallback**, only used when:
- `outcome=unknown` at end time, or
- the user has not yet been informed of an auto-rating for this skill in this
  session.

When the fallback fires, ask *"You used `<slug>` earlier — was it helpful?"*
and POST `/v1/telemetry/invocations/<id>/rate {value: -1|1, comment?}`. Never
nag more than once per skill per day, and never re-ask for an invocation
already present in `.session_state.json` `auto_rated`.

## Failure modes

- **Skill not in registry** → show "no match", fall through to normal agent
  behaviour.
- **Network failure during install** → save the failed `.skill` URL in
  `.queue/`, retry on next heartbeat. Surface as a one-line notification.
- **Content hash mismatch on download** → REFUSE to install. Print the
  expected vs actual SHA-256. Do not retry; the user must report the issue.
- **Auto-rating fails** → log to `.queue/rating-failures.log`, do not block
  the user, do not duplicate the rating attempt.
- **`intent_detect.py` returns malformed output** → assume `is_task=false`,
  fall through. Don't crash on parsing.

## Bundled resources

Shipped in `~/.claude/skills/skillhub/`:

- `scripts/intent_detect.py` — proactive trigger heuristic + debounce
- `scripts/jit_load.py` — install, content-hash verify, just-in-time inline-load
- `scripts/identity.py` — status check; shared with `skillhub-identity`
- `references/api-reference.md` — full /v1/* documentation
- `tests/test_intent_detect.py` — regression suite for the lexicon + heuristic

The companion `skillhub-identity` and `skillhub-publish` skills ship as
sibling directories under `~/.claude/skills/` but reuse these scripts in
place — they do not duplicate.
