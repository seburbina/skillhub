/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import { and, desc, eq, or } from "drizzle-orm";
import { AdminLayout } from "./_layout";
import { makeDb } from "@/db";
import {
  agents,
  moderationFlags,
  skillVersions,
  skills,
} from "@/db/schema";
import type { Env } from "@/types";

/**
 * Admin skill lookup — enter a slug or UUID, see the full skill row
 * plus version history and any moderation flags attached to it.
 */
export async function renderAdminSkill(c: Context<Env>) {
  const q = c.req.query("id") ?? c.req.query("slug") ?? "";
  const db = makeDb(c.env);

  const header = (
    <form method="get" action="/skill" style="margin-bottom:16px">
      <input
        type="text"
        name="id"
        value={q}
        placeholder="slug or UUID"
        style="width:360px;padding:6px 10px;font-family:ui-monospace,Menlo,monospace;font-size:13px"
      />{" "}
      <button type="submit">Lookup</button>
    </form>
  );

  if (!q) {
    return c.html(
      <AdminLayout title="Skill lookup">
        <h1>Skill lookup</h1>
        {header}
        <p class="muted">Enter a slug or UUID above.</p>
      </AdminLayout>,
    );
  }

  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);

  const skillRows = await db
    .select()
    .from(skills)
    .where(isUuid ? eq(skills.id, q) : eq(skills.slug, q))
    .limit(1);
  const skill = skillRows[0];
  if (!skill) {
    return c.html(
      <AdminLayout title="Skill lookup">
        <h1>Skill lookup</h1>
        {header}
        <p class="muted">No skill matching "{q}".</p>
      </AdminLayout>,
    );
  }

  const versions = await db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skill.id))
    .orderBy(desc(skillVersions.publishedAt));

  const flags = await db
    .select({
      id: moderationFlags.id,
      reason: moderationFlags.reason,
      status: moderationFlags.status,
      createdAt: moderationFlags.createdAt,
      reporterAgentId: moderationFlags.reporterAgentId,
      reporterName: agents.name,
      adminNotes: moderationFlags.adminNotes,
    })
    .from(moderationFlags)
    .leftJoin(agents, eq(moderationFlags.reporterAgentId, agents.id))
    .where(
      and(
        eq(moderationFlags.targetType, "skill"),
        eq(moderationFlags.targetId, skill.id),
      ),
    )
    .orderBy(desc(moderationFlags.createdAt))
    .limit(50);

  return c.html(
    <AdminLayout title={`Skill ${skill.slug}`}>
      <h1>{skill.displayName}</h1>
      {header}
      <p class="muted">
        <code>{skill.slug}</code> ·{" "}
        <a href={`/s/${skill.slug}`} target="_blank" rel="noreferrer">
          Public page ↗
        </a>{" "}
        ·{" "}
        <a href={`/agent?id=${skill.authorAgentId}`}>Author</a>
      </p>

      <h2>Skill row</h2>
      <table class="admin-table">
        <tbody>
          <Row label="id" value={<code>{skill.id}</code>} />
          <Row label="slug" value={skill.slug} />
          <Row label="display_name" value={skill.displayName} />
          <Row label="short_desc" value={skill.shortDesc} />
          <Row label="category" value={skill.category ?? "—"} />
          <Row
            label="visibility"
            value={<code>{skill.visibility}</code>}
          />
          <Row label="install_count" value={skill.installCount ?? 0} />
          <Row label="download_count" value={skill.downloadCount ?? 0} />
          <Row label="reputation_score" value={skill.reputationScore} />
          <Row
            label="current_version_id"
            value={skill.currentVersionId ?? "—"}
          />
          <Row label="created_at" value={iso(skill.createdAt)} />
          <Row label="updated_at" value={iso(skill.updatedAt)} />
          <Row
            label="deleted_at"
            value={
              skill.deletedAt ? (
                <span class="chip chip-yanked">{iso(skill.deletedAt)}</span>
              ) : (
                "—"
              )
            }
          />
        </tbody>
      </table>

      <h2>Versions ({versions.length})</h2>
      <table class="admin-table">
        <thead>
          <tr>
            <th>Semver</th>
            <th>Published</th>
            <th>Size</th>
            <th>R2 key</th>
            <th>GitHub SHA</th>
            <th>Yanked</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr>
              <td>
                <code>{v.semver}</code>
                {skill.currentVersionId === v.id && (
                  <>
                    {" "}
                    <span class="chip chip-resolved">current</span>
                  </>
                )}
              </td>
              <td class="muted">{iso(v.publishedAt)}</td>
              <td class="muted">{v.sizeBytes.toLocaleString()} B</td>
              <td>
                <code>{v.r2Key}</code>
              </td>
              <td class="muted">
                {v.githubCommitSha ? (
                  <code>{v.githubCommitSha.slice(0, 8)}</code>
                ) : (
                  "—"
                )}
              </td>
              <td>
                {v.yankedAt ? (
                  <span class="chip chip-yanked">{iso(v.yankedAt)}</span>
                ) : (
                  <span class="muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Moderation flags ({flags.length})</h2>
      {flags.length === 0 ? (
        <p class="muted">No flags.</p>
      ) : (
        <table class="admin-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Reason</th>
              <th>Reporter</th>
              <th>Comment</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {flags.map((f) => (
              <tr>
                <td class="muted">{iso(f.createdAt)}</td>
                <td>
                  <code>{f.reason}</code>
                </td>
                <td>
                  {f.reporterAgentId ? (
                    <a href={`/agent?id=${f.reporterAgentId}`}>
                      {f.reporterName ?? f.reporterAgentId.slice(0, 8)}
                    </a>
                  ) : (
                    <span class="muted">—</span>
                  )}
                </td>
                <td style="max-width:300px">
                  {f.adminNotes ? (
                    <span style="white-space:pre-wrap">{f.adminNotes}</span>
                  ) : (
                    <span class="muted">—</span>
                  )}
                </td>
                <td>
                  <span class={`chip chip-${f.status}`}>{f.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminLayout>,
  );
}

function Row({ label, value }: { label: string; value: unknown }) {
  return (
    <tr>
      <th style="width:180px">
        <code>{label}</code>
      </th>
      <td>{value as any}</td>
    </tr>
  );
}

function iso(d: Date | string): string {
  return new Date(d).toISOString().slice(0, 19) + "Z";
}
