/**
 * Cloudflare Access JWT verification — Phase 0 §0.7.
 *
 * Verifies the `Cf-Access-Jwt-Assertion` header that Cloudflare Access
 * injects on every authenticated request. This is defense-in-depth for
 * the admin surface: even if a request somehow bypasses the Access
 * application policy (misconfiguration, routing bug, Access outage),
 * the Worker can re-verify the JWT against Access's public JWKS and
 * reject if invalid.
 *
 * Phase 0 status: **dead code**. No route imports this file yet. When
 * the admin surface grows past read-only v1 (Phase 2), we flip it on
 * with a one-line import in `src/routes/admin.ts`.
 *
 * Reference: https://developers.cloudflare.com/cloudflare-one/identity/users/validating-json/
 *
 * JWT validation rules:
 *   - alg: RS256
 *   - iss: https://<team>.cloudflareaccess.com
 *   - aud: the Access application AUD (from Zero Trust dashboard)
 *   - exp: not expired
 *   - signature verified against the JWKS endpoint
 */

export interface AccessJwtClaims {
  email: string;
  sub: string; // Cloudflare user id
  aud: string[];
  iss: string;
  iat: number;
  exp: number;
  nonce?: string;
  identity_nonce?: string;
  country?: string;
  groups?: string[];
  custom?: Record<string, unknown>;
}

export interface VerifyAccessJwtOptions {
  /**
   * Cloudflare Access team domain, e.g. "skilldepotamind".
   * Must match the `iss` claim.
   */
  teamName: string;
  /**
   * Access application AUD tag from the Zero Trust dashboard.
   * Must match the `aud` claim.
   */
  expectedAud: string;
  /** Optional clock skew tolerance in seconds. Default: 60. */
  clockSkewSeconds?: number;
}

/**
 * In-memory JWKS cache. Access rotates signing keys every ~6h; we
 * refetch on cache miss or stale (older than 1h). Per-isolate cache is
 * fine for a Worker — each cold start warms it lazily.
 */
interface JwksCacheEntry {
  keys: JsonWebKey[];
  fetchedAt: number;
}
const JWKS_CACHE = new Map<string, JwksCacheEntry>();
const JWKS_TTL_MS = 60 * 60 * 1000;

/**
 * Verify a Cloudflare Access JWT. Returns the decoded claims on
 * success, throws on any validation failure.
 */
export async function verifyAccessJwt(
  jwt: string,
  opts: VerifyAccessJwtOptions,
): Promise<AccessJwtClaims> {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT: expected 3 segments");
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = JSON.parse(base64UrlDecodeToString(headerB64)) as {
    alg?: string;
    kid?: string;
    typ?: string;
  };
  if (header.alg !== "RS256") {
    throw new Error(`Unsupported alg: ${header.alg}`);
  }
  if (!header.kid) {
    throw new Error("JWT header missing kid");
  }

  const claims = JSON.parse(
    base64UrlDecodeToString(payloadB64),
  ) as AccessJwtClaims;

  // Issuer check
  const expectedIss = `https://${opts.teamName}.cloudflareaccess.com`;
  if (claims.iss !== expectedIss) {
    throw new Error(
      `Unexpected issuer: ${claims.iss} (expected ${expectedIss})`,
    );
  }

  // Audience check — aud may be a string or array; Cloudflare emits array
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud as unknown as string];
  if (!aud.includes(opts.expectedAud)) {
    throw new Error(
      `Audience mismatch: ${JSON.stringify(aud)} does not include ${opts.expectedAud}`,
    );
  }

  // Expiration check
  const now = Math.floor(Date.now() / 1000);
  const skew = opts.clockSkewSeconds ?? 60;
  if (claims.exp + skew < now) {
    throw new Error(`JWT expired: exp=${claims.exp} now=${now}`);
  }
  if (claims.iat - skew > now) {
    throw new Error(`JWT iat in the future: iat=${claims.iat} now=${now}`);
  }

  // Signature verification
  const jwks = await fetchJwks(opts.teamName);
  const key = jwks.find((k) => (k as { kid?: string }).kid === header.kid);
  if (!key) {
    throw new Error(`No JWKS entry matches kid=${header.kid}`);
  }
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    key,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signature = base64UrlDecodeToBytes(signatureB64);
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    signature,
    signedData,
  );
  if (!ok) {
    throw new Error("JWT signature verification failed");
  }

  return claims;
}

/**
 * Convenience: verify the JWT from a Request's
 * `Cf-Access-Jwt-Assertion` header. Returns null on any failure
 * (missing, malformed, invalid). Use when you want a "maybe the user
 * is authed" check without throwing.
 */
export async function verifyAccessJwtFromRequest(
  request: Request,
  opts: VerifyAccessJwtOptions,
): Promise<AccessJwtClaims | null> {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) return null;
  try {
    return await verifyAccessJwt(jwt, opts);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JWKS fetch + cache
// ---------------------------------------------------------------------------

async function fetchJwks(teamName: string): Promise<JsonWebKey[]> {
  const url = `https://${teamName}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const cached = JWKS_CACHE.get(teamName);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
    return cached.keys;
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`JWKS fetch failed: ${res.status}`);
  }
  const body = (await res.json()) as { keys: JsonWebKey[] };
  if (!Array.isArray(body.keys)) {
    throw new Error("JWKS response malformed — missing keys array");
  }
  JWKS_CACHE.set(teamName, { keys: body.keys, fetchedAt: Date.now() });
  return body.keys;
}

// ---------------------------------------------------------------------------
// base64url codec (no padding, URL-safe alphabet)
// ---------------------------------------------------------------------------

function base64UrlDecodeToString(input: string): string {
  const bytes = base64UrlDecodeToBytes(input);
  return new TextDecoder().decode(bytes);
}

function base64UrlDecodeToBytes(input: string): Uint8Array {
  // Restore padding
  const pad = input.length % 4;
  const padded =
    input.replace(/-/g, "+").replace(/_/g, "/") +
    (pad ? "=".repeat(4 - pad) : "");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
