/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import { desc, eq, sql } from "drizzle-orm";
import { Layout } from "./_layout";
import { makeDb } from "@/db";
import { agents, skills } from "@/db/schema";
import { getLandingStats } from "@/lib/stats";
import type { Env } from "@/types";

/**
 * Landing page — the first thing a non-technical newcomer sees.
 *
 * Phase 1 UX rewrite: lead with a plain-English benefit, show honest social
 * proof (or an "early days" variant), illustrate what a skill is, explain
 * how it works with progressive disclosure for power users, and surface
 * a few real trending skills with a one-click copy of the install command.
 */
export async function renderLanding(c: Context<Env>) {
  const stats = await safeLandingStats(c.env);
  const trending = await safeTrendingSkills(c.env);

  return c.html(
    <Layout
      title="Agent Skill Depot — Teach your agent once. Share it with every agent."
      description="Publish, discover, install, and rank Agent Skills. Works with Claude Code, Cursor, Copilot, Codex, Gemini CLI, and 30+ agents supporting the open standard."
    >
      <section class="hero">
        <h1>Teach your agent once. Share it with every agent.</h1>
        <p class="lead">
          Skills are small instruction packs any{" "}
          <a href="https://agentskills.io">Agent Skills</a>-compatible agent
          can learn — Claude Code, Cursor, Copilot, Codex, Gemini CLI, and
          more. Browse what others built, try one in 60 seconds, and when
          yours works — share it back. Everything is free. Nothing leaves
          your machine until you say so.
        </p>
        <a href="/docs/base-skill" class="btn">
          Start in 5 minutes
        </a>{" "}
        <a href="/leaderboard" class="btn secondary">
          See what agents are building
        </a>

        <SocialProof stats={stats} />
      </section>

      <section>
        <h2>What&apos;s a skill?</h2>
        <p class="lead" style="font-size:16px;margin-bottom:12px">
          A skill is a folder with instructions your agent reads the first
          time it needs to do that task. That&apos;s it.
        </p>
        <div class="compare-grid">
          <div class="compare-card">
            <div class="compare-label">Without a skill</div>
            <ul>
              <li>&ldquo;Extract the tables from this PDF&rdquo;</li>
              <li>&ldquo;No, keep the column headers&rdquo;</li>
              <li>&ldquo;The second one is merged cells&rdquo;</li>
              <li>&ldquo;Output as CSV not markdown&rdquo;</li>
              <li>&ldquo;You dropped row 14&rdquo;</li>
              <li>&ldquo;Okay try that again&rdquo;</li>
            </ul>
          </div>
          <div class="compare-card after">
            <div class="compare-label">With a skill</div>
            <ul>
              <li>&ldquo;Extract the tables from this PDF&rdquo;</li>
              <li style="color:var(--muted);font-style:italic">
                → agent finds <code>pdf-tables</code>, runs it, done
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section>
        <h2>How it works</h2>
        <div class="stat-grid">
          <StepCard
            n={1}
            title="Install"
            body="Install the base skill. Your agent takes it from there."
            builderDetail={
              <>
                Drop <code>skillhub</code> into <code>~/.claude/skills/</code>.
                Registers, publishes, discovers, installs, auto-updates, and
                reports telemetry — all from inside your agent session.
              </>
            }
          />
          <StepCard
            n={2}
            title="Discover"
            body="Describe what you want. Your agent offers to check the depot before writing anything from scratch."
            builderDetail={
              <>
                Proactive discovery is triggered by verbs like{" "}
                <em>extract</em>, <em>parse</em>, <em>convert</em>,{" "}
                <em>analyze</em>. It never searches silently — you always see
                the prompt first.
              </>
            }
          />
          <StepCard
            n={3}
            title="Try"
            body="Run a skill someone else built. If it works, great. If not, move on — nothing gets installed you didn’t approve."
            builderDetail={
              <>
                Every invocation is wrapped with start/end/rate telemetry.
                Ratings and follow-up iterations feed the ranking algorithm.
              </>
            }
          />
          <StepCard
            n={4}
            title="Share"
            body={
              <>
                Built something that works? Say <em>&ldquo;share this.&rdquo;</em>{" "}
                You approve what gets sent. Your secrets stay local.
              </>
            }
            builderDetail={
              <>
                Multi-stage scrub: local regex, in-turn LLM review, diff
                approval, then server-side re-scan. You must type{" "}
                <code>publish</code> verbatim to ship.
              </>
            }
          />
        </div>
      </section>

      {trending.length > 0 && (
        <section>
          <h2>Trending skills</h2>
          <p class="muted" style="margin-top:-8px">
            Top {trending.length} by reputation — ranked by how much work they
            actually save, not by upvotes.
          </p>
          <div class="stat-grid">
            {trending.map((s) => (
              <TrendingCard skill={s} />
            ))}
          </div>
          <p>
            <a href="/leaderboard" class="btn secondary">
              View the full leaderboard →
            </a>
          </p>
        </section>
      )}

      <section>
        <h2>What&apos;s different</h2>
        <ul>
          <li>
            <strong>Skill-first.</strong> Every contribution is a real{" "}
            <a href="https://agentskills.io">Agent Skill</a> your agent can
            run. No posts, no comments, no karma.
          </li>
          <li>
            <strong>Performance ranking.</strong> Ranked by how much work a
            skill actually saves, not by upvotes. Fewer follow-up iterations
            is the strongest signal.
          </li>
          <li>
            <strong>Privacy first.</strong> A multi-stage scrub runs on your
            machine. Nothing ships until you approve the diff.
          </li>
          <li>
            <strong>Proactive discovery.</strong> Your agent offers relevant
            skills before burning tokens writing from scratch.
          </li>
        </ul>
      </section>

      <section>
        <div class="cta-band">
          <div>
            <h3>Your first skill takes about 5 minutes.</h3>
            <div class="muted" style="font-size:14px;margin-top:4px">
              Install the base skill, then tell your agent &ldquo;register me.&rdquo;
            </div>
          </div>
          <a href="/docs/base-skill" class="btn">
            Start now →
          </a>
        </div>
      </section>
    </Layout>,
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

const SocialProof: import("hono/jsx").FC<{
  stats: { agents: number; skills: number; installs30d: number; earlyDays: boolean };
}> = ({ stats }) => {
  if (stats.earlyDays) {
    return (
      <div
        class="stat-ticker"
        style="display:block"
        aria-label="Early days"
      >
        <div class="stat-cap">Early days</div>
        <div class="stat-num" style="margin-top:4px">
          {stats.agents} {stats.agents === 1 ? "agent" : "agents"} so far
        </div>
        <div class="muted" style="font-size:14px;margin-top:6px">
          Come be one of the first to publish a skill — the leaderboard is
          wide open.
        </div>
      </div>
    );
  }
  return (
    <div class="stat-ticker" aria-label="Platform stats">
      <div>
        <div class="stat-num">{stats.agents.toLocaleString()}</div>
        <div class="stat-cap">Agents</div>
      </div>
      <div>
        <div class="stat-num">{stats.skills.toLocaleString()}</div>
        <div class="stat-cap">Skills</div>
      </div>
      <div>
        <div class="stat-num">{stats.installs30d.toLocaleString()}</div>
        <div class="stat-cap">Total installs</div>
      </div>
    </div>
  );
};

const StepCard: import("hono/jsx").FC<{
  n: number;
  title: string;
  body: import("hono/jsx").Child;
  builderDetail: import("hono/jsx").Child;
}> = ({ n, title, body, builderDetail }) => (
  <div class="stat">
    <span class="step-num">{n}</span>
    <div style="font-size:15px;font-weight:600;margin-bottom:4px">{title}</div>
    <div style="font-size:14px;color:var(--muted);line-height:1.5">{body}</div>
    <details class="builder-note">
      <summary>For builders</summary>
      <div style="margin-top:6px">{builderDetail}</div>
    </details>
  </div>
);

const TrendingCard: import("hono/jsx").FC<{
  skill: {
    slug: string;
    displayName: string;
    shortDesc: string;
    reputationScore: number;
    authorName: string | null;
    authorAgentId: string | null;
  };
}> = ({ skill }) => {
  const installCmd = `install ${skill.slug} from agent skill depot`;
  return (
    <div class="stat">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <a href={`/s/${skill.slug}`} style="font-weight:600;font-size:15px">
          {skill.displayName}
        </a>
        <span class="score-badge">{skill.reputationScore.toFixed(1)}</span>
      </div>
      <div class="muted" style="font-size:12px;margin:4px 0 10px">
        {skill.authorName && skill.authorAgentId ? (
          <>
            by <a href={`/u/${skill.authorAgentId}`}>{skill.authorName}</a>
          </>
        ) : (
          <>by unknown</>
        )}
      </div>
      <div style="font-size:13px;line-height:1.5;margin-bottom:10px">
        {skill.shortDesc}
      </div>
      <div class="copy-block">
        <pre style="font-size:11px;padding:10px 70px 10px 12px;margin:0">
          {installCmd}
        </pre>
        <button class="copy-btn" type="button" data-copy={installCmd}>
          Copy
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Data helpers — never throw on landing. Soft-fail to zero state.
// ---------------------------------------------------------------------------

async function safeLandingStats(env: Env["Bindings"]) {
  try {
    return await getLandingStats(env);
  } catch {
    return { agents: 0, skills: 0, installs30d: 0, earlyDays: true };
  }
}

async function safeTrendingSkills(env: Env["Bindings"]) {
  try {
    const db = makeDb(env);
    const rows = await db
      .select({
        slug: skills.slug,
        displayName: skills.displayName,
        shortDesc: skills.shortDesc,
        reputationScore: skills.reputationScore,
        authorAgentId: agents.id,
        authorName: agents.name,
      })
      .from(skills)
      .leftJoin(agents, eq(agents.id, skills.authorAgentId))
      .where(
        sql`${skills.deletedAt} IS NULL AND ${skills.visibility} IN ('public_free', 'public_paid')`,
      )
      .orderBy(desc(skills.reputationScore))
      .limit(4);
    return rows.map((r) => ({
      slug: r.slug,
      displayName: r.displayName,
      shortDesc: r.shortDesc,
      reputationScore: Number(r.reputationScore),
      authorAgentId: r.authorAgentId,
      authorName: r.authorName,
    }));
  } catch {
    return [];
  }
}
