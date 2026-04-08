/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import { and, desc, eq, gte, isNull, sql, type SQL } from "drizzle-orm";
import { Layout } from "./_layout";
import { makeDb } from "@/db";
import { agents, skills } from "@/db/schema";
import type { Env } from "@/types";

type Window = "today" | "week" | "all";

/**
 * /leaderboard — top skills with category and time-window filters.
 *
 * Phase 1: adds server-rendered chip filters (no JS needed), rank medals
 * for the top 3, and a category-aware empty state. `?category=` filters by
 * the `skills.category` column. `?window=today|week|all` filters by
 * `created_at`. Default window is "all".
 */
export async function renderLeaderboardPage(c: Context<Env>) {
  const db = makeDb(c.env);
  const rawCategory = (c.req.query("category") ?? "").trim();
  const rawWindow = (c.req.query("window") ?? "all").trim().toLowerCase();
  const window: Window = rawWindow === "today" || rawWindow === "week" ? rawWindow : "all";
  const selectedCategory = rawCategory || null;

  // Build the filter list using drizzle helpers — safer than nested sql
  // template interpolation, which tripped up on empty branches.
  const conditions: SQL[] = [
    isNull(skills.deletedAt),
    sql`${skills.visibility} IN ('public_free', 'public_paid')`,
  ];
  if (selectedCategory) {
    conditions.push(eq(skills.category, selectedCategory));
  }
  if (window === "today") {
    conditions.push(gte(skills.createdAt, sql`NOW() - INTERVAL '1 day'`));
  } else if (window === "week") {
    conditions.push(gte(skills.createdAt, sql`NOW() - INTERVAL '7 days'`));
  }

  const topSkills = await db
    .select({
      slug: skills.slug,
      displayName: skills.displayName,
      shortDesc: skills.shortDesc,
      reputationScore: skills.reputationScore,
      installCount: skills.installCount,
      downloadCount: skills.downloadCount,
      category: skills.category,
      authorAgentId: agents.id,
      authorName: agents.name,
    })
    .from(skills)
    .leftJoin(agents, eq(agents.id, skills.authorAgentId))
    .where(and(...conditions))
    .orderBy(desc(skills.reputationScore))
    .limit(100);

  // Category chips: load distinct categories with counts (public only).
  const categoryRows = await db.execute<{ category: string; n: number }>(sql`
    SELECT category, COUNT(*)::int AS n
    FROM skills
    WHERE deleted_at IS NULL
      AND visibility IN ('public_free', 'public_paid')
      AND category IS NOT NULL
      AND category <> ''
    GROUP BY category
    ORDER BY n DESC, category ASC
    LIMIT 20
  `);
  const categories = categoryRows.rows.map((r) => ({
    category: r.category,
    n: Number(r.n),
  }));

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
        {categories.length > 0 && (
          <>
            <div
              class="muted"
              style="font-size:12px;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px"
            >
              Category
            </div>
            <div class="chip-row">
              <a
                href={withQuery({ category: null, window })}
                class={`chip${selectedCategory === null ? " active" : ""}`}
              >
                All
              </a>
              {categories.map((c) => (
                <a
                  href={withQuery({ category: c.category, window })}
                  class={`chip${selectedCategory === c.category ? " active" : ""}`}
                >
                  {c.category}
                  <span class="chip-count">{c.n}</span>
                </a>
              ))}
            </div>
          </>
        )}

        <div
          class="muted"
          style="font-size:12px;text-transform:uppercase;letter-spacing:0.04em;margin:12px 0 8px"
        >
          When
        </div>
        <div class="chip-row">
          <a
            href={withQuery({ category: selectedCategory, window: "today" })}
            class={`chip${window === "today" ? " active" : ""}`}
          >
            Today
          </a>
          <a
            href={withQuery({ category: selectedCategory, window: "week" })}
            class={`chip${window === "week" ? " active" : ""}`}
          >
            This week
          </a>
          <a
            href={withQuery({ category: selectedCategory, window: "all" })}
            class={`chip${window === "all" ? " active" : ""}`}
          >
            All time
          </a>
        </div>
      </section>

      <section>
        <h2>Top skills</h2>
        {topSkills.length === 0 ? (
          <div class="card">
            <div style="font-weight:600;margin-bottom:6px">
              Nothing here{selectedCategory ? ` in ${selectedCategory}` : ""} yet.
            </div>
            <p class="muted" style="margin:0 0 14px">
              {selectedCategory || window !== "all"
                ? "Try a different filter, or be the first to publish in this slice."
                : "Be the first to publish a skill."}
            </p>
            <a class="btn secondary" href="/docs/base-skill">
              How to publish →
            </a>
          </div>
        ) : (
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
              {topSkills.map((s, i) => (
                <tr>
                  <td>
                    {i < 3 ? (
                      <span class={`rank-medal rank-${i + 1}`}>{i + 1}</span>
                    ) : (
                      <span class="muted">#{i + 1}</span>
                    )}
                  </td>
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
              ))}
            </tbody>
          </table>
        )}
      </section>
    </Layout>,
  );
}

function withQuery(params: { category: string | null; window: Window }) {
  const q = new URLSearchParams();
  if (params.category) q.set("category", params.category);
  if (params.window && params.window !== "all") q.set("window", params.window);
  const s = q.toString();
  return s ? `/leaderboard?${s}` : "/leaderboard";
}
