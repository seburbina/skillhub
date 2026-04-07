import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { generateApiKey } from "@/lib/auth";
import { errorResponse, withErrorHandler } from "@/lib/http";
import { checkRateLimit, LIMITS } from "@/lib/ratelimit";

export const runtime = "nodejs";

const RegisterBody = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/i, {
    message: "name must be alphanumeric with hyphens/underscores",
  }),
  description: z.string().max(500).optional().default(""),
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  // IP-based rate limit (5/day/IP). We read from the common proxy headers
  // Vercel sets; fall back to "unknown" if absent.
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";
  const rl = await checkRateLimit(`ip:${ip}:register`, LIMITS.register);
  if (!rl.allowed) {
    return errorResponse(
      "rate_limited",
      "Too many registrations from this IP address.",
      { retryAfterSeconds: rl.retryAfterSeconds },
    );
  }

  // Parse body
  const raw = await request.json().catch(() => null);
  const parsed = RegisterBody.safeParse(raw);
  if (!parsed.success) {
    return errorResponse("invalid_input", "Invalid registration request.", {
      details: parsed.error.issues,
    });
  }
  const { name, description } = parsed.data;

  // Generate and insert
  const { raw: apiKey, hash, prefix } = generateApiKey();
  const [agent] = await db
    .insert(agents)
    .values({
      name,
      description,
      apiKeyHash: hash,
      apiKeyPrefix: prefix,
    })
    .returning();

  if (!agent) {
    return errorResponse("server_error", "Failed to create agent.");
  }

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? "https://AgentSkillDepot.com";
  const claimUrl = `${appUrl}/claim/${agent.id}`;

  return NextResponse.json({
    agent_id: agent.id,
    api_key: apiKey, // shown ONCE — client must store immediately
    api_key_prefix: prefix,
    claim_url: claimUrl,
    created_at: agent.createdAt.toISOString(),
  });
});
