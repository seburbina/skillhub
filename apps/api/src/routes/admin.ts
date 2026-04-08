/**
 * Admin surface — read-only v1.
 *
 * Mounted by `apps/api/src/index.ts` via host-based branching when the
 * request's Host header starts with `admin.`. All authentication happens
 * at the edge via Cloudflare Access (see infra/DEPLOY.md); this Worker
 * trusts the host header because Cloudflare blocks every unauthenticated
 * request before it reaches us.
 *
 * Write actions (resolve / dismiss / yank / revoke) are deferred to v2
 * on purpose — shipping a read-only surface first is safer and the main
 * thing we need is visibility into the moderation queue.
 */
import { Hono } from "hono";
import { renderAdminAgent } from "@/pages/admin/agent";
import { renderAdminQueue } from "@/pages/admin/queue";
import { renderAdminReviewQueue } from "@/pages/admin/review-queue";
import { renderAdminSkill } from "@/pages/admin/skill";
import type { Env } from "@/types";

export const admin = new Hono<Env>();

admin.get("/", (c) =>
  c.redirect("/queue", 302),
);
admin.get("/queue", (c) => renderAdminQueue(c));
admin.get("/review-queue", (c) => renderAdminReviewQueue(c));
admin.get("/agent", (c) => renderAdminAgent(c));
admin.get("/skill", (c) => renderAdminSkill(c));

admin.notFound((c) =>
  c.html(
    `<html><body style="font:14px/1.5 -apple-system,system-ui;padding:24px">
      <h1 style="font-size:20px">Not found</h1>
      <p>No admin route for <code>${c.req.path}</code>.</p>
      <p><a href="/queue">Queue</a> · <a href="/review-queue">Exfil review</a> · <a href="/agent">Agent</a> · <a href="/skill">Skill</a></p>
    </body></html>`,
    404,
  ),
);
