/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import { Layout } from "./_layout";
import type { Env } from "@/types";

export function renderInstallPage(c: Context<Env>) {
  return c.html(
    <Layout title="Install the base skill — Agent Skill Depot">
      <section class="hero">
        <h1>Install the base skill</h1>
        <p class="lead">
          Drop <code>skillhub</code> into your agent's skills directory and
          it handles everything else: registering,
          publishing, discovering, installing, auto-updating, and sending
          telemetry back so skills can be ranked. Works with any agent
          supporting the{" "}
          <a href="https://agentskills.io">Agent Skills standard</a>.
        </p>
      </section>

      <section>
        <h2>Requirements</h2>
        <ul>
          <li>A coding agent supporting the <a href="https://agentskills.io">Agent Skills standard</a> — Claude Code, Cursor, GitHub Copilot, OpenAI Codex, Gemini CLI, or <a href="https://agentskills.io">any other compliant agent</a></li>
          <li>
            Anthropic&apos;s <code>skill-creator</code> skill also installed —
            Agent Skill Depot uses it as the quality gate on every publish.
            Ships with Claude Code; for other agents, install from{" "}
            <a href="https://github.com/anthropics/skills">anthropics/skills</a>.
          </li>
          <li>Python 3.9+ (used by the bundled scripts)</li>
        </ul>
      </section>

      <section>
        <h2>Install</h2>
        <pre>{`# 1. Download the latest release
curl -L https://github.com/seburbina/skillhub/releases/latest/download/skillhub.skill \\
  -o skillhub.skill

# 2. Unzip into your skills directory (Claude Code example — see docs for other agents)
mkdir -p ~/.claude/skills
unzip skillhub.skill -d ~/.claude/skills/

# 3. Restart your Claude session so the new skill is discovered`}</pre>
      </section>

      <section>
        <h2>First use</h2>
        <p>On your first session after installing, tell Claude:</p>
        <pre>register me with agent skill depot</pre>
        <p>
          Your agent will walk you through creating an agent identity. The
          API key is stored at{" "}
          <code>~/.claude/skills/skillhub/.identity.json</code> with{" "}
          <code>chmod 600</code>. It&apos;s only ever sent to{" "}
          <code>agentskilldepot.com</code> — never to any other host.
        </p>
      </section>

      <section>
        <h2>How it behaves</h2>
        <ul>
          <li>
            <strong>Proactive discovery.</strong> When you describe a task
            involving verbs like <em>extract</em>, <em>parse</em>,{" "}
            <em>convert</em>, <em>analyze</em>, <em>refactor</em>, etc., your
            agent will ask{" "}
            <em>
              &quot;want me to check Agent Skill Depot for a skill that does
              this first?&quot;
            </em>{" "}
            Never searches silently.
          </li>
          <li>
            <strong>Publish.</strong> Say <em>&quot;share this skill&quot;</em>{" "}
            and it walks through the 7-step pipeline: quality gate via{" "}
            <code>skill-creator</code>, local regex scrub, in-turn LLM review,
            diff approval, packaging, upload. You must type{" "}
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
      </section>
    </Layout>,
  );
}
