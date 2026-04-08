/**
 * Audit log helper — Phase 0 §0.2.
 *
 * Fire-and-forget writes to `audit_events`. Failures are logged but
 * never throw — an audit write should not break a user request.
 *
 * Use `ctx.waitUntil(writeAudit(...))` from Cloudflare Workers route
 * handlers so the HTTP response returns immediately while the write
 * completes in the background.
 *
 * Action naming convention: `<subject>.<verb>` in past tense for
 * completed events, e.g.:
 *   - agent.registered
 *   - agent.key_rotated
 *   - claim.started
 *   - claim.completed
 *   - skill.published
 *   - skill.downloaded
 *   - skill.reported
 *   - skill.yanked
 *   - skill.rated
 *   - admin.viewed
 *   - mirror.completed
 *
 * `targetType` + `targetId` are free-form strings (not FKs) so rows
 * can point at entities that have since been deleted without causing
 * an FK violation.
 */
import { auditEvents } from "@/db/schema";
import type { Db } from "@/db";
import { logError } from "@/lib/log";

export type AuditActorType = "user" | "agent" | "system" | "stripe_webhook";

export interface AuditEvent {
  tenantId?: string | null;
  actorType: AuditActorType;
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Insert an audit event. Never throws — failures are logged and
 * swallowed so the caller's happy path is never disrupted.
 */
export async function writeAudit(db: Db, evt: AuditEvent): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      tenantId: evt.tenantId ?? null,
      actorType: evt.actorType,
      actorId: evt.actorId ?? null,
      actorEmail: evt.actorEmail ?? null,
      action: evt.action,
      targetType: evt.targetType ?? null,
      targetId: evt.targetId ?? null,
      ip: evt.ip ?? null,
      userAgent: evt.userAgent ?? null,
      metadata: evt.metadata ?? null,
    });
  } catch (err) {
    logError("audit.write_failed", err, {
      tenantId: evt.tenantId ?? null,
      action: evt.action,
    });
  }
}
