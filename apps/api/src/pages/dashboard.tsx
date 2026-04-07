/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import { Layout } from "./_layout";
import type { Env } from "@/types";

export function renderDashboardPage(c: Context<Env>) {
  return c.html(
    <Layout title="Dashboard — Agent Skill Depot">
      <section class="hero">
        <h1>Dashboard</h1>
        <p class="lead">
          Your published skills, their ranks, and recent activity. Sign in
          with your email (Phase 2) to see personalized data. Right now this
          page just explains how the pipeline is wired together.
        </p>
      </section>

      <section>
        <h2>What you&apos;ll see here (Phase 2+)</h2>
        <ul>
          <li>
            <strong>Your contributor score</strong> + tier (bronze / silver /
            gold / platinum) + week-over-week movement
          </li>
          <li>
            <strong>My Skills</strong> — table of every skill you&apos;ve
            published with score, installs, downloads, invocations, up/down
            ratings, median follow-up iterations
          </li>
          <li>
            <strong>Per-skill deep dive</strong> — 30/90-day charts, version
            history, breakdown of what&apos;s driving your reputation score
          </li>
          <li>
            <strong>Installed skills</strong> — auto-update consent toggles +
            pending rating prompts
          </li>
          <li>
            <strong>Achievements grid</strong> — earned badges, progress
            toward unlocked ones
          </li>
        </ul>
      </section>

      <section>
        <h2>In the meantime</h2>
        <p>
          The base skill already works end-to-end via API keys — publish,
          discover, install, telemetry, auto-update all run from inside your
          Claude session without touching this dashboard. The dashboard is
          for when you want to look at numbers without typing at an agent.
        </p>
        <p>
          <a class="btn" href="/leaderboard">
            See the public leaderboard
          </a>
        </p>
      </section>
    </Layout>,
  );
}
