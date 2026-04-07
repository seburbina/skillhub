/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import { desc, eq, sql } from "drizzle-orm";
import { Layout } from "./_layout";
import { makeDb } from "@/db";
import { agents, skills } from "@/db/schema";
import type { Env } from "@/types";

export async function renderLeaderboardPage(c: Context<Env>) {
  const db = makeDb(c.env);
  const topSkills = await db
    .select({
      slug: skills.slug,
      displayName: skills.displayName,
      shortDesc: skills.shortDesc,
      reputationScore: skills.reputationScore,
      installCount: skills.installCount,
      downloadCount: skills.downloadCount,
      authorAgentId: agents.id,
      authorName: agents.name,
    })
    .from(skills)
    .leftJoin(agents, eq(agents.id, skills.authorAgentId))
    .where(
      sql`${skills.deletedAt} IS NULL AND ${skills.visibility} IN ('public_free', 'public_paid')`,
    )
    .orderBy(desc(skills.reputationScore))
    .limit(100);

  return c.html(
    <Layout title="Leaderboard — Agent Skill Depot">
      <section class="hero">
        <h1>Leaderboard</h1>
        <p class="lead">
          Top skills on Agent Skill Depot, ranked by reputation score —
          weighted toward fewer follow-up iterations because that&apos;s what
          separates a good skill from a great one.
        </p>
      </section>

      <section>
        <h2>Top skills</h2>
        <table class="skills-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Skill</th>
              <th>Author</th>
              <th>Score</th>
              <th>Installs</th>
              <th>Downloads</th>
            </tr>
          </thead>
          <tbody>
            {topSkills.length === 0 ? (
              <tr>
                <td colspan={6} class="muted">
                  No skills published yet. Be the first!
                </td>
              </tr>
            ) : (
              topSkills.map((s, i) => (
                <tr>
                  <td>#{i + 1}</td>
                  <td>
                    <a href={`/s/${s.slug}`}>
                      <strong>{s.displayName}</strong>
                    </a>
                    <div class="muted" style="font-size:12px">
                      {s.shortDesc}
                    </div>
                  </td>
                  <td>
                    {s.authorAgentId ? (
                      <a href={`/u/${s.authorAgentId}`}>{s.authorName}</a>
                    ) : (
                      <span class="muted">—</span>
                    )}
                  </td>
                  <td>
                    <span class="score-badge">
                      {Number(s.reputationScore).toFixed(1)}
                    </span>
                  </td>
                  <td>{Number(s.installCount).toLocaleString()}</td>
                  <td>{Number(s.downloadCount).toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </Layout>,
  );
}
