/**
 * Postgres-backed token bucket rate limiter (edge-compatible via Neon HTTP).
 *
 * Atomic increment via INSERT … ON CONFLICT DO UPDATE … RETURNING. Single
 * round-trip per check.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@/db";

export interface RateLimitConfig {
  windowSeconds: number;
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function checkRateLimit(
  db: Db,
  key: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const windowStart = bucketStart(config.windowSeconds);
  const result = await db.execute<{ count: number }>(sql`
    INSERT INTO rate_limit_buckets (key, window_start, count)
    VALUES (${key}, ${windowStart.toISOString()}, 1)
    ON CONFLICT (key, window_start)
    DO UPDATE SET count = rate_limit_buckets.count + 1
    RETURNING count
  `);
  const count = Number(result.rows[0]?.count ?? 1);
  const allowed = count <= config.max;
  const remaining = Math.max(0, config.max - count);
  const retryAfterSeconds = allowed
    ? 0
    : secondsUntilNextWindow(windowStart, config.windowSeconds);
  return { allowed, remaining, retryAfterSeconds };
}

function bucketStart(windowSeconds: number): Date {
  const now = Math.floor(Date.now() / 1000);
  return new Date((now - (now % windowSeconds)) * 1000);
}

function secondsUntilNextWindow(start: Date, windowSeconds: number): number {
  const end = start.getTime() + windowSeconds * 1000;
  return Math.max(1, Math.ceil((end - Date.now()) / 1000));
}

export const LIMITS = {
  register:  { windowSeconds: 86400, max: 5 },
  heartbeat: { windowSeconds: 1500,  max: 1 },
  publish:   { windowSeconds: 86400, max: 3 },
  search:    { windowSeconds: 3600,  max: 600 },
  download:  { windowSeconds: 86400, max: 200 },
  telemetry: { windowSeconds: 3600,  max: 1000 },
} as const satisfies Record<string, RateLimitConfig>;
