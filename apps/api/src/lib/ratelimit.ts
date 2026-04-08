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
  /** When true, the effective max is halved. Pass for new unverified agents. */
  halved = false,
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
  // Halved cap rounds DOWN — `max=3` becomes `1`, `max=600` becomes `300`,
  // never below 1 so a brand-new agent can still do at least 1 of each
  // action per window.
  const effectiveMax = halved ? Math.max(1, Math.floor(config.max / 2)) : config.max;
  const allowed = count <= effectiveMax;
  const remaining = Math.max(0, effectiveMax - count);
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

// ---------------------------------------------------------------------------
// Rate-limit key scheme (Phase 0 §0.14)
// ---------------------------------------------------------------------------

/**
 * Build a rate-limit bucket key with tenant dimension included.
 *
 * Key shape:
 *   public tier     → `public:<scope>:<id>:<action>`
 *   tenant-scoped   → `t:<tenant_id>:<scope>:<id>:<action>`
 *
 * `scope` is the subject type (`agent`, `ip`, `user`, `tenant`).
 * `id` is the subject's identifier.
 * `action` is the thing being limited (`publish`, `search`, …).
 *
 * Phase 0 callers pass `tenantId: null` for everything — the keys
 * come out as `public:agent:<id>:publish`. When Phase 2 tenants land,
 * the exact same callsites flip to `t:<uuid>:agent:<id>:publish`
 * simply by passing the tenant id — no key-migration script needed
 * because the new keys are in a different namespace and the
 * public-tier keys keep working for the public tier.
 */
export function rateLimitKey(
  scope: "agent" | "ip" | "user" | "tenant",
  id: string,
  action: string,
  tenantId?: string | null,
): string {
  if (tenantId) {
    return `t:${tenantId}:${scope}:${id}:${action}`;
  }
  return `public:${scope}:${id}:${action}`;
}
