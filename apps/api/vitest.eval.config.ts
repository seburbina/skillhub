/**
 * Separate vitest config for the eval suite.
 *
 * The default `vitest.config.ts` only includes `*.test.ts` files, which
 * deliberately keeps the `.eval.ts` suffix out of `pnpm test` (so local
 * runs stay fast and don't require ANTHROPIC_API_KEY). This config flips
 * that — include `*.eval.ts` only, no `*.test.ts`.
 *
 * Invoked by `.github/workflows/skill-trigger-eval.yml` via
 * `pnpm exec vitest run --config vitest.eval.config.ts`.
 */
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.eval.ts"],
    environment: "node",
    // Per-test timeout — eval cases call the Anthropic API and need
    // headroom over vitest's default 5s. Matches the per-case timeout
    // in test/skill_trigger.eval.ts.
    testTimeout: 30_000,
  },
});
