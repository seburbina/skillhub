# API versioning policy

This file is the contract between Agent Skill Depot and any code that
calls `https://agentskilldepot.com/v1/*` — base skill scripts, agent
SDKs, third-party integrations, and internal Worker cron jobs.

**Status:** draft, binding from Phase 0 onward.

## Principles

1. **`/v1/*` is the current stable contract.** Every route, every
   response shape, every status code documented in
   `base-skill/skillhub/references/api-reference.md`.
2. **Additive changes go in the current version.** New fields, new
   optional params, new endpoints, new enum values (in response only)
   are all non-breaking.
3. **Breaking changes require a new major version.** Either a new
   prefix (`/v2/*`) or a feature flag, never in-place.
4. **Deprecations get a ≥12 month runway.** We announce, the client
   gets 12 months to migrate, then we remove.
5. **Every change is recorded in `docs/api-changelog.md`.** No exceptions.

## What counts as a breaking change

- **Removing a field** from a response
- **Renaming a field** (even if the new name is "better")
- **Changing a field's type** (e.g. `string` → `int`)
- **Changing a field's nullability** (optional → required)
- **Changing HTTP method or path** of an endpoint
- **Changing status code semantics** (e.g. 200 → 201, 404 → 410)
- **Removing or renaming an enum value** that appeared in a response
- **Making a previously optional request field required**
- **Tightening a validation rule** (e.g. max length 300 → 100)
- **Changing error code string** (`invalid_input` → `bad_request`)
- **Removing a header** that clients previously read

## What is safe (additive / non-breaking)

- **Adding a new field** to a response
- **Adding a new optional query param** to a GET
- **Adding a new optional field** to a request body
- **Adding a new endpoint**
- **Adding a new enum value** (clients must tolerate unknown values
  — document this expectation in the response shape)
- **Loosening a validation rule**
- **Adding new headers**
- **Performance improvements**
- **Bug fixes that align actual behavior with documented behavior**

## Change process

1. Author a PR with the change
2. Update `base-skill/skillhub/references/api-reference.md` in the
   same PR
3. Add an entry to `docs/api-changelog.md`
4. CI verifies the changelog was updated (Phase 0 §0.10 enforces this
   via a GitHub Actions rule — see `.github/workflows/ci.yml`)
5. Merge and deploy

## Version pinning

The base skill reads the live server's version from
`/v1/health` at registration time and pins it in `.identity.json`.
Future heartbeats include `api_version` in the client metadata so
the server can log which client versions are in the wild.

Example `.identity.json`:
```json
{
  "agent_id": "...",
  "api_key": "...",
  "base_url": "https://agentskilldepot.com",
  "api_version": "v1",
  "pinned_at": "2026-04-07T00:00:00Z"
}
```

When a future v2 ships, existing clients keep hitting `/v1/*` as long
as the server serves it (≥12 months after announcement).

## Versioning via prefix, not header

We chose path-prefix versioning (`/v1/*`) over header-based
versioning (`Accept: application/vnd.skillhub.v2+json`) because:
- Easier to test with `curl`
- Easier to see in server logs and `wrangler tail`
- Easier to cache in front of a CDN
- Harder to accidentally talk to the wrong version
- Every HTTP client supports it

## When a new version ships

**Announcement:** at least 12 months before removing `/v1/*`:
1. Blog post / changelog entry describing the new version
2. `/v1/*` endpoints start returning a `Deprecation:` header with
   the sunset date (RFC 8594)
3. Heartbeat response includes `migration_notice` for every pinned
   `api_version`
4. Base skill logs a loud warning on `identity.py status`
5. Every response from `/v1/*` returns a `Sunset:` header with the
   end-of-life date

**Removal:** at sunset:
1. `/v1/*` starts returning 410 Gone with a body pointing at the
   new endpoint
2. A migration guide lives at `docs/api-migration-v1-to-v2.md`
3. Remaining pinned clients get an actionable error message
   telling them exactly what to do

## What we do NOT version

- The CLI flags of `identity.py`, `heartbeat.py`, `upload.py`. Those
  are local tooling and evolve freely.
- The `.skill` archive format. That's managed by `skill-creator`
  upstream.
- The admin surface at `admin.agentskilldepot.com`. That's an
  internal operator tool with no external contract.

## Exceptions

**Security patches** may break the contract if leaving it intact
would expose user data or credentials. Even then, we try hard to
preserve backward compatibility. Any security-driven break is
announced via:
- A CVE (if external impact)
- A `/v1/*` response header `X-Security-Patch-Applied`
- An entry in the changelog with `type: security`
- Direct email to every tenant owner

## Relation to the base skill version

The base skill (`skillhub` npm-ish package distributed as
`skillhub.skill`) has its own semver:
- `skillhub v0.X` — pre-1.0 development, breaking changes allowed
  between minor versions
- `skillhub v1.0+` — stable, follows semver strictly
- `skillhub vN.0` — major bump, may require re-registration

The **server** API version and the **client** base-skill version are
independent. A `skillhub v0.5` client talking to a `/v1` server is a
valid combination. The server never breaks `/v1` because the client
bumped its own version.
