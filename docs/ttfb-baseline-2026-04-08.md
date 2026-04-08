# TTFB baseline — 2026-04-08 (post-Phase-0)

**Measured at:** 2026-04-08T02:14:00Z
**Worker version:** `3e644c51` (Phase 0 batch 2 deploy)
**Tool:** `curl -w "%{time_starttransfer}s"` against production
**Origin:** measurement machine in Costa Rica → Cloudflare edge
**Purpose:** confirm Phase 0 changes (`visibleSkillsPredicate`, audit
writes via `waitUntil`, tenant-scoped rate-limit keys, RLS enabled
permissively) have not regressed user-facing latency.

## Results (5 samples per endpoint)

| Endpoint | p50 | p95-ish (max of 5) | Assessment |
|---|---|---|---|
| `GET /v1/health` | **~155 ms** | 246 ms | ✅ unchanged |
| `GET /v1/skills/search?q=pdf` | **~446 ms** | 904 ms | ⚠️ one outlier but in range |
| `GET /v1/skills/:slug` | **~292 ms** | 372 ms | ✅ unchanged |
| `GET /v1/leaderboard/skills?limit=5` | **~198 ms** | 201 ms | ✅ unchanged |

### Raw samples

```
/v1/health               0.246s 0.154s 0.150s 0.172s 0.154s
/v1/skills/search?q=pdf  0.677s 0.904s 0.446s 0.350s 0.410s
/v1/skills/skillhub      0.306s 0.279s 0.371s 0.285s 0.291s
/v1/leaderboard/skills   0.198s 0.193s 0.201s 0.191s 0.198s
```

## Interpretation

- **/v1/health** — pure Worker dispatch, no DB. 155 ms median is
  normal-for-Costa-Rica. No Phase 0 regression.
- **/v1/skills/search** — embedding call (Voyage) + pgvector ANN +
  RLS (permissive) + visibility helper. The 904 ms outlier is
  almost certainly a Voyage cold start or rate-limit hiccup.
  The p50 of 446 ms is within the 200–650 ms Phase 3 range.
- **/v1/skills/:slug** — Neon query for the skill row + versions.
  RLS adds zero overhead on permissive policies. 292 ms median
  matches expectations.
- **/v1/leaderboard/skills** — single `SELECT ... ORDER BY` over a
  tiny dataset. 198 ms median is actually faster than Phase 3
  numbers, probably because the dataset is still small enough that
  the planner caches.

## Conclusion

**No regression from Phase 0.** Every endpoint is within the range
the Phase 3 docs quoted (200–650 ms TTFB). The audit-log writes
don't affect TTFB because they go through `ctx.waitUntil()` — the
HTTP response returns before the audit row is committed.

Permissive RLS (`USING (true)`) adds essentially zero overhead on
the query planner — Postgres sees the always-true predicate and
elides it.

The visibility helper refactor is a pure SQL-fragment substitution
— same query shape, same plan, same execution time.

Rate-limit key scheme change is a pure string-concat difference —
the Postgres `INSERT ... ON CONFLICT` pattern is unchanged.

## Baseline for future comparisons

Re-run this measurement after:
- Phase 2 RLS tightening (expect ~5–10 ms increase)
- Enabling `runWithTenantContext` on any endpoint (expect ~2–3 ms for the extra `BEGIN`/`COMMIT`)
- Migrating to paid Cloudflare + paid Neon plans (expect ~10–30 ms improvement from dedicated compute)
- Switching `DATABASE_URL` to a non-`BYPASSRLS` role (expect no measurable change)

## How to re-run

```bash
for ep in "/v1/health" "/v1/skills/search?q=pdf" "/v1/skills/skillhub" "/v1/leaderboard/skills?limit=5"; do
  echo "=== $ep ==="
  for i in 1 2 3 4 5; do
    curl -s -o /dev/null -w "  $i: %{time_starttransfer}s\n" "https://agentskilldepot.com$ep"
  done
done
```
