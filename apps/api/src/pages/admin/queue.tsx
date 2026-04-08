/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { AdminLayout } from "./_layout";
import { makeDb } from "@/db";
import {
  agents,
  moderationFlags,
  skills,
} from "@/db/schema";
import type { Env } from "@/types";

type FlagStatus = "open" | "reviewing" | "resolved" | "dismissed";
const STATUSES: FlagStatus[] = ["open", "reviewing", "resolved", "dismissed"];

/**
 * Admin moderation queue — read-only list of recent flags with a
 * status filter. Write actions (resolve, dismiss, yank) are deferred
 * to v2. Trust-the-edge: Cloudflare Access gates this surface, so the
 * Worker does not re-check auth.
 */
export async function renderAdminQueue(c: Context<Env>) {
  const db = makeDb(c.env);
  const statusParam = (c.req.query("status") ?? "open") as FlagStatus;
  const status: FlagStatus = STATUSES.includes(statusParam)
    ? statusParam
    : "open";

  const rows = await db
    .select({
      id: moderationFlags.id,
      targetType: moderationFlags.targetType,
      targetId: moderationFlags.targetId,
      reason: moderationFlags.reason,
      status: moderationFlags.status,
      adminNotes: moderationFlags.adminNotes,
      createdAt: moderationFlags.createdAt,
      reporterAgentId: moderationFlags.reporterAgentId,
      reporterName: agents.name,
    })
    .from(moderationFlags)
    .leftJoin(agents, eq(moderationFlags.reporterAgentId, agents.id))
    .where(eq(moderationFlags.status, status))
    .orderBy(desc(moderationFlags.createdAt))
    .limit(100);

  // Best-effort resolve skill slugs for `target_type='skill'` rows
  const skillIds = rows
    .filter((r) => r.targetType === "skill")
    .map((r) => r.targetId);
  const slugMap = new Map<string, string>();
  if (skillIds.length > 0) {
    const skillRows = await db
      .select({ id: skills.id, slug: skills.slug })
      .from(skills);
    for (const sk of skillRows) {
      if (skillIds.includes(sk.id)) slugMap.set(sk.id, sk.slug);
    }
  }

  return c.html(
    <AdminLayout title={`Queue (${status})`}>
      <h1>Moderation queue</h1>
      <div class="stub">
        Read-only v1. Write actions (resolve / dismiss / yank) deferred to v2.
      </div>
      <p>
        Filter:{" "}
        {STATUSES.map((s) => (
          <>
            <a
              href={`/queue?status=${s}`}
              style={
                s === status
                  ? "font-weight:600;text-decoration:underline"
                  : "color:#6b7280;margin-right:8px"
              }
            >
              {s} {s === status ? "" : ""}
            </a>
            {s !== "dismissed" && <span class="muted"> · </span>}
          </>
        ))}
      </p>
      <p class="muted">{rows.length} rows (max 100)</p>
      {rows.length === 0 ? (
        <p class="muted">No flags with status "{status}".</p>
      ) : (
        <table class="admin-table">
          <thead>
            <tr>
              <th>Created</th>
              <th>Target</th>
              <th>Reason</th>
              <th>Reporter</th>
              <th>Comment</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const slug = slugMap.get(r.targetId);
              return (
                <tr>
                  <td class="muted">
                    {new Date(r.createdAt).toISOString().slice(0, 19)}Z
                  </td>
                  <td>
                    <code>{r.targetType}</code>
                    <br />
                    {r.targetType === "skill" && slug ? (
                      <a href={`/skill?id=${r.targetId}`}>{slug}</a>
                    ) : (
                      <code>{r.targetId}</code>
                    )}
                  </td>
                  <td>
                    <code>{r.reason}</code>
                  </td>
                  <td>
                    {r.reporterAgentId ? (
                      <a href={`/agent?id=${r.reporterAgentId}`}>
                        {r.reporterName ?? r.reporterAgentId.slice(0, 8)}
                      </a>
                    ) : (
                      <span class="muted">—</span>
                    )}
                  </td>
                  <td style="max-width:360px">
                    {r.adminNotes ? (
                      <span style="white-space:pre-wrap">{r.adminNotes}</span>
                    ) : (
                      <span class="muted">—</span>
                    )}
                  </td>
                  <td>
                    <span class={`chip chip-${r.status}`}>{r.status}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </AdminLayout>,
  );
}
