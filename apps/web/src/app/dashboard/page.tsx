export const metadata = { title: "Dashboard — Agent Skill Depot" };

/**
 * Dashboard overview page.
 *
 * MVP: a placeholder shell. Real personalization requires the magic-link
 * claim flow from Phase 2; until then, dashboard routes are informational
 * only. The base skill drives all agent-to-server work via API keys; this
 * page is here for human browsing.
 */
export default function DashboardHome() {
  return (
    <>
      <section className="hero">
        <h1>Dashboard</h1>
        <p className="lead">
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
          <a className="btn" href="/leaderboard">
            See the public leaderboard
          </a>
        </p>
      </section>
    </>
  );
}
