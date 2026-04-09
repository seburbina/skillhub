/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import { desc, eq } from "drizzle-orm";
import { AdminLayout } from "./_layout";
import { makeDb } from "@/db";
import { agents, scrubReports, skills, skillVersions } from "@/db/schema";
import type { Env } from "@/types";

type ReviewStatus = "pending" | "approved" | "rejected";
const STATUSES: ReviewStatus[] = ["pending", "approved", "rejected"];

interface ExfilFinding {
  type?: string;
  severity?: string;
  tier?: string;
  file?: string;
  line?: number;
  snippet?: string;
  reason?: string;
}

/**
 * Admin anti-exfiltration review queue — read-only v1. Lists skill
 * versions held by the exfiltration filter (`review_status = 'pending'`)
 * and their findings. Clearing the hold (approve / reject) is still done
 * via SQL per docs/review-queue-runbook.md; hooking the write path into
 * this surface is v2 alongside the rest of the admin writes.
 *
 * Trust-the-edge: Cloudflare Access gates admin.agentskilldepot.com, so
 * the Worker performs no additional auth checks.
 */
export async function renderAdminReviewQueue(c: Context<Env>) {
  const db = makeDb(c.env);
  const statusParam = (c.req.query("status") ?? "pending") as ReviewStatus;
  const status: ReviewStatus = STATUSES.includes(statusParam)
    ? statusParam
    : "pending";

  const rows = await db
    .select({
      versionId: skillVersions.id,
      semver: skillVersions.semver,
      publishedAt: skillVersions.publishedAt,
      reviewNotes: skillVersions.reviewNotes,
      skillId: skills.id,
      slug: skills.slug,
      displayName: skills.displayName,
      authorAgentId: skills.authorAgentId,
      authorName: agents.name,
      llmFindings: scrubReports.llmFindings,
    })
    .from(skillVersions)
    .innerJoin(skills, eq(skills.id, skillVersions.skillId))
    .leftJoin(agents, eq(agents.id, skills.authorAgentId))
    .leftJoin(scrubReports, eq(scrubReports.id, skillVersions.scrubReportId))
    .where(eq(skillVersions.reviewStatus, status))
    .orderBy(desc(skillVersions.publishedAt))
    .limit(100);

  return c.html(
    <AdminLayout title={`Exfiltration queue (${status})`}>
      <h1>Anti-exfiltration review queue</h1>
      <div class="stub">
        Read-only v1. Approve / reject actions still run via SQL per{" "}
        <code>docs/review-queue-runbook.md</code>. Write path deferred to v2.
      </div>
      <p>
        Filter:{" "}
        {STATUSES.map((s) => (
          <>
            <a
              href={`/review-queue?status=${s}`}
              style={
                s === status
                  ? "font-weight:600;text-decoration:underline"
                  : "color:#6b7280;margin-right:8px"
              }
            >
              {s}
            </a>
            {s !== "rejected" && <span class="muted"> · </span>}
          </>
        ))}
      </p>
      <p class="muted">{rows.length} rows (max 100)</p>
      {rows.length === 0 ? (
        <p class="muted">No versions with review_status "{status}".</p>
      ) : (
        <table class="admin-table">
          <thead>
            <tr>
              <th>Published</th>
              <th>Skill</th>
              <th>Version</th>
              <th>Author</th>
              <th>Findings</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const findings: ExfilFinding[] = Array.isArray(r.llmFindings)
                ? (r.llmFindings as ExfilFinding[])
                : [];
              const reviewFindings = findings.filter(
                (f) => f.severity === "review" || f.severity === "block",
              );
              return (
                <tr>
                  <td class="muted">
                    {new Date(r.publishedAt).toISOString().slice(0, 19)}Z
                  </td>
                  <td>
                    <a href={`/skill?id=${r.skillId}`}>{r.slug}</a>
                    <br />
                    <span class="muted">{r.displayName}</span>
                  </td>
                  <td>
                    <code>{r.semver}</code>
                    <br />
                    <span class="muted" style="font-size:11px">
                      {r.versionId.slice(0, 8)}
                    </span>
                  </td>
                  <td>
                    {r.authorAgentId ? (
                      <a href={`/agent?id=${r.authorAgentId}`}>
                        {r.authorName ?? r.authorAgentId.slice(0, 8)}
                      </a>
                    ) : (
                      <span class="muted">—</span>
                    )}
                  </td>
                  <td style="max-width:420px">
                    {reviewFindings.length === 0 ? (
                      <span class="muted">—</span>
                    ) : (
                      <ul style="margin:0;padding-left:16px">
                        {reviewFindings.slice(0, 6).map((f) => (
                          <li style="font-size:12px;margin-bottom:4px">
                            <code>{f.type ?? "unknown"}</code>
                            {f.tier ? (
                              <span class="muted"> [{f.tier}]</span>
                            ) : null}
                            {f.file ? (
                              <>
                                {" "}
                                <span class="muted">
                                  {f.file}
                                  {f.line ? `:${f.line}` : ""}
                                </span>
                              </>
                            ) : null}
                            {f.reason ? (
                              <div style="color:#374151;white-space:pre-wrap">
                                {f.reason}
                              </div>
                            ) : null}
                          </li>
                        ))}
                        {reviewFindings.length > 6 ? (
                          <li class="muted" style="font-size:11px">
                            +{reviewFindings.length - 6} more
                          </li>
                        ) : null}
                      </ul>
                    )}
                  </td>
                  <td style="max-width:240px">
                    {r.reviewNotes ? (
                      <span
                        style="white-space:pre-wrap;font-size:12px"
                      >
                        {r.reviewNotes}
                      </span>
                    ) : (
                      <span class="muted">—</span>
                    )}
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
