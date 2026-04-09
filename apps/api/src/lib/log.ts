/**
 * Structured JSON logger — Phase 0 §0.13.
 *
 * Every log line is a single JSON object with at minimum:
 *   { ts, level, event, tenant_id }
 *
 * `tenant_id` is always emitted — `null` for public-tier requests,
 * a UUID for tenant-scoped requests (Phase 2+). This lets Logpush +
 * SIEM filters segment by tenant from day 1.
 *
 * `event` is a dot-namespaced name like `publish.skill.created` or
 * `cron.mirror.done`. Use past-tense for completed events, imperative
 * for attempted-but-failed.
 *
 * Usage:
 *   logEvent("info", "publish.skill.created", {
 *     slug: "foo", semver: "1.0.0", tenantId: ctx.tenantId,
 *   });
 *
 *   logError("publish.skill.failed", err, { slug: "foo" });
 *
 * Refactoring pattern:
 *   - console.log("[publish.embedSkill]", r)
 *   → logEvent("info", "publish.embedSkill", { result: r })
 *
 *   - console.warn("[mirror-to-github] failed", e)
 *   → logError("mirror.github.failed", e)
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  /** Tenant id, or null/undefined for public-tier requests. */
  tenantId?: string | null;
  [key: string]: unknown;
}

/**
 * Emit a structured log line as a single-line JSON object.
 *
 * The output target is `console.log/warn/error` depending on level —
 * Cloudflare Workers captures all three and ships them to
 * `wrangler tail` + Logpush. We write one line per call to keep
 * downstream parsers happy.
 */
export function logEvent(
  level: LogLevel,
  event: string,
  ctx: LogContext = {},
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    tenant_id: ctx.tenantId ?? null,
    ...omitKey(ctx, "tenantId"),
  });

  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "debug":
      // Workers strips debug unless wrangler.toml sets compat flags.
      // Emit via console.log to survive.
      console.log(line);
      break;
    default:
      console.log(line);
  }
}

/**
 * Log an error with auto-extracted stack + message. Shorthand for the
 * common pattern of `try/catch → log and continue`.
 */
export function logError(
  event: string,
  err: unknown,
  ctx: LogContext = {},
): void {
  const details =
    err instanceof Error
      ? { error: err.message, stack: err.stack }
      : { error: String(err) };
  logEvent("error", event, { ...ctx, ...details });
}

/** Shallow omit — doesn't recurse, doesn't clone, just strips one key. */
function omitKey(obj: LogContext, key: string): Record<string, unknown> {
  const { [key]: _removed, ...rest } = obj;
  return rest;
}
