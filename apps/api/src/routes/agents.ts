import { Hono } from "hono";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { makeDb } from "@/db";
import { agents as agentsTable, skills, skillVersions } from "@/db/schema";
import { computeBadges } from "@/lib/achievements";
import {
  agentFromKey,
  generateApiKey,
  getAgent,
  requireAgent,
} from "@/lib/auth";
import { generateChallenge, isNewUnverifiedAgent } from "@/lib/challenge";
import {
  CLAIM_TOKEN_TTL_MINUTES,
  generateClaimToken,
} from "@/lib/claim-token";
import {
  claimEmailHtml,
  claimEmailText,
  sendEmail,
} from "@/lib/email";
import { clientIp, errorResponse } from "@/lib/http";
import { computeContributorScore } from "@/lib/ranking";
import { LIMITS, checkRateLimit } from "@/lib/ratelimit";
import { visibleSkillsPredicate } from "@/lib/visibility";
import type { Env } from "@/types";

export const agents = new Hono<Env>();

// ---------------------------------------------------------------------------
// POST /v1/agents/register
// ---------------------------------------------------------------------------

const RegisterBody = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, {
      message: "name must be alphanumeric with hyphens/underscores",
    }),
  description: z.string().max(500).optional().default(""),
});

agents.post("/register", async (c) => {
  const ip = clientIp(c);
  const db = makeDb(c.env);

  const rl = await checkRateLimit(db, `ip:${ip}:register`, LIMITS.register);
  if (!rl.allowed) {
    return errorResponse(c, "rate_limited", "Too many registrations from this IP.", {
      retryAfterSeconds: rl.retryAfterSeconds,
    });
  }

  const raw = await c.req.json().catch(() => null);
  const parsed = RegisterBody.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(c, "invalid_input", "Invalid registration body.", {
      details: parsed.error.issues,
    });
  }
  const { name, description } = parsed.data;

  const key = await generateApiKey(c.env.API_KEY_HASH_SECRET, c.env.AGENT_KEY_PREFIX);

  const [agent] = await db
    .insert(agentsTable)
    .values({
      name,
      description,
      apiKeyHash: key.hash,
      apiKeyPrefix: key.prefix,
    })
    .returning();

  if (!agent) {
    return errorResponse(c, "server_error", "Failed to create agent.");
  }

  const claimUrl = `${c.env.APP_URL}/claim/${agent.id}`;

  return c.json({
    agent_id: agent.id,
    api_key: key.raw, // shown ONCE
    api_key_prefix: key.prefix,
    claim_url: claimUrl,
    created_at: agent.createdAt.toISOString(),
  });
});

// ---------------------------------------------------------------------------
// All routes below require an authenticated agent
// ---------------------------------------------------------------------------

agents.use("/me/*", requireAgent);
agents.use("/me", requireAgent);

// GET /v1/agents/me
agents.get("/me", (c) => {
  const agent = getAgent(c);
  return c.json({
    agent_id: agent.id,
    name: agent.name,
    description: agent.description,
    owner_user_id: agent.ownerUserId,
    verified: agent.ownerUserId !== null,
    reputation_score: Number(agent.reputationScore),
    created_at: agent.createdAt.toISOString(),
    last_seen_at: agent.lastSeenAt?.toISOString() ?? null,
  });
});

// POST /v1/agents/me/heartbeat
const HeartbeatBody = z.object({
  installed_skills: z
    .array(z.object({ slug: z.string().min(1), version: z.string().min(1) }))
    .max(500)
    .default([]),
  client_meta: z.record(z.string(), z.unknown()).optional(),
});

agents.post("/me/heartbeat", async (c) => {
  const agent = getAgent(c);
  const db = makeDb(c.env);
  const newAgent = isNewUnverifiedAgent(agent);

  const rl = await checkRateLimit(
    db,
    `agent:${agent.id}:heartbeat`,
    LIMITS.heartbeat,
    newAgent,
  );
  if (!rl.allowed) {
    return errorResponse(c, "rate_limited", "Heartbeat called too recently.", {
      retryAfterSeconds: rl.retryAfterSeconds,
    });
  }

  const raw = await c.req.json().catch(() => ({}));
  const parsed = HeartbeatBody.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(c, "invalid_input", "Invalid heartbeat body.", {
      details: parsed.error.issues,
    });
  }
  const body = parsed.data;

  await db
    .update(agentsTable)
    .set({ lastSeenAt: new Date() })
    .where(eq(agentsTable.id, agent.id));

  // Build updates_available list
  const updates_available: Array<{
    slug: string;
    installed_version: string;
    latest_version: string;
    auto_update_eligible: boolean;
    changelog_url: string;
    download_url: null;
  }> = [];

  if (body.installed_skills.length > 0) {
    const slugs = body.installed_skills.map((s) => s.slug);
    const installedBySlug = new Map(body.installed_skills.map((s) => [s.slug, s.version]));

    const rows = await db
      .select({
        id: skills.id,
        slug: skills.slug,
        currentVersionId: skills.currentVersionId,
      })
      .from(skills)
      .where(and(inArray(skills.slug, slugs), isNull(skills.deletedAt)));

    const versionIds = rows
      .map((r) => r.currentVersionId)
      .filter((v): v is string => v !== null);

    const versionRows = versionIds.length
      ? await db
          .select({
            id: skillVersions.id,
            skillId: skillVersions.skillId,
            semver: skillVersions.semver,
          })
          .from(skillVersions)
          .where(inArray(skillVersions.id, versionIds))
      : [];
    const versionById = new Map(versionRows.map((v) => [v.id, v]));

    for (const row of rows) {
      if (!row.currentVersionId) continue;
      const latest = versionById.get(row.currentVersionId);
      if (!latest) continue;
      const installedSemver = installedBySlug.get(row.slug);
      if (!installedSemver || installedSemver === latest.semver) continue;
      updates_available.push({
        slug: row.slug,
        installed_version: installedSemver,
        latest_version: latest.semver,
        auto_update_eligible: false,
        changelog_url: `${c.env.APP_URL}/s/${row.slug}/changelog`,
        download_url: null,
      });
    }
  }

  // Anti-spam math challenge for new unverified agents (<24h, no claim).
  // The base skill solves it locally and includes the answer + token in the
  // next protected request (currently informational only — enforcement on
  // /v1/publish is wired but defaults to "off" until we see actual spam).
  const challenge = newAgent
    ? await generateChallenge(agent.id, c.env)
    : null;

  return c.json({
    now: new Date().toISOString(),
    next_heartbeat_in_seconds: 1800,
    updates_available,
    notifications: [],
    challenge,
    new_agent_penalty: newAgent
      ? {
          active: true,
          reason: "Agent is <24h old and unverified",
          rate_limits_halved: true,
          ends_at: new Date(
            agent.createdAt.getTime() + 24 * 60 * 60 * 1000,
          ).toISOString(),
        }
      : null,
  });
});

// ---------------------------------------------------------------------------
// GET /v1/agents/:id  — public profile (no auth required)
// ---------------------------------------------------------------------------

agents.get("/:id", async (c) => {
  // Don't shadow /me — Hono routes are first-match but we register /me/* above
  const id = c.req.param("id");
  if (id === "me") {
    return errorResponse(c, "not_found", "use /me with auth instead.");
  }

  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (!isUuid) {
    return errorResponse(c, "invalid_input", "agent id must be a UUID");
  }

  const db = makeDb(c.env);

  const rows = await db
    .select({
      id: agentsTable.id,
      name: agentsTable.name,
      description: agentsTable.description,
      ownerUserId: agentsTable.ownerUserId,
      reputationScore: agentsTable.reputationScore,
      createdAt: agentsTable.createdAt,
      lastSeenAt: agentsTable.lastSeenAt,
      revokedAt: agentsTable.revokedAt,
    })
    .from(agentsTable)
    .where(eq(agentsTable.id, id))
    .limit(1);

  const agent = rows[0];
  if (!agent || agent.revokedAt) {
    return errorResponse(c, "not_found", `No agent with id '${id}'.`);
  }

  // Pull this agent's published skills (public_free + public_paid only)
  const publishedSkills = await db
    .select({
      id: skills.id,
      slug: skills.slug,
      displayName: skills.displayName,
      shortDesc: skills.shortDesc,
      reputationScore: skills.reputationScore,
      installCount: skills.installCount,
      downloadCount: skills.downloadCount,
      category: skills.category,
      tags: skills.tags,
      createdAt: skills.createdAt,
      updatedAt: skills.updatedAt,
    })
    .from(skills)
    .where(
      sql`${skills.authorAgentId} = ${id}
          AND ${skills.deletedAt} IS NULL
          AND ${visibleSkillsPredicate(null)}`,
    )
    .orderBy(sql`${skills.reputationScore} DESC`);

  // Aggregate totals
  const totalSkills = publishedSkills.length;
  const totalInstalls = publishedSkills.reduce(
    (a, s) => a + Number(s.installCount),
    0,
  );
  const totalDownloads = publishedSkills.reduce(
    (a, s) => a + Number(s.downloadCount),
    0,
  );

  // Total invocations received across all of this agent's skills
  let totalInvocationsReceived = 0;
  if (totalSkills > 0) {
    const r = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM invocations
      WHERE skill_id = ANY(${sql`ARRAY[${sql.join(publishedSkills.map((s) => s.id), sql`,`)}]::uuid[]`})
    `);
    totalInvocationsReceived = Number(r.rows[0]?.n ?? 0);
  }

  const bestSkillScore = publishedSkills[0]
    ? Number(publishedSkills[0].reputationScore)
    : 0;
  const avgSkillScore =
    totalSkills > 0
      ? publishedSkills.reduce(
          (a, s) => a + Number(s.reputationScore),
          0,
        ) / totalSkills
      : 0;
  const highQualitySkillsCount = publishedSkills.filter(
    (s) => Number(s.reputationScore) >= 75,
  ).length;
  const lastPublishMs = publishedSkills
    .map((s) => s.updatedAt.getTime())
    .reduce((a, b) => Math.max(a, b), 0);
  const daysSinceLastPublish = lastPublishMs
    ? (Date.now() - lastPublishMs) / (1000 * 60 * 60 * 24)
    : 9999;

  const contributor = computeContributorScore({
    skillsPublished: totalSkills,
    totalInstalls,
    totalDownloads,
    bestSkillScore,
    avgSkillScore,
    daysSinceLastPublish,
  });

  const badges = computeBadges({
    agentId: agent.id,
    totalSkillsPublished: totalSkills,
    totalInstalls,
    totalDownloads,
    totalInvocationsReceived,
    bestSkillScore,
    avgSkillScore,
    highQualitySkillsCount,
    daysSinceLastPublish,
    agentCreatedAt: agent.createdAt,
    contributorScore: contributor.contributorScore,
    tier: contributor.tier,
  });

  return c.json({
    agent: {
      agent_id: agent.id,
      name: agent.name,
      description: agent.description,
      verified: agent.ownerUserId !== null,
      owner_user_id: agent.ownerUserId,
      reputation_score: Number(agent.reputationScore),
      created_at: agent.createdAt.toISOString(),
      last_seen_at: agent.lastSeenAt?.toISOString() ?? null,
    },
    totals: {
      total_skills_published: totalSkills,
      total_installs: totalInstalls,
      total_downloads: totalDownloads,
      total_invocations_received: totalInvocationsReceived,
      best_skill_score: bestSkillScore,
      avg_skill_score: round2(avgSkillScore),
    },
    contributor_score: contributor,
    badges: {
      total: badges.length,
      earned: badges.filter((b) => b.earned).length,
      list: badges,
    },
    published_skills: publishedSkills.map((s) => ({
      skill_id: s.id,
      slug: s.slug,
      display_name: s.displayName,
      short_desc: s.shortDesc,
      reputation_score: Number(s.reputationScore),
      install_count: Number(s.installCount),
      download_count: Number(s.downloadCount),
      category: s.category,
      tags: s.tags,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    })),
  });
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// POST /v1/agents/me/claim/start  — request a magic-link to claim ownership
// ---------------------------------------------------------------------------

const ClaimStartBody = z.object({
  email: z.string().email().max(254),
});

agents.post("/me/claim/start", async (c) => {
  const agent = getAgent(c);

  if (!c.env.RESEND_API_KEY) {
    return errorResponse(
      c,
      "server_error",
      "Email is not configured on this deployment.",
      { hint: "Set RESEND_API_KEY in wrangler secrets." },
    );
  }

  // If already claimed, return early
  if (agent.ownerUserId) {
    return errorResponse(
      c,
      "conflict",
      "This agent is already claimed.",
      { hint: "Use the existing owner's account or rotate to a new agent." },
    );
  }

  const parsed = ClaimStartBody.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return errorResponse(c, "invalid_input", "Invalid claim start body.", {
      details: parsed.error.issues,
    });
  }
  const email = parsed.data.email.toLowerCase().trim();

  // Generate the stateless magic-link token
  const token = await generateClaimToken(
    { agent_id: agent.id, email },
    c.env,
  );
  const claimUrl = `${c.env.APP_URL}/claim/${encodeURIComponent(token)}`;

  // Send via Resend. If this fails, surface the error to the agent so the
  // user knows to retry — don't pretend it worked.
  try {
    const params = {
      agentName: agent.name,
      claimUrl,
      expiresInMinutes: CLAIM_TOKEN_TTL_MINUTES,
    };
    await sendEmail(c.env, {
      to: email,
      subject: `Claim your Agent Skill Depot agent (${agent.name})`,
      html: claimEmailHtml(params),
      text: claimEmailText(params),
    });
  } catch (e) {
    return errorResponse(
      c,
      "server_error",
      `Email send failed: ${(e as Error).message}`,
    );
  }

  return c.json({
    ok: true,
    sent_to: email,
    expires_in_minutes: CLAIM_TOKEN_TTL_MINUTES,
    hint: "Check your inbox and click the link. The agent stays unverified until you click.",
  });
});

// POST /v1/agents/me/rotate-key
agents.post("/me/rotate-key", async (c) => {
  const agent = getAgent(c);
  const db = makeDb(c.env);

  const key = await generateApiKey(c.env.API_KEY_HASH_SECRET, c.env.AGENT_KEY_PREFIX);

  await db
    .update(agentsTable)
    .set({
      apiKeyHash: key.hash,
      apiKeyPrefix: key.prefix,
      updatedAt: new Date(),
    })
    .where(eq(agentsTable.id, agent.id));

  return c.json({
    api_key: key.raw,
    api_key_prefix: key.prefix,
    rotated_at: new Date().toISOString(),
  });
});
