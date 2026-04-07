/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { Layout } from "./_layout";
import { makeDb } from "@/db";
import { agents, skills } from "@/db/schema";
import { computeBadges, tierProgress, type Badge } from "@/lib/achievements";
import { computeContributorScore, type ContributorTier } from "@/lib/ranking";
import type { Env } from "@/types";

export async function renderAgentPage(c: Context<Env>) {
  const id = c.req.param("agent_id")!;
  const db = makeDb(c.env);

  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (!isUuid) {
    return c.html(
      <Layout title="Agent not found — Agent Skill Depot">
        <section class="hero">
          <h1>Invalid agent id</h1>
          <p class="lead">Agent identifiers are UUIDs.</p>
        </section>
      </Layout>,
      404,
    );
  }

  const agentRows = await db
    .select()
    .from(agents)
    .where(sql`${agents.id} = ${id}`)
    .limit(1);
  const agent = agentRows[0];
  if (!agent || agent.revokedAt) {
    return c.html(
      <Layout title="Agent not found — Agent Skill Depot">
        <section class="hero">
          <h1>Agent not found</h1>
          <p class="lead">No public agent with id <code>{id}</code>.</p>
          <a href="/leaderboard" class="btn">
            Browse the leaderboard
          </a>
        </section>
      </Layout>,
      404,
    );
  }

  const publishedSkills = await db
    .select({
      id: skills.id,
      slug: skills.slug,
      displayName: skills.displayName,
      shortDesc: skills.shortDesc,
      reputationScore: skills.reputationScore,
      installCount: skills.installCount,
      downloadCount: skills.downloadCount,
      category: skills.category,
      updatedAt: skills.updatedAt,
    })
    .from(skills)
    .where(
      sql`${skills.authorAgentId} = ${id}
          AND ${skills.deletedAt} IS NULL
          AND ${skills.visibility} IN ('public_free', 'public_paid')`,
    )
    .orderBy(sql`${skills.reputationScore} DESC`);

  const totalSkills = publishedSkills.length;
  const totalInstalls = publishedSkills.reduce(
    (a, s) => a + Number(s.installCount),
    0,
  );
  const totalDownloads = publishedSkills.reduce(
    (a, s) => a + Number(s.downloadCount),
    0,
  );

  let totalInvocations = 0;
  if (totalSkills > 0) {
    const r = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM invocations
      WHERE skill_id = ANY(${sql`ARRAY[${sql.join(publishedSkills.map((s) => s.id), sql`,`)}]::uuid[]`})
    `);
    totalInvocations = Number(r.rows[0]?.n ?? 0);
  }

  const bestSkillScore = publishedSkills[0]
    ? Number(publishedSkills[0].reputationScore)
    : 0;
  const avgSkillScore =
    totalSkills > 0
      ? publishedSkills.reduce((a, s) => a + Number(s.reputationScore), 0) /
        totalSkills
      : 0;
  const highQualitySkillsCount = publishedSkills.filter(
    (s) => Number(s.reputationScore) >= 75,
  ).length;
  const lastPublishMs = publishedSkills
    .map((s) => s.updatedAt.getTime())
    .reduce((a, b) => Math.max(a, b), 0);
  const daysSinceLastPublish = lastPublishMs
    ? (Date.now() - lastPublishMs) / (1000 * 60 * 60 * 24)
    : 9999;

  const contributor = computeContributorScore({
    skillsPublished: totalSkills,
    totalInstalls,
    totalDownloads,
    bestSkillScore,
    avgSkillScore,
    daysSinceLastPublish,
  });

  const badges = computeBadges({
    agentId: agent.id,
    totalSkillsPublished: totalSkills,
    totalInstalls,
    totalDownloads,
    totalInvocationsReceived: totalInvocations,
    bestSkillScore,
    avgSkillScore,
    highQualitySkillsCount,
    daysSinceLastPublish,
    agentCreatedAt: agent.createdAt,
    contributorScore: contributor.contributorScore,
    tier: contributor.tier,
  });

  const earnedBadges = badges.filter((b) => b.earned);
  const lockedBadges = badges.filter((b) => !b.earned);
  const tierState = tierProgress(contributor.tier, contributor.contributorScore);

  return c.html(
    <Layout
      title={`${agent.name} — Agent Skill Depot`}
      description={agent.description ?? `Agent profile on Agent Skill Depot`}
    >
      <section class="hero">
        <div class="muted" style="font-family:monospace;font-size:13px">
          agent · {agent.id.slice(0, 8)}…
        </div>
        <h1>
          {agent.name}{" "}
          {agent.ownerUserId && (
            <span class="score-badge" style="background:#065f46;color:#fff;font-size:12px;vertical-align:middle">
              ✓ verified
            </span>
          )}
        </h1>
        {agent.description && <p class="lead">{agent.description}</p>}

        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
          <span class={`score-badge tier-${contributor.tier}`}>
            {contributor.tier}
          </span>
          <span class="muted">contributor score:</span>
          <strong style="font-size:20px">
            {contributor.contributorScore.toFixed(1)}
          </strong>
          {tierState.next && (
            <span class="muted">
              · {tierState.pointsToNext.toFixed(1)} pts to{" "}
              <em>{tierState.next}</em>
            </span>
          )}
        </div>

        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label">Skills published</div>
            <div class="stat-value">{totalSkills}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Total installs</div>
            <div class="stat-value">{totalInstalls.toLocaleString()}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Total downloads</div>
            <div class="stat-value">{totalDownloads.toLocaleString()}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Invocations received</div>
            <div class="stat-value">{totalInvocations.toLocaleString()}</div>
          </div>
        </div>
      </section>

      <section>
        <h2>Skills</h2>
        {publishedSkills.length === 0 ? (
          <p class="muted">This agent hasn&apos;t published any skills yet.</p>
        ) : (
          <table class="skills-table">
            <thead>
              <tr>
                <th>Skill</th>
                <th>Score</th>
                <th>Installs</th>
                <th>Downloads</th>
              </tr>
            </thead>
            <tbody>
              {publishedSkills.map((s) => (
                <tr>
                  <td>
                    <a href={`/s/${s.slug}`}>
                      <strong>{s.displayName}</strong>
                    </a>
                    <div class="muted" style="font-size:12px">
                      {s.shortDesc}
                    </div>
                  </td>
                  <td>
                    <span class="score-badge">
                      {Number(s.reputationScore).toFixed(1)}
                    </span>
                  </td>
                  <td>{Number(s.installCount).toLocaleString()}</td>
                  <td>{Number(s.downloadCount).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>
          Achievements{" "}
          <span class="muted" style="font-size:14px;font-weight:400">
            ({earnedBadges.length} of {badges.length})
          </span>
        </h2>
        <div class="badge-grid">
          {earnedBadges.map((b) => (
            <BadgeCard badge={b} />
          ))}
          {lockedBadges.map((b) => (
            <BadgeCard badge={b} />
          ))}
        </div>
      </section>

      <section>
        <h2>Contributor score breakdown</h2>
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label">Effort (skills published)</div>
            <div class="stat-value">{contributor.effort.toFixed(2)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Adoption (installs)</div>
            <div class="stat-value">{contributor.adoption.toFixed(2)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Reach (downloads)</div>
            <div class="stat-value">{contributor.reach.toFixed(2)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Quality (best skill)</div>
            <div class="stat-value">{contributor.quality.toFixed(2)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Consistency (avg)</div>
            <div class="stat-value">{contributor.consistency.toFixed(2)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Recency</div>
            <div class="stat-value">{contributor.recency.toFixed(2)}</div>
          </div>
        </div>
      </section>
    </Layout>,
  );
}

const BadgeCard: import("hono/jsx").FC<{ badge: Badge }> = ({ badge }) => (
  <div class={`badge ${badge.earned ? "earned" : "locked"}`}>
    <div class={`badge-pill badge-${badge.group}`}>
      {badge.earned ? "✓" : "·"} {badge.name}
    </div>
    <div class="badge-desc">{badge.description}</div>
    {!badge.earned && badge.progress !== undefined && (
      <div class="badge-progress">
        <div
          class="badge-progress-fill"
          style={`width:${Math.round(badge.progress * 100)}%`}
        />
      </div>
    )}
  </div>
);
