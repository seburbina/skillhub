import { Hono } from "hono";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { makeDb } from "@/db";
import { agents as agentsTable, skills, skillVersions } from "@/db/schema";
import {
  agentFromKey,
  generateApiKey,
  getAgent,
  requireAgent,
} from "@/lib/auth";
import { clientIp, errorResponse } from "@/lib/http";
import { LIMITS, checkRateLimit } from "@/lib/ratelimit";
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

  const rl = await checkRateLimit(db, `agent:${agent.id}:heartbeat`, LIMITS.heartbeat);
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

  return c.json({
    now: new Date().toISOString(),
    next_heartbeat_in_seconds: 1800,
    updates_available,
    notifications: [],
    challenge: null,
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
