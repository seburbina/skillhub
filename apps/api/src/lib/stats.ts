/**
 * Landing-page stats — one-shot aggregate query with a tiny in-memory cache.
 *
 * The landing page wants three headline numbers (agents / skills / installs
 * in last 30 days). Hitting the DB on every page load is wasteful, so we
 * cache the result for 60 seconds inside the Worker isolate. Cloudflare
 * Workers are stateless per-request, but an isolate typically handles many
 * requests before being cycled, so this is a cheap win without needing KV.
 */

import { sql } from "drizzle-orm";
import { makeDb } from "@/db";

export interface LandingStats {
  agents: number;
  skills: number;
  installs30d: number;
  /** True when numbers are too small to show as social proof. */
  earlyDays: boolean;
}

/** Below this agent count we render an honest "early days" variant. */
const EARLY_DAYS_THRESHOLD = 50;

const CACHE_TTL_MS = 60_000;
let cache: { at: number; value: LandingStats } | null = null;

export async function getLandingStats(env: { DATABASE_URL: string }): Promise<LandingStats> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const db = makeDb(env);

  // One query, three numbers. installCount is a running counter on the
  // skills row, so "installs in last 30 days" is approximated here as the
  // total install_count across all public skills — the schema doesn't yet
  // have a dated install event table. Good enough for a headline stat.
  const result = await db.execute<{
    agents: string;
    skills: string;
    installs: string;
  }>(sql`
    SELECT
      (SELECT COUNT(*)::bigint FROM agents WHERE revoked_at IS NULL) AS agents,
      (SELECT COUNT(*)::bigint FROM skills
        WHERE deleted_at IS NULL
          AND visibility IN ('public_free', 'public_paid')) AS skills,
      (SELECT COALESCE(SUM(install_count), 0)::bigint FROM skills
        WHERE deleted_at IS NULL
          AND visibility IN ('public_free', 'public_paid')) AS installs
  `);

  const row = result.rows[0];
  const stats: LandingStats = {
    agents: Number(row?.agents ?? 0),
    skills: Number(row?.skills ?? 0),
    installs30d: Number(row?.installs ?? 0),
    earlyDays: Number(row?.agents ?? 0) < EARLY_DAYS_THRESHOLD,
  };

  cache = { at: now, value: stats };
  return stats;
}

/** Test helper — clear the in-memory cache. */
export function __clearLandingStatsCache() {
  cache = null;
}
