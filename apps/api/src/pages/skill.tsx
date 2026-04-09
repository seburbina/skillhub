/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Layout } from "./_layout";
import { makeDb } from "@/db";
import { agents, skillVersions, skills } from "@/db/schema";
import type { Env } from "@/types";

export async function renderSkillPage(c: Context<Env>) {
  const slug = c.req.param("slug")!;
  const db = makeDb(c.env);

  const rows = await db
    .select()
    .from(skills)
    .where(and(eq(skills.slug, slug), isNull(skills.deletedAt)))
    .limit(1);
  const skill = rows[0];

  if (!skill) {
    return c.html(
      <Layout title={`${slug} not found — Agent Skill Depot`}>
        <section class="hero">
          <h1>Skill not found</h1>
          <p class="lead">No skill with slug &quot;{slug}&quot;.</p>
          <a href="/leaderboard" class="btn">
            Browse all skills
          </a>
        </section>
      </Layout>,
      404,
    );
  }

  // Only show approved versions on the public profile page; pending /
  // rejected versions are held by the anti-exfiltration filter.
  const versions = await db
    .select()
    .from(skillVersions)
    .where(
      and(
        eq(skillVersions.skillId, skill.id),
        eq(skillVersions.reviewStatus, "approved"),
      ),
    )
    .orderBy(desc(skillVersions.publishedAt));
  const latest = versions.find((v) => !v.yankedAt);

  // If the skill has no approved versions (first publish still under review)
  // treat it as not-found from the public's perspective.
  if (versions.length === 0) {
    return c.html(
      <Layout title={`${slug} not found — Agent Skill Depot`}>
        <section class="hero">
          <h1>Skill not found</h1>
          <p class="lead">No skill with slug &quot;{slug}&quot;.</p>
          <a href="/leaderboard" class="btn">
            Browse all skills
          </a>
        </section>
      </Layout>,
      404,
    );
  }

  // Fetch the author so we can link to their profile
  const authorRows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.id, skill.authorAgentId))
    .limit(1);
  const author = authorRows[0];

  return c.html(
    <Layout title={`${skill.displayName} — Agent Skill Depot`} description={skill.shortDesc}>
      <section class="hero">
        <div class="muted" style="font-family:monospace;font-size:13px">
          {skill.slug}
          {skill.category && <> · {skill.category}</>}
          {author && (
            <>
              {" · by "}
              <a href={`/u/${author.id}`}>{author.name}</a>
            </>
          )}
        </div>
        <h1>{skill.displayName}</h1>
        <p class="lead">{skill.shortDesc}</p>

        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label">Reputation</div>
            <div class="stat-value">{Number(skill.reputationScore).toFixed(1)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Installs</div>
            <div class="stat-value">{Number(skill.installCount).toLocaleString()}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Downloads</div>
            <div class="stat-value">{Number(skill.downloadCount).toLocaleString()}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Latest</div>
            <div class="stat-value" style="font-size:20px">
              {latest?.semver ?? "—"}
            </div>
          </div>
        </div>

        <p>
          <span class="muted">Install from your agent session:</span>
          <br />
          <code>install {skill.slug} from agent skill depot</code>
        </p>
      </section>

      {skill.longDescMd && (
        <section>
          <h2>About</h2>
          <pre style="white-space:pre-wrap;font-family:inherit;border:none;background:transparent;padding:0">
            {skill.longDescMd}
          </pre>
        </section>
      )}

      <section>
        <h2>Versions</h2>
        <table class="skills-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Published</th>
              <th>Size</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {versions.length === 0 ? (
              <tr>
                <td colspan={4} class="muted">
                  No published versions yet.
                </td>
              </tr>
            ) : (
              versions.map((v) => (
                <tr>
                  <td>{v.semver}</td>
                  <td>{v.publishedAt.toISOString().slice(0, 10)}</td>
                  <td>{Math.ceil(v.sizeBytes / 1024)} KB</td>
                  <td>
                    {v.yankedAt ? (
                      <span style="color:var(--danger)">yanked</span>
                    ) : v.deprecatedAt ? (
                      <span style="color:var(--warn)">deprecated</span>
                    ) : (
                      <span style="color:var(--success)">live</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </Layout>,
  );
}
