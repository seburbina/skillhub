/**
 * CI-only ESM loader hook: redirects any `import "@neondatabase/serverless"`
 * to the pg-backed shim at ./neon-pg-shim.mjs.
 *
 * Activated via `register("./neon-shim-loader.mjs", ...)` in register-neon-shim.mjs.
 *
 * This lets the production apps/api/scripts/add-*.mjs files (which import the
 * real Neon HTTP driver) run unchanged against a local Postgres in CI.
 */
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const shimUrl = pathToFileURL(join(here, "neon-pg-shim.mjs")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@neondatabase/serverless") {
    return {
      url: shimUrl,
      shortCircuit: true,
      format: "module",
    };
  }
  return nextResolve(specifier, context);
}
