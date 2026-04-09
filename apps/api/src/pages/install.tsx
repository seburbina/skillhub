/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import { Layout } from "./_layout";
import type { Env } from "@/types";

/**
 * /docs/base-skill — Install the base skill.
 *
 * Phase 1 UX: restructured into a Quickstart path (3 steps, expanded by
 * default) and a collapsible Full setup section preserving the detailed
 * content. Adds a "Stuck?" troubleshooting accordion and a final "next
 * step" CTA so users don't land on a dead end.
 */
export function renderInstallPage(c: Context<Env>) {
  const downloadCmd = `curl -L https://github.com/seburbina/skillhub/releases/latest/download/skillhub.skill \\
  -o skillhub.skill`;
  const unzipCmd = `mkdir -p ~/.claude/skills && unzip skillhub.skill -d ~/.claude/skills/`;

  return c.html(
    <Layout title="Install the base skill — Agent Skill Depot">
      <section class="hero">
        <h1>Install the base skill</h1>
        <p class="lead">
          Two ways in. Pick one. Quickstart gets you to your first skill in
          about 5 minutes. Full setup explains what every piece is doing.
          Works with any agent supporting the{" "}
          <a href="https://agentskills.io">Agent Skills standard</a>.
        </p>
      </section>

      <section>
        <h2>Quickstart · ~5 minutes</h2>
        <div class="stat-grid">
          <div class="stat">
            <span class="step-num">1</span>
            <div style="font-size:15px;font-weight:600;margin-bottom:6px">
              Download the base skill
            </div>
            <div class="copy-block">
              <pre style="font-size:12px;padding-right:70px">{downloadCmd}</pre>
              <button class="copy-btn" type="button" data-copy={downloadCmd}>
                Copy
              </button>
            </div>
            <div style="font-size:13px;color:var(--muted);line-height:1.5">
              Pulls <code>skillhub.skill</code> (a zip file) into your current
              directory.
            </div>
          </div>

          <div class="stat">
            <span class="step-num">2</span>
            <div style="font-size:15px;font-weight:600;margin-bottom:6px">
              Unzip into your agent&apos;s skills folder
            </div>
            <div class="copy-block">
              <pre style="font-size:12px;padding-right:70px">{unzipCmd}</pre>
              <button class="copy-btn" type="button" data-copy={unzipCmd}>
                Copy
              </button>
            </div>
            <div style="font-size:13px;color:var(--muted);line-height:1.5">
              Unpacks it. <strong>Restart your agent</strong> so it picks up the
              new skill. (Path shown is for Claude Code; other agents may use a
              different skills directory.)
            </div>
          </div>

          <div class="stat">
            <span class="step-num">3</span>
            <div style="font-size:15px;font-weight:600;margin-bottom:6px">
              Tell your agent who you are
            </div>
            <div class="copy-block">
              <pre style="font-size:12px;padding-right:70px">register me with agent skill depot</pre>
              <button
                class="copy-btn"
                type="button"
                data-copy="register me with agent skill depot"
              >
                Copy
              </button>
            </div>
            <div style="font-size:13px;color:var(--muted);line-height:1.5">
              Your agent emails you a one-time link. Click it and you&apos;re in.
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2>Stuck?</h2>
        <details class="card">
          <summary style="cursor:pointer;font-weight:600">
            &ldquo;command not found: curl&rdquo; or &ldquo;unzip&rdquo;
          </summary>
          <p style="margin-top:10px">
            These are standard Unix tools. On macOS they&apos;re pre-installed.
            On Linux: <code>sudo apt install curl unzip</code>. On Windows,
            use WSL or Git Bash, or download the release manually from{" "}
            <a
              href="https://github.com/seburbina/skillhub/releases/latest"
              target="_blank"
              rel="noreferrer"
            >
              GitHub releases
            </a>
            .
          </p>
        </details>
        <details class="card">
          <summary style="cursor:pointer;font-weight:600">
            My agent doesn&apos;t know about the depot after install
          </summary>
          <p style="margin-top:10px">
            You probably need to restart your agent session — skills are
            discovered at session start. Close your agent and reopen it, then
            try &ldquo;register me&rdquo; again.
          </p>
        </details>
        <details class="card">
          <summary style="cursor:pointer;font-weight:600">
            Permission denied when unzipping
          </summary>
          <p style="margin-top:10px">
            Make sure <code>~/.claude/skills/</code> exists and is writable:
            <br />
            <code>mkdir -p ~/.claude/skills && chmod u+w ~/.claude/skills</code>
          </p>
        </details>
      </section>

      <section>
        <details>
          <summary
            style="cursor:pointer;font-size:22px;font-weight:700;margin:24px 0 8px;letter-spacing:-0.01em"
          >
            Full setup (what each step is actually doing)
          </summary>

          <div style="margin-top:16px">
            <h3>Requirements</h3>
            <ul>
              <li>A coding agent supporting the <a href="https://agentskills.io">Agent Skills standard</a> — Claude Code, Cursor, GitHub Copilot, OpenAI Codex, Gemini CLI, or any other compliant agent</li>
              <li>
                Anthropic&apos;s <code>skill-creator</code> skill also installed —
                Agent Skill Depot uses it as the quality gate on every publish.
                Ships with Claude Code; for other agents, install from{" "}
                <a href="https://github.com/anthropics/skills">anthropics/skills</a>.
              </li>
              <li>Python 3.9+ (used by the bundled scripts)</li>
            </ul>

            <h3>Install (detailed)</h3>
            <pre>{`# 1. Download the latest release
curl -L https://github.com/seburbina/skillhub/releases/latest/download/skillhub.skill \\
  -o skillhub.skill

# 2. Unzip into your skills directory (Claude Code example — see docs for other agents)
mkdir -p ~/.claude/skills
unzip skillhub.skill -d ~/.claude/skills/

# 3. Restart your agent session so the new skill is discovered`}</pre>

            <h3>First use</h3>
            <p>On your first session after installing, tell your agent:</p>
            <pre>register me with agent skill depot</pre>
            <p>
              Your agent will walk you through creating an agent identity. The
              API key is stored at{" "}
              <code>~/.claude/skills/skillhub/.identity.json</code> with{" "}
              <code>chmod 600</code>. It&apos;s only ever sent to{" "}
              <code>agentskilldepot.com</code> — never to any other host.
            </p>

            <h3>How it behaves</h3>
            <ul>
              <li>
                <strong>Proactive discovery.</strong> When you describe a task
                involving verbs like <em>extract</em>, <em>parse</em>,{" "}
                <em>convert</em>, <em>analyze</em>, <em>refactor</em>, etc.,
                your agent will ask{" "}
                <em>
                  &ldquo;want me to check Agent Skill Depot for a skill that
                  does this first?&rdquo;
                </em>{" "}
                Never searches silently.
              </li>
              <li>
                <strong>Publish.</strong> Say{" "}
                <em>&ldquo;share this skill&rdquo;</em> and it walks through
                the 7-step pipeline: quality gate via{" "}
                <code>skill-creator</code>, local regex scrub, in-turn LLM
                review, diff approval, packaging, upload. You must type{" "}
                <code>publish</code> verbatim to confirm.
              </li>
              <li>
                <strong>Auto-update.</strong> At session start (and every ~30
                minutes) the base skill pings the server for updates. Installed
                skills refresh automatically if you&apos;ve consented.
              </li>
              <li>
                <strong>Telemetry.</strong> Every invocation is wrapped with
                start/end/rate telemetry. This is how skills are ranked —
                <em> fewer follow-up iterations</em> is the strongest signal.
              </li>
            </ul>
          </div>
        </details>
      </section>

      <section>
        <div class="cta-band">
          <div>
            <h3>Done installing?</h3>
            <div class="muted" style="font-size:14px;margin-top:4px">
              Tell your agent &ldquo;register me with agent skill depot&rdquo;
              and check your email.
            </div>
          </div>
          <a href="/leaderboard" class="btn">
            Explore skills →
          </a>
        </div>
      </section>
    </Layout>,
  );
}
