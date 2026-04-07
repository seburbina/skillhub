/**
 * Agent Skill Depot — Cloudflare Worker entry.
 *
 * Single Hono app that serves both the public marketing pages (HTML via JSX)
 * and the JSON API at /v1/*. Static assets (CSS, favicon) are bound via the
 * [assets] block in wrangler.toml and served under their original paths.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Bindings, Env } from "@/types";
import { errorResponse } from "@/lib/http";

// API routes
import { agents } from "@/routes/agents";
import { health } from "@/routes/health";
import { home } from "@/routes/home";
import { leaderboard } from "@/routes/leaderboard";
import { me } from "@/routes/me";
import { publish } from "@/routes/publish";
import { skills } from "@/routes/skills";
import { telemetry } from "@/routes/telemetry";

// Scheduled jobs
import { recomputeRankings } from "@/jobs/recompute-rankings";
import { refreshUserStats } from "@/jobs/refresh-user-stats";

// Marketing pages
import { renderLanding } from "@/pages/landing";
import { renderSkillPage } from "@/pages/skill";
import { renderLeaderboardPage } from "@/pages/leaderboard";
import { renderDashboardPage } from "@/pages/dashboard";
import { renderInstallPage } from "@/pages/install";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------

app.use("*", logger());

app.use(
  "/v1/*",
  cors({
    origin: "*", // Public read API; agents call from anywhere
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 86400,
  }),
);

// Security headers on every response
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Frame-Options", "DENY");
});

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

app.route("/v1/health", health);
app.route("/v1/agents", agents);
app.route("/v1/publish", publish);
app.route("/v1/skills", skills);
app.route("/v1/telemetry", telemetry);
app.route("/v1/home", home);
app.route("/v1/me", me);
app.route("/v1/leaderboard", leaderboard);

// ---------------------------------------------------------------------------
// Marketing pages (server-rendered HTML via Hono JSX)
// ---------------------------------------------------------------------------

app.get("/", (c) => renderLanding(c));
app.get("/leaderboard", (c) => renderLeaderboardPage(c));
app.get("/dashboard", (c) => renderDashboardPage(c));
app.get("/docs/base-skill", (c) => renderInstallPage(c));
app.get("/s/:slug", (c) => renderSkillPage(c));

// ---------------------------------------------------------------------------
// Static assets (handled by the [assets] binding) + 404 fallback
// ---------------------------------------------------------------------------

app.notFound((c) => {
  // First try the static assets binding for any /assets/* or /favicon.ico
  // request that didn't match an HTML route
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return errorResponse(c, "not_found", `No route for ${c.req.path}.`);
});

app.onError((err, c) => {
  console.error("[onError]", err);
  return errorResponse(c, "server_error", "Internal server error.");
});

// ---------------------------------------------------------------------------
// Cloudflare Worker default export — fetch (Hono) + scheduled (cron)
// ---------------------------------------------------------------------------

export default {
  fetch: app.fetch.bind(app),

  /**
   * Cron handler — invoked by Cloudflare on the schedule defined in
   * wrangler.toml `[triggers]`. Each cron is identified by its expression;
   * we route on it to call the right job.
   */
  async scheduled(
    controller: ScheduledController,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    const cron = controller.cron;
    console.log(`[scheduled] cron=${cron}`);
    if (cron === "13 * * * *") {
      ctx.waitUntil(
        recomputeRankings(env)
          .then((r) => console.log("[recomputeRankings] done", r))
          .catch((e) => console.error("[recomputeRankings] failed", e)),
      );
    } else if (cron === "37 * * * *") {
      ctx.waitUntil(
        refreshUserStats(env)
          .then(() => console.log("[refreshUserStats] done"))
          .catch((e) => console.error("[refreshUserStats] failed", e)),
      );
    } else {
      console.warn(`[scheduled] unrecognized cron: ${cron}`);
    }
  },
} satisfies ExportedHandler<Bindings>;

