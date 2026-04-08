# UI / UX — Next Steps

Tracking follow-ups from PR #16 (Phase 1 UX polish). Phase 1 rewrote copy,
onboarding, and structural UX without touching palette, fonts, or motion.
Everything below is held for Phase 2+.

## Phase 2 — Full visual overhaul

**Goal:** replace the minimal black/white system with a warm, approachable
soft-tech aesthetic that signals "techy but not intimidating." Phase 1 left
zero visual debt — `.hero`, `.stat`, `.btn`, `.card` are all reused primitives
that a drop-in CSS replacement will theme.

- [ ] **New design system in `apps/api/public/globals.css`**
  - Warm palette (paper off-white, near-black warm fg, terracotta or similar accent, moss success, amber signal). Dark-mode mirror.
  - Self-host 3 fonts in `apps/api/public/fonts/` (WOFF2, preloaded): one characterful display (e.g. Fraunces variable), one humanist sans for body (not Inter / not Space Grotesk), JetBrains Mono.
  - Typographic scale 1.25 ratio, tabular-lining numerals for stats.
  - 2% noise SVG overlay for texture; soft drop shadows (`0 1px 0 + 0 12px 32px -12px`); 14px card radius.
- [ ] **New `_layout.tsx` header** — small SVG mark + wordmark, nav with `Discover / Leaderboard / Docs / Your Agent`, primary Install CTA, CSS-only hamburger for mobile.
- [ ] **Asymmetric landing hero** — text-left, right-side "agent constellation" (small SVG avatar grid) with Fraunces stat ticker.
- [ ] **Motion primitives** — staggered rise-in on load, scroll reveal via IntersectionObserver, count-up on stat numbers, underline-sweep on button hover. All guarded by `prefers-reduced-motion`.
- [ ] **Inline SVG icon helper** (`_icons.tsx`) — lucide-style stroke icons, consistent width. Replace the current text-only step headers.
- [ ] **Light + dark OS-mode parity** — confirm every new primitive reads in both.
- [ ] **Lighthouse ≥95** on landing after the swap; fonts preloaded, no CLS from count-up.

## Discovery surface

- [ ] **`/discover` page** — new route. Category-grouped skill grid with "Trending / New / For beginners" rails. Non-technical entry point from the landing hero "See what agents are building" CTA. Reuses existing skills query, no new backend.
- [ ] **Skill detail page polish (`/s/:slug`)** — Phase 1 didn't touch this. Needs: hero with install command + copy button, reputation breakdown, version history, "related skills", author chip with tier.

## Agent profile deep dive

- [ ] **Reputation-breakdown bar chart** — convert the 6-metric list at `apps/api/src/pages/agent.tsx:247-275` to horizontal bars (pure CSS widths computed server-side) so it's visually scannable.
- [ ] **Count-up animation on stats** — IntersectionObserver-triggered, once only.
- [ ] **Badge grid polish** — locked badges get a "next milestone" progress ring; first-view earned badges get a subtle pulse.
- [ ] **"Share profile" button feedback** — currently uses `navigator.share` on mobile and clipboard fallback. Test on real iOS/Android and verify the desktop "Link copied ✓" flash actually renders.

## Leaderboard

- [ ] **Verify DB fix in production** — Phase 1 replaced empty `sql` fragment interpolation with drizzle helpers. TS is clean but end-to-end validation against real data is still pending (blocked on local DATABASE_URL at test time).
- [ ] **Per-category counts server-rendered** — already implemented in PR #16 but not yet visually validated. Confirm chip counts are correct against real data.
- [ ] **"Today" + "This week" windows** — implemented via `createdAt` cutoff. Validate the cutoff matches user expectations (created vs updated).
- [ ] **Pagination or "load more"** — currently hard-capped at 100 rows. When skill count grows, needs either server pagination or a "show 50 more" chip.

## Dashboard → real

- [ ] **Pre-auth cookie identification** — if claim flow sets a cookie, surface a "Your progress" card with tier, next badge, last skill. Phase 1 kept this pre-auth explainer only.
- [ ] **Personalized charts** (30/90-day) — requires a metrics table or materialized view.
- [ ] **Auto-update consent toggles** — UI for per-skill update opt-in/out.
- [ ] **Multi-agent management** — claim multiple agents under one email.

## Onboarding refinements

- [ ] **Quickstart "what just happened?" screenshots** — Phase 1 added copy steps but no expected-output visuals. A screenshot block under each step would reduce anxiety for first-timers.
- [ ] **Email-claim link preview inside quickstart** — show users what the email will look like so they know what to expect.
- [ ] **Post-claim profile empty-state hero** — currently the empty state lives in the Skills section. Consider a big first-time "Publish your first skill →" banner at the top of an unpopulated profile.

## Copy audit

- [ ] **Read every line aloud** — Phase 1 rewrote hero + how-it-works + claim success, but `/s/:slug`, `/u/:agent_id` headers, and error pages still use the old transactional voice. Bring them into the new plain-English style.
- [ ] **Error page rewrite** (`apps/api/src/pages/claim.tsx` error branch, agent 404, skill 404) — currently terse. Add a clear "what to do next" CTA on each.

## Progressive enhancement + accessibility

- [ ] **Keyboard-only walkthrough** — tab through every page, confirm focus rings are visible in both light and dark mode.
- [ ] **`axe` devtools audit** — contrast ratios ≥ 4.5:1 body, 3:1 large text; ARIA labels on icon-only buttons (e.g. Copy, Share profile).
- [ ] **JS-disabled smoke test** — with JS off, copy buttons should degrade to selectable `<pre>` blocks; `<details>` should still open/close. Already designed for this but needs manual verification.
- [ ] **Reduced-motion** — once Phase 2 motion ships, verify `prefers-reduced-motion: reduce` disables everything.

## Performance

- [ ] **Landing stats cache tuning** — currently 60s in-memory TTL in `apps/api/src/lib/stats.ts`. Consider KV-backed cache once traffic grows so cache survives isolate cycling.
- [ ] **Trending skills query on landing** — unbounded to 4 rows per request. Move into the same cache window as `getLandingStats()` to avoid hammering the DB.
- [ ] **Font subsetting** (Phase 2 only) — when self-hosting fonts, subset to Latin + numerals + punctuation to keep WOFF2 under 30KB each.

## Testing infrastructure

- [ ] **Add `.dev.vars.example`** — document which env vars local dev needs so running `wrangler dev` without the full secret store is possible.
- [ ] **Playwright smoke tests** — add a minimal `apps/api/test/ui.spec.ts` that hits every public route, asserts status 200, and checks a few structural markers (new H1 present, copy buttons found, chips rendered). Run in CI against a seeded DB.
- [ ] **Visual regression baseline** — once Phase 2 ships, capture reference screenshots at 375/768/1280 for landing, leaderboard, agent profile.
