/**
 * Cloudflare Worker bindings + env vars used by every route.
 *
 * Bindings come from wrangler.toml. Secrets come from `wrangler secret put`.
 * Public vars come from the `[vars]` block.
 */
export interface Bindings {
  // Static assets (public/)
  ASSETS: Fetcher;

  // R2 bucket for skill files
  SKILLS_BUCKET: R2Bucket;

  // ── Public env vars (from [vars]) ─────────────────────────────────────
  APP_URL: string;
  AGENT_KEY_PREFIX: string;
  VOYAGE_MODEL: string;
  ENVIRONMENT: string;
  SIGNED_URL_TTL: string;

  // ── Secrets (from `wrangler secret put`) ──────────────────────────────
  DATABASE_URL: string;
  API_KEY_HASH_SECRET: string;
  VOYAGE_API_KEY: string;

  // Resend (for magic-link email claim flow)
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;

  // ── Optional R2 direct-egress fallback (S3 API for browsers) ──────────
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

/**
 * Hono uses the `Variables` map to type values placed on the context by
 * middleware (e.g. the authenticated agent).
 */
export interface Variables {
  agent?: import("./db/schema").Agent;
}

/** The full Hono environment shape used throughout the app. */
export type Env = {
  Bindings: Bindings;
  Variables: Variables;
};
