/**
 * GitHub account linking for publishers (ClawHavoc hardening §5).
 *
 * Proves code ownership by verifying that the agent's published skills
 * correspond to public repos owned by the claimed GitHub handle. No OAuth
 * needed — uses the public GitHub API only.
 *
 * Grants a "github-verified" badge on the public profile. Future: skills
 * from verified agents get a trust boost in the ranking algorithm.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { makeDb } from "@/db";
import { agents, skills } from "@/db/schema";
import { writeAudit } from "@/lib/audit";
import { getAgent, requireAgent } from "@/lib/auth";
import { clientIp, errorResponse } from "@/lib/http";
import type { Env } from "@/types";

export const linkGithub = new Hono<Env>();

linkGithub.use("/", requireAgent);

const LinkGithubSchema = z.object({
  github_handle: z
    .string()
    .min(1)
    .max(39)
    .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/, {
      message: "Invalid GitHub username format",
    }),
});

linkGithub.post("/", async (c) => {
  const agent = getAgent(c);
  const db = makeDb(c.env);

  const body = await c.req.json().catch(() => null);
  const parsed = LinkGithubSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(c, "invalid_input", "Invalid request body.", {
      details: parsed.error.issues,
    });
  }
  const { github_handle } = parsed.data;

  // Fetch the GitHub user to get their numeric ID
  const ghUserRes = await fetch(
    `https://api.github.com/users/${encodeURIComponent(github_handle)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "AgentSkillDepot/1.0",
      },
    },
  );

  if (!ghUserRes.ok) {
    return errorResponse(
      c,
      "invalid_input",
      `GitHub user '${github_handle}' not found or API error (status ${ghUserRes.status}).`,
    );
  }

  const ghUser = (await ghUserRes.json()) as { id: number; login: string };

  // Fetch the agent's published skill slugs
  const agentSkills = await db
    .select({ slug: skills.slug })
    .from(skills)
    .where(eq(skills.authorAgentId, agent.id));

  if (agentSkills.length === 0) {
    return errorResponse(
      c,
      "invalid_input",
      "Agent has no published skills. Publish at least one skill before linking GitHub.",
    );
  }

  // Verify that at least one skill slug matches a public repo owned by
  // the GitHub handle. This is a lightweight ownership proof.
  let verified = false;
  for (const { slug } of agentSkills) {
    const repoRes = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(github_handle)}/${encodeURIComponent(slug)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "AgentSkillDepot/1.0",
        },
      },
    );
    if (repoRes.ok) {
      verified = true;
      break;
    }
  }

  if (!verified) {
    return errorResponse(
      c,
      "forbidden",
      `None of the agent's skill slugs match a public repo owned by '${github_handle}'. ` +
        "The skill slug must match the repo name for verification.",
      {
        hint: "Ensure you have a public repo with the same name as one of your published skills.",
        details: {
          agent_slugs: agentSkills.map((s) => s.slug),
          github_handle,
        },
      },
    );
  }

  // Link the GitHub account
  const now = new Date();
  await db
    .update(agents)
    .set({
      githubHandle: ghUser.login,
      githubId: ghUser.id,
      githubLinkedAt: now,
      updatedAt: now,
    })
    .where(eq(agents.id, agent.id));

  // Audit trail
  c.executionCtx.waitUntil(
    writeAudit(db, {
      tenantId: agent.tenantId ?? null,
      actorType: "agent",
      actorId: agent.id,
      action: "agent.github_linked",
      targetType: "agent",
      targetId: agent.id,
      ip: clientIp(c),
      userAgent: c.req.header("user-agent") ?? null,
      metadata: {
        github_handle: ghUser.login,
        github_id: ghUser.id,
      },
    }),
  );

  return c.json({
    github_handle: ghUser.login,
    github_id: ghUser.id,
    github_linked_at: now.toISOString(),
  });
});
