/**
 * Visibility filtering — the ONE place `skills.visibility IN (...)` lives.
 *
 * Phase 0: public-tier only. The signature already accepts a viewer agent
 * so that Phase 2 can add tenant awareness without touching call sites.
 * Today every viewer — anonymous, public agent, future tenant agent — sees
 * the same public-only result set.
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  DO NOT HAND-WRITE `visibility IN (...)` ANYWHERE ELSE.          ║
 * ║  Every visibility-sensitive query calls this helper.             ║
 * ║                                                                  ║
 * ║  When Phase 2 lands, this file is the SINGLE point of change    ║
 * ║  that switches the system from public-only to tenant-aware.     ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   // Drizzle .where() with the skills table import:
 *   .where(and(visibleSkillsPredicate(viewer), isNull(skills.deletedAt)))
 *
 *   // Raw SQL query with a table alias:
 *   sql`SELECT ... FROM skills s WHERE s.deleted_at IS NULL
 *       AND ${visibleSkillsPredicate(viewer, { tableAlias: "s" })}`
 *
 *   // Raw SQL query without an alias (bare column references):
 *   sql`SELECT ... FROM skills WHERE ${visibleSkillsPredicate(viewer)}`
 */
import { sql, type SQL } from "drizzle-orm";
import type { Agent } from "@/db/schema";

export interface VisibilityOptions {
  /**
   * If set, prefixes `visibility` with `<alias>.` (e.g. `s.visibility`).
   * Leave undefined for bare `visibility` references.
   */
  tableAlias?: string;
}

/**
 * Return the SQL fragment that gates which skills a given viewer may see.
 *
 * @param viewerAgent  The authenticated agent making the request, or null
 *                     for anonymous/public viewers. Phase 0 ignores this
 *                     parameter; Phase 2 will branch on `viewerAgent.tenantId`.
 * @param opts.tableAlias  Optional SQL table alias prefix (e.g. "s" for
 *                         `FROM skills s`). Omit when the query has no
 *                         alias and references `visibility` directly.
 */
export function visibleSkillsPredicate(
  // Prefixed with _ so the unused-var lint rule is satisfied in Phase 0 —
  // the parameter is part of the public contract and will be consumed once
  // tenant awareness lands.
  _viewerAgent: Agent | null,
  opts: VisibilityOptions = {},
): SQL {
  if (opts.tableAlias) {
    // Use sql.raw for the alias so it interpolates as an identifier,
    // not a parameter. Alias is a closed set (caller-controlled), not
    // user input — no injection surface.
    const prefix = sql.raw(`${opts.tableAlias}.`);
    return sql`${prefix}visibility IN ('public_free', 'public_paid')`;
  }
  return sql`visibility IN ('public_free', 'public_paid')`;
}
