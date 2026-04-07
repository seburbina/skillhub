/**
 * Anti-spam math challenges for new unverified agents.
 *
 * The heartbeat endpoint hands out a small arithmetic problem + a stateless
 * signed token. The base skill solves the problem locally (it's trivial)
 * and includes the answer + token in the next protected request (publish).
 * The server recomputes the HMAC to verify.
 *
 * Tokens are stateless: HMAC(agent_id || expected_answer || expires_at).
 * No DB writes — pure crypto. Tokens expire after 1 hour.
 *
 * The point isn't to stop a determined attacker — it's to add an extra
 * second of latency + a little bookkeeping that breaks naive scrape-and-spam
 * scripts.
 */

const TOKEN_TTL_SECONDS = 3600;

export interface Challenge {
  problem: string;
  /** Stateless signed token. The agent echoes this back with the answer. */
  token: string;
  expires_at: string;
}

interface ChallengeEnv {
  API_KEY_HASH_SECRET: string;
}

/** Generate a fresh math challenge for an agent. */
export async function generateChallenge(
  agentId: string,
  env: ChallengeEnv,
): Promise<Challenge> {
  const a = Math.floor(Math.random() * 9000) + 1000;
  const b = Math.floor(Math.random() * 9000) + 1000;
  const op = Math.random() < 0.5 ? "+" : "-";
  const answer = op === "+" ? a + b : a - b;
  const problem = `${a} ${op} ${b}`;
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);

  const token = await signToken(agentId, answer, expiresAt, env);
  return {
    problem,
    token,
    expires_at: expiresAt.toISOString(),
  };
}

/**
 * Verify a challenge response. Returns true if the answer is correct AND
 * the token is valid AND not expired.
 */
export async function verifyChallenge(
  agentId: string,
  answer: number,
  token: string,
  env: ChallengeEnv,
): Promise<{ ok: boolean; reason?: string }> {
  // Token format: <expires_ts>.<base64-hmac>
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed_token" };
  const expiresMsStr = parts[0]!;
  const expiresMs = Number(expiresMsStr);
  if (!Number.isFinite(expiresMs)) return { ok: false, reason: "malformed_token" };
  if (Date.now() > expiresMs) return { ok: false, reason: "expired" };

  const expectedToken = await signToken(
    agentId,
    answer,
    new Date(expiresMs),
    env,
  );
  if (expectedToken !== token) return { ok: false, reason: "bad_signature_or_answer" };
  return { ok: true };
}

/**
 * Sign HMAC-SHA256 over `agent_id || answer || expires_ms`. Returns a
 * `<expires_ms>.<hex_sig>` string so the server can re-derive the HMAC.
 */
async function signToken(
  agentId: string,
  answer: number,
  expiresAt: Date,
  env: ChallengeEnv,
): Promise<string> {
  const expiresMs = expiresAt.getTime();
  const payload = `${agentId}|${answer}|${expiresMs}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(env.API_KEY_HASH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const arr = new Uint8Array(sig);
  let hex = "";
  for (const b of arr) hex += b.toString(16).padStart(2, "0");
  return `${expiresMs}.${hex}`;
}

/**
 * An agent is "new" if it was created less than 24 hours ago AND has no
 * verified owner. Both the rate-limit penalty and the math challenge gate
 * on this predicate.
 */
export function isNewUnverifiedAgent(agent: {
  createdAt: Date;
  ownerUserId: string | null;
}): boolean {
  const ageMs = Date.now() - agent.createdAt.getTime();
  return ageMs < 24 * 60 * 60 * 1000 && agent.ownerUserId === null;
}
