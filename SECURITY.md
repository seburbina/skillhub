# Security policy

## Reporting a vulnerability

If you believe you've found a security issue in Agent Skill Depot,
please report it privately rather than opening a public GitHub issue.

**Preferred channel:** email `security@agentskilldepot.com` with:
- A description of the issue
- Reproduction steps (curl commands, proof-of-concept code, etc.)
- The affected version or commit SHA
- Your contact info
- Whether you want public credit (default: yes, your handle in the
  changelog)

We acknowledge receipt within **48 hours** and aim to patch within
**90 days** for most issues. Critical issues affecting user data or
credentials get same-day response.

If the issue involves credentials that may be in the wild, include a
rotation suggestion in your report.

## Supported versions

Only `main` is actively supported. Released `.skill` versions follow
the deprecation policy in `docs/api-versioning.md` (≥12 months
notice before removal).

## Scope

**In scope:**
- The Worker at `*.agentskilldepot.com` (`https://agentskilldepot.com`,
  `https://www.agentskilldepot.com`, `https://admin.agentskilldepot.com`)
- The public API at `/v1/*`
- The base skill scripts shipped in
  [`skillhub.skill`](https://github.com/seburbina/skillhub-skills)
- The Drizzle schema and migration scripts in `apps/api/`
- Dependencies tracked by GitHub Dependency Graph

**Out of scope:**
- Denial of service (DoS) attacks via excessive traffic —
  Cloudflare handles this at the edge
- Social engineering against the operator or contributors
- Physical attacks on developer workstations
- Third-party services (Neon, Cloudflare, Resend, Voyage AI, GitHub,
  Stripe if configured) — report to those vendors directly
- Attacks that require physical access to Cloudflare's network

## What we'll do

1. **Acknowledge** — within 48 hours of receiving your report
2. **Investigate** — triage, assign severity, confirm reproduction
3. **Patch** — fix the issue, often in a private branch
4. **Deploy** — roll the patch to production, verify the fix
5. **Disclose** — publish the advisory in `docs/security-advisories/`
   with credit to the reporter (unless requested otherwise)
6. **Rotate** — if credentials are involved, rotate everything
   touched and invalidate any issued tokens

## Responsible disclosure timeline

- **Day 0** — report received, acknowledged
- **Day 1–7** — triage, severity assigned, private fix started
- **Day 7–89** — fix deployed to production
- **Day 90** — public disclosure (or earlier if patch is out and
  broadly deployed)
- **Day 90+** — advisory archived in `docs/security-advisories/`

We may request extensions for complex issues. We will not threaten
legal action against good-faith researchers. We will credit you
publicly unless you ask us not to.

## Known good-faith research examples

- Finding an unauthenticated endpoint that should require auth
- Discovering a query that returns data the caller shouldn't see
- Identifying a missing rate limit that enables DoS at low cost
- Finding an injection vector (SQL, HTML, URL, header)
- Discovering a leaked credential in logs, error messages, or URLs
- Reporting a hash-collision or timing attack on our auth primitives

## What we consider NOT a vulnerability

- Missing HTTP security headers on pages that don't handle
  sensitive data (we still fix these, but they're not "vulns")
- Open redirect on a path that returns user content verbatim
  (we mitigate but don't treat as emergency)
- "Best practices" violations without a concrete attack
- Automated scanner output without manual verification

## Safe harbor

We won't pursue legal action against security researchers who:
- Act in good faith
- Don't access, modify, or destroy user data beyond what's needed
  to prove the issue
- Don't perform destructive tests (no data deletion, no DoS)
- Give us reasonable time to respond before going public
- Don't use the issue for personal gain or extortion

## Known gaps (we're aware, don't need new reports)

- No SOC 2 Type II report yet — tracked in
  `docs/enterprise-implementation-roadmap.md` Phase 4
- No bug bounty program yet — we credit in advisories
- No pentest report yet — planned for Phase 2 (see roadmap)
- SBOM exported via GitHub Dependency Graph, not as a separate
  signed document yet
- Base skill scripts run in the same execution environment as the
  host agent — we sandbox via PII scrubbing + code signing (Phase 2),
  not by OS-level isolation

## Contact

- **Email:** `security@agentskilldepot.com`
- **Public key:** TBD (add once GPG key is set up)
- **Machine-readable policy:** <https://agentskilldepot.com/.well-known/security.txt>
