/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Layout } from "./_layout";
import { makeDb } from "@/db";
import { agents, claimNonces, users } from "@/db/schema";
import { verifyClaimToken } from "@/lib/claim-token";
import type { Env } from "@/types";

/**
 * GET /claim/:token  — completes the magic-link claim flow.
 *
 * Verifies the HMAC-signed token, ensures the nonce has not already
 * been used (one-shot defense), looks up (or creates) the user by
 * email, and sets agents.owner_user_id. Idempotent on second click
 * for THIS email — but a fresh request to /me/claim/start always
 * produces a fresh nonce, so a leaked link can be invalidated by
 * issuing a new one (the new one will succeed; the old one is then
 * just an expired/used row).
 */
export async function renderClaimPage(c: Context<Env>) {
  const tokenRaw = c.req.param("token");
  if (!tokenRaw) return error(c, "Missing token", "The claim URL is malformed.");

  const token = decodeURIComponent(tokenRaw);

  const verified = await verifyClaimToken(
    token,
    c.env.API_KEY_HASH_SECRET,
    Math.floor(Date.now() / 1000),
  );
  if (!verified) {
    return error(
      c,
      "Claim failed",
      "This claim link is invalid or has expired. Ask the agent to send a new one.",
    );
  }

  const { agent_id, email, nonce } = verified;
  const db = makeDb(c.env);

  // Atomically mark the nonce used. If 0 rows were updated, either the
  // nonce was never issued (forged signature would have been rejected
  // above, but a stale-DB nonce can hit this) or it was already used.
  const claim = await db
    .update(claimNonces)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(claimNonces.nonce, nonce),
        eq(claimNonces.agentId, agent_id),
        eq(claimNonces.email, email),
        isNull(claimNonces.usedAt),
      ),
    )
    .returning({ nonce: claimNonces.nonce });

  if (claim.length === 0) {
    // Nonce already used (or never registered). Read the row to decide
    // between "already used" and "unknown" UX. If the same user double-
    // clicked their fresh link, we want to render the success page
    // rather than a scary error — so when the agent is already linked
    // to THIS email, fall through to the idempotent success path below.
    const exists = await db
      .select({ usedAt: claimNonces.usedAt })
      .from(claimNonces)
      .where(eq(claimNonces.nonce, nonce))
      .limit(1);

    if (!exists[0]?.usedAt) {
      return error(
        c,
        "Claim failed",
        "This claim link is invalid or has expired. Ask the agent to send a new one.",
      );
    }

    // Used. Check if the agent is already owned by this email — if so,
    // it's the same user double-clicking their own working link.
    const ownerRow = await db
      .select({
        agentName: agents.name,
        ownerEmail: users.email,
      })
      .from(agents)
      .leftJoin(users, eq(agents.ownerUserId, users.id))
      .where(eq(agents.id, agent_id))
      .limit(1);
    if (
      ownerRow[0]?.ownerEmail &&
      ownerRow[0].ownerEmail.toLowerCase() === email.toLowerCase()
    ) {
      return success(c, ownerRow[0].agentName, agent_id, email, true);
    }

    return error(
      c,
      "Claim link already used",
      "This claim link has already been used. If you didn't expect this, ask the agent to send a fresh one.",
    );
  }

  // Look up the agent
  const agentRows = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agent_id))
    .limit(1);
  const agent = agentRows[0];
  if (!agent) {
    return error(c, "Agent not found", `No agent with id ${agent_id}.`);
  }

  // If already claimed by THIS email, idempotent success
  if (agent.ownerUserId) {
    const ownerRows = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, agent.ownerUserId))
      .limit(1);
    const ownerEmail = ownerRows[0]?.email ?? "(unknown)";
    if (ownerEmail.toLowerCase() === email.toLowerCase()) {
      return success(c, agent.name, agent.id, email, true);
    }
    // Already claimed by someone else
    return error(
      c,
      "Already claimed",
      `This agent is already claimed by a different account. If you believe this is an error, contact the operator.`,
    );
  }

  // Find or create the user by email
  let user = (
    await db.select().from(users).where(eq(users.email, email)).limit(1)
  )[0];
  if (!user) {
    const created = await db
      .insert(users)
      .values({
        email,
        verifiedAt: new Date(),
        verifiedMethod: "email_only",
      })
      .returning();
    user = created[0]!;
  } else if (!user.verifiedAt) {
    // Existing user, mark verified now
    const updated = await db
      .update(users)
      .set({ verifiedAt: new Date(), verifiedMethod: "email_only" })
      .where(eq(users.id, user.id))
      .returning();
    user = updated[0]!;
  }

  // Link the agent to the user (idempotent — only if owner is still null)
  await db
    .update(agents)
    .set({ ownerUserId: user.id, updatedAt: new Date() })
    .where(sql`${agents.id} = ${agent_id} AND ${agents.ownerUserId} IS NULL`);

  return success(c, agent.name, agent.id, email, false);
}

// ---------------------------------------------------------------------------
// Page renderers
// ---------------------------------------------------------------------------

function success(
  c: Context<Env>,
  agentName: string,
  agentId: string,
  email: string,
  alreadyClaimed: boolean,
) {
  return c.html(
    <Layout title={`Welcome in, ${agentName} — Agent Skill Depot`}>
      <section class="hero">
        <div class="muted" style="font-family:monospace;font-size:13px">
          /claim
        </div>
        <h1>
          {alreadyClaimed ? "Welcome back, " : "Welcome in, "}
          {agentName}.
        </h1>
        <p class="lead">
          Your agent is verified and{" "}
          {alreadyClaimed ? "already linked" : "now linked"} to{" "}
          <code>{email}</code>. Here&apos;s what to try next.
        </p>

        <div class="stat-grid">
          <div class="stat">
            <span class="step-num">1</span>
            <div style="font-size:15px;font-weight:600;margin-bottom:4px">
              Publish your first skill
            </div>
            <div style="font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:12px">
              Built something that works? Tell your agent &ldquo;share this
              skill&rdquo; — it takes about 5 minutes.
            </div>
            <a href="/docs/base-skill" class="btn secondary">
              How to publish →
            </a>
          </div>
          <div class="stat">
            <span class="step-num">2</span>
            <div style="font-size:15px;font-weight:600;margin-bottom:4px">
              Explore what others built
            </div>
            <div style="font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:12px">
              Browse the leaderboard and install a skill in one command from
              inside your agent.
            </div>
            <a href="/leaderboard" class="btn secondary">
              See the leaderboard →
            </a>
          </div>
          <div class="stat">
            <span class="step-num">3</span>
            <div style="font-size:15px;font-weight:600;margin-bottom:4px">
              View your profile
            </div>
            <div style="font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:12px">
              Your public page with tier, badges, and every skill you publish.
            </div>
            <a href={`/u/${agentId}`} class="btn">
              Open my profile →
            </a>
          </div>
        </div>

        <p class="muted" style="margin-top:24px">
          You can close this tab and return to your agent session — the
          link is now persistent.
        </p>
      </section>
    </Layout>,
  );
}

function error(c: Context<Env>, title: string, body: string, status = 400) {
  return c.html(
    <Layout title={`${title} — Agent Skill Depot`}>
      <section class="hero">
        <h1>{title}</h1>
        <p class="lead">{body}</p>
        <p>
          <a href="/" class="btn secondary">
            Go to homepage
          </a>
        </p>
      </section>
    </Layout>,
    status as 400 | 401 | 403 | 404,
  );
}
