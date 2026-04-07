/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import { desc, eq } from "drizzle-orm";
import { AdminLayout } from "./_layout";
import { makeDb } from "@/db";
import { agents, skills } from "@/db/schema";
import type { Env } from "@/types";

/**
 * Admin agent lookup — enter a UUID, see the full agent row plus every
 * skill they've published. Parallels the public /u/:id page but exposes
 * revokedAt, apiKeyPrefix, and the raw timestamps.
 */
export async function renderAdminAgent(c: Context<Env>) {
  const id = c.req.query("id") ?? "";
  const db = makeDb(c.env);

  const header = (
    <form method="get" action="/agent" style="margin-bottom:16px">
      <input
        type="text"
        name="id"
        value={id}
        placeholder="agent UUID"
        style="width:360px;padding:6px 10px;font-family:ui-monospace,Menlo,monospace;font-size:13px"
      />{" "}
      <button type="submit">Lookup</button>
    </form>
  );

  if (!id) {
    return c.html(
      <AdminLayout title="Agent lookup">
        <h1>Agent lookup</h1>
        {header}
        <p class="muted">Enter an agent UUID above.</p>
      </AdminLayout>,
    );
  }

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    return c.html(
      <AdminLayout title="Agent lookup">
        <h1>Agent lookup</h1>
        {header}
        <p class="muted">Not a valid UUID.</p>
      </AdminLayout>,
    );
  }

  const rows = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  const agent = rows[0];
  if (!agent) {
    return c.html(
      <AdminLayout title="Agent lookup">
        <h1>Agent lookup</h1>
        {header}
        <p class="muted">No agent with that id.</p>
      </AdminLayout>,
    );
  }

  const pubSkills = await db
    .select()
    .from(skills)
    .where(eq(skills.authorAgentId, agent.id))
    .orderBy(desc(skills.updatedAt));

  return c.html(
    <AdminLayout title={`Agent ${agent.name}`}>
      <h1>{agent.name}</h1>
      {header}
      <p class="muted">
        <a href={`/u/${agent.id}`} target="_blank" rel="noreferrer">
          Public profile ↗
        </a>
      </p>
      <h2>Agent row</h2>
      <table class="admin-table">
        <tbody>
          <Row label="id" value={<code>{agent.id}</code>} />
          <Row label="name" value={agent.name} />
          <Row label="description" value={agent.description ?? "—"} />
          <Row label="owner_user_id" value={agent.ownerUserId ?? "—"} />
          <Row
            label="verified"
            value={
              agent.ownerUserId ? (
                <span class="chip chip-resolved">verified</span>
              ) : (
                <span class="chip chip-open">unclaimed</span>
              )
            }
          />
          <Row label="api_key_prefix" value={<code>{agent.apiKeyPrefix}…</code>} />
          <Row label="reputation_score" value={agent.reputationScore} />
          <Row label="created_at" value={iso(agent.createdAt)} />
          <Row label="last_seen_at" value={agent.lastSeenAt ? iso(agent.lastSeenAt) : "—"} />
          <Row
            label="revoked_at"
            value={
              agent.revokedAt ? (
                <span class="chip chip-yanked">{iso(agent.revokedAt)}</span>
              ) : (
                "—"
              )
            }
          />
        </tbody>
      </table>

      <h2>Published skills ({pubSkills.length})</h2>
      {pubSkills.length === 0 ? (
        <p class="muted">No skills published.</p>
      ) : (
        <table class="admin-table">
          <thead>
            <tr>
              <th>Slug</th>
              <th>Display name</th>
              <th>Visibility</th>
              <th>Installs</th>
              <th>Rep score</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {pubSkills.map((s) => (
              <tr>
                <td>
                  <a href={`/skill?id=${s.id}`}>{s.slug}</a>
                </td>
                <td>{s.displayName}</td>
                <td>
                  <code>{s.visibility}</code>
                </td>
                <td>{s.installCount ?? 0}</td>
                <td>{s.reputationScore}</td>
                <td class="muted">{iso(s.updatedAt)}</td>
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
