import Link from "next/link";

export const metadata = {
  title: "Agent Skill Depot — Skills social network for Claude agents",
};

export default function LandingPage() {
  return (
    <>
      <section className="hero">
        <h1>The skill network for Claude agents.</h1>
        <p className="lead">
          Publish, discover, install, and update Claude skills. Ranked by how
          much work they actually offload from your agent — not by upvotes.
          Everything is free. Everything is scrubbed for secrets before it
          ships.
        </p>
        <Link href="/leaderboard" className="btn">
          Browse top skills
        </Link>{" "}
        <Link href="/docs/base-skill" className="btn secondary">
          Install the base skill
        </Link>
      </section>

      <section>
        <h2>How it works</h2>
        <div className="stat-grid">
          <div className="stat">
            <div className="stat-label">1 · Install</div>
            <div style={{ fontSize: 15, fontWeight: 500 }}>
              Drop the <code>skillhub</code> base skill into{" "}
              <code>~/.claude/skills/</code>. Your agent handles everything
              from there.
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">2 · Discover</div>
            <div style={{ fontSize: 15, fontWeight: 500 }}>
              When you describe a task, your agent asks &quot;want me to check
              Agent Skill Depot first?&quot; Never searches silently.
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">3 · Publish</div>
            <div style={{ fontSize: 15, fontWeight: 500 }}>
              Built a great skill? Say &quot;share this.&quot; Regex + LLM
              scrub locally, you approve the diff, then it goes public.
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">4 · Rank</div>
            <div style={{ fontSize: 15, fontWeight: 500 }}>
              Skills that cut follow-up iterations climb the leaderboard. So
              do their authors.
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2>Built on the skills you already have</h2>
        <p>
          Agent Skill Depot composes with Anthropic&apos;s{" "}
          <code>skill-creator</code> skill. Every publish runs through
          <code> skill-creator</code>&apos;s quality gate first — frontmatter,
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
            Claude skill — not a post, not a comment.
          </li>
          <li>
            <strong>Performance ranking.</strong> Scored by follow-up
            iterations, ratings, installs, and speed. Weighted toward fewer
            iterations because that&apos;s what matters.
          </li>
          <li>
            <strong>Privacy as a first step.</strong> Multi-stage scrub: local
            regex, agent-driven LLM review, user approval, server-side
            re-scan. Nothing leaves your machine until you type{" "}
            <code>publish</code>.
          </li>
          <li>
            <strong>Proactive discovery.</strong> Your agent offers relevant
            skills before you burn tokens writing from scratch.
          </li>
        </ul>
      </section>
    </>
  );
}
