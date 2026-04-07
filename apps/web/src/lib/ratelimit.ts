/**
 * Postgres-backed token bucket rate limiter.
 *
 * Cheap and simple — uses a small table (`rate_limit_buckets`) with one row
 * per (key, window_start). Fixed-window semantics with configurable window
 * size and max count per window.
 *
 * Keys encode what's being limited, e.g.:
 *   - `agent:<id>:publish`
 *   - `agent:<id>:heartbeat`
 *   - `ip:<x>:register`
 *
 * Not as accurate as Redis token buckets, but good enough for the MVP.
 * Swap to Redis / Upstash later if needed.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";

export interface RateLimitConfig {
  /** Window size in seconds. */
  windowSeconds: number;
  /** Max actions allowed per window. */
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Increment the counter and check whether the caller is allowed.
 *
 * Uses `ON CONFLICT DO UPDATE` for atomic increment. Single round-trip.
 */
export async function checkRateLimit(
  key: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const windowStart = bucketStart(config.windowSeconds);

  // Atomic upsert: if row exists, increment count; else insert count=1.
  // Returns the new count.
  const rows = await db.execute<{ count: number }>(sql`
    INSERT INTO rate_limit_buckets (key, window_start, count)
    VALUES (${key}, ${windowStart.toISOString()}, 1)
    ON CONFLICT (key, window_start)
    DO UPDATE SET count = rate_limit_buckets.count + 1
    RETURNING count
  `);

  const count = Number(rows[0]?.count ?? 1);
  const allowed = count <= config.max;
  const remaining = Math.max(0, config.max - count);
  const retryAfterSeconds = allowed
    ? 0
    : secondsUntilNextWindow(windowStart, config.windowSeconds);

  return { allowed, remaining, retryAfterSeconds };
}

/** Snap `now` down to the nearest window boundary. */
function bucketStart(windowSeconds: number): Date {
  const now = Math.floor(Date.now() / 1000);
  const bucketSecond = now - (now % windowSeconds);
  return new Date(bucketSecond * 1000);
}

function secondsUntilNextWindow(
  windowStart: Date,
  windowSeconds: number,
): number {
  const end = windowStart.getTime() + windowSeconds * 1000;
  return Math.max(1, Math.ceil((end - Date.now()) / 1000));
}

// ---------------------------------------------------------------------------
// Pre-baked configs (keep in sync with base-skill/references/api-reference.md)
// ---------------------------------------------------------------------------

export const LIMITS = {
  register:       { windowSeconds: 86400, max: 5 },       // 5/day/IP
  heartbeat:      { windowSeconds: 1500,  max: 1 },       // 1 per 25 min
  publish:        { windowSeconds: 86400, max: 3 },       // 3/day per agent
  search:         { windowSeconds: 3600,  max: 600 },     // 600/hr
  download:       { windowSeconds: 86400, max: 200 },     // 200/day
  telemetry:      { windowSeconds: 3600,  max: 1000 },    // 1000/hr
} as const satisfies Record<string, RateLimitConfig>;
