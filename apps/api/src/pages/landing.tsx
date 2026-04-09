/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import { Layout } from "./_layout";
import type { Env } from "@/types";

export function renderLanding(c: Context<Env>) {
  return c.html(
    <Layout
      title="Agent Skill Depot — Publisher platform for Agent Skills"
      description="Publish, discover, install, update, and rank Agent Skills. Works with Claude Code, Cursor, Copilot, Codex, Gemini CLI, and 30+ agents."
    >
      <section class="hero">
        <h1>The publisher platform for Agent Skills.</h1>
        <p class="lead">
          Publish once. Install from Claude Code, Cursor, Copilot, Codex,
          Gemini CLI, and every agent that speaks the{" "}
          <a href="https://agentskills.io">open standard</a>. Ranked by how
          much work they actually offload — not by upvotes.
          Everything is free. Everything is scrubbed for secrets before it
          ships.
        </p>
        <a href="/leaderboard" class="btn">
          Browse top skills
        </a>{" "}
        <a href="/docs/base-skill" class="btn secondary">
          Install the base skill
        </a>
      </section>

      <section>
        <h2>How it works</h2>
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label">1 · Install</div>
            <div style="font-size:15px;font-weight:500">
              Drop the <code>skillhub</code> base skill into{" "}
              <code>~/.claude/skills/</code>. Your agent handles everything from
              there.
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">2 · Discover</div>
            <div style="font-size:15px;font-weight:500">
              When you describe a task, your agent asks &quot;want me to check
              Agent Skill Depot first?&quot; Never searches silently.
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">3 · Publish</div>
            <div style="font-size:15px;font-weight:500">
              Built a great skill? Say &quot;share this.&quot; Regex + LLM scrub
              locally, you approve the diff, then it goes public.
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">4 · Rank</div>
            <div style="font-size:15px;font-weight:500">
              Skills that cut follow-up iterations climb the leaderboard. So do
              their authors.
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2>Built on the skills you already have</h2>
        <p>
          Agent Skill Depot composes with Anthropic&apos;s{" "}
          <code>skill-creator</code> skill. Every publish runs through{" "}
          <code>skill-creator</code>&apos;s quality gate first — frontmatter,
          docs, LICENSE, changelog — so only well-built skills ever enter the
          privacy pipeline. You author with <code>skill-creator</code>; you
          distribute with Agent Skill Depot.
        </p>
      </section>

      <section>
        <h2>What&apos;s different</h2>
        <ul>
          <li>
            <strong>Skill-first.</strong> Every contribution is an executable
            Agent Skill — not a post, not a comment.
          </li>
          <li>
            <strong>Performance ranking.</strong> Scored by follow-up
            iterations, ratings, installs, and speed. Weighted toward fewer
            iterations because that&apos;s what matters.
          </li>
          <li>
            <strong>Privacy as a first step.</strong> Multi-stage scrub: local
            regex, agent-driven LLM review, user approval, server-side re-scan.
            Nothing leaves your machine until you type <code>publish</code>.
          </li>
          <li>
            <strong>Proactive discovery.</strong> Your agent offers relevant
            skills before you burn tokens writing from scratch.
          </li>
        </ul>
      </section>
    </Layout>,
  );
}
