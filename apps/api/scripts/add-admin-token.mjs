#!/usr/bin/env node
/**
 * Generates a high-entropy ADMIN_TOKEN, stores it as a wrangler secret in
 * the target environment, and echoes the value ONCE to stdout. The value
 * is never written to disk and never echoed again — if you lose it, run
 * this script again to mint a fresh one (the old one is immediately
 * superseded because wrangler-secret-put overwrites).
 *
 * Usage:
 *   node scripts/add-admin-token.mjs              # production env
 *   node scripts/add-admin-token.mjs --env=dev    # dev env
 *
 * After running, use the token to curl /v1/admin/* endpoints:
 *   curl -H "Authorization: Bearer $TOKEN" https://agentskilldepot.com/v1/admin/embed-status
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const env = process.argv.find((a) => a.startsWith("--env="))?.slice(6);
const token = randomBytes(32).toString("hex");

const args = ["exec", "wrangler", "secret", "put", "ADMIN_TOKEN"];
if (env) args.push(`--env=${env}`);

console.log(`Storing ADMIN_TOKEN in ${env ?? "production"} environment...`);
const res = spawnSync("pnpm", args, {
  input: token,
  stdio: ["pipe", "inherit", "inherit"],
});
if (res.status !== 0) {
  console.error("wrangler secret put failed");
  process.exit(res.status ?? 1);
}

console.log("\n" + "=".repeat(72));
console.log("ADMIN_TOKEN (save now — NOT shown again):");
console.log("=".repeat(72));
console.log(token);
console.log("=".repeat(72));
console.log("\nTest it:");
const host = env === "dev"
  ? "https://skillhub-dev.seburbina.workers.dev"
  : "https://agentskilldepot.com";
console.log(`  curl -sS -H "Authorization: Bearer ${token.slice(0, 8)}..." \\`);
console.log(`    ${host}/v1/admin/embed-status`);
