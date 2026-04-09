/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import { Layout } from "./_layout";
import type { Env } from "@/types";

/**
 * /dashboard — currently a pre-auth explainer.
 *
 * Full personalized dashboard ships in Phase 2 (requires web sign-in, which
 * we don't have yet). For now this page answers "I clicked Dashboard — what
 * is this?" with a clear next step instead of a roadmap that reads as a
 * dead end.
 */
export function renderDashboardPage(c: Context<Env>) {
  return c.html(
    <Layout title="Dashboard — Agent Skill Depot">
      <section class="hero">
        <h1>Your dashboard lives inside your agent.</h1>
        <p class="lead">
          The base skill already does everything: publish, discover, install,
          auto-update, telemetry — all from your agent session, without
          typing at a web form. This page is for when you want to look at
          numbers without typing at an agent.
        </p>
        <a class="btn" href="/leaderboard">
          See the public leaderboard
        </a>{" "}
        <a class="btn secondary" href="/docs/base-skill">
          Install the base skill
        </a>
      </section>

      <section>
        <h2>Where to look right now</h2>
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label">Your public profile</div>
            <div style="font-size:14px;color:var(--muted);margin-top:6px">
              Open any skill you published, scroll to the author link, click
              through. That&apos;s your tier, badges, reputation, and every
              skill you&apos;ve shipped.
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">Inside your agent</div>
            <div style="font-size:14px;color:var(--muted);margin-top:6px">
              Ask your agent <em>&ldquo;show me my depot stats&rdquo;</em> — the
              base skill fetches your live scores and renders them in-chat.
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">Leaderboard</div>
            <div style="font-size:14px;color:var(--muted);margin-top:6px">
              Filter by category and window to see where your skills rank
              against everyone else&apos;s.
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2>What&apos;s coming</h2>
        <ul>
          <li>
            <strong>Personalized charts.</strong> 30/90-day graphs of installs,
            invocations, ratings, and reputation for every skill you&apos;ve
            published.
          </li>
          <li>
            <strong>Contributor score tracker.</strong> Tier progress, pending
            rating prompts, and week-over-week movement at a glance.
          </li>
          <li>
            <strong>Auto-update controls.</strong> Toggle consent per installed
            skill without dropping into the CLI.
          </li>
          <li>
            <strong>Multi-agent management.</strong> Claim multiple agents
            under one email and see them side-by-side.
          </li>
        </ul>
      </section>
    </Layout>,
  );
}
