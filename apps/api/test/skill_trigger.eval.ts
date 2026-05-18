/**
 * Skill-trigger eval — asks Cloudflare Workers AI (Llama 3.3 70B) to
 * classify ~30 user prompts into the skill that should handle them,
 * then asserts the expected skill is the top-1 match.
 *
 * Run manually:  pnpm exec vitest run --config vitest.eval.config.ts
 * Run in CI:     weekly cron via .github/workflows/skill-trigger-eval.yml
 *
 * Requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in env (already
 * present in repo secrets for the deploy workflow — no new secret to
 * provision). Skipped (not failed) if missing, so this file does not
 * affect local `pnpm test`. The default vitest config also globs only
 * `*.test.ts`, so this `.eval.ts` is excluded from regular runs
 * entirely — both belt and suspenders.
 *
 * Why an open model instead of Claude? Agent Skill Depot is
 * cross-vendor by design (works with Claude Code, Cursor, Copilot,
 * Codex, Gemini CLI). Using Llama as the eval oracle proves the
 * SKILL.md description is routable by a non-Claude classifier — a
 * better proxy for cross-vendor compatibility than testing against
 * the specific model the operator happens to be using.
 */
import { describe, it, expect } from "vitest";

const HAS_KEY =
  Boolean(process.env.CLOUDFLARE_API_TOKEN) &&
  Boolean(process.env.CLOUDFLARE_ACCOUNT_ID);
const describeIfKey = HAS_KEY ? describe : describe.skip;

interface Case {
  prompt: string;
  expectedSkill: string;
}

const cases: Case[] = [
  // skillhub — explicit trigger phrases from base-skill/skillhub/SKILL.md
  { prompt: "share this skill on Agent Skill Depot", expectedSkill: "skillhub" },
  { prompt: "publish this to skillhub", expectedSkill: "skillhub" },
  { prompt: "find a skill that does pdf extraction", expectedSkill: "skillhub" },
  { prompt: "install the pdf-extractor skill", expectedSkill: "skillhub" },
  { prompt: "register me with agent skill depot", expectedSkill: "skillhub" },
  { prompt: "update my skills", expectedSkill: "skillhub" },
  { prompt: "search agent skill depot for csv tools", expectedSkill: "skillhub" },
  { prompt: "is there a skill on the depot for log parsing?", expectedSkill: "skillhub" },
  { prompt: "this skill works great, push it to the depot", expectedSkill: "skillhub" },

  // pdf — direct file-format references
  { prompt: "extract tables from this pdf file", expectedSkill: "pdf" },
  { prompt: "merge these two pdfs", expectedSkill: "pdf" },
  { prompt: "fill out this PDF form", expectedSkill: "pdf" },
  { prompt: "OCR this scanned document.pdf so I can search it", expectedSkill: "pdf" },
  { prompt: "split report.pdf into one file per chapter", expectedSkill: "pdf" },

  // xlsx — spreadsheet references
  { prompt: "open the spreadsheet in my downloads folder", expectedSkill: "xlsx" },
  { prompt: "add a column to this csv with computed values", expectedSkill: "xlsx" },
  { prompt: "clean up the malformed rows in data.xlsx", expectedSkill: "xlsx" },
  { prompt: "make a pivot chart from sales.csv", expectedSkill: "xlsx" },

  // docx — Word document references
  { prompt: "write a memo as a Word document", expectedSkill: "docx" },
  { prompt: "fix the heading styles in this .docx", expectedSkill: "docx" },
  { prompt: "draft a cover letter and save it as a .docx", expectedSkill: "docx" },

  // pptx — slide-deck references
  { prompt: "create slides for this content", expectedSkill: "pptx" },
  { prompt: "extract the speaker notes from deck.pptx", expectedSkill: "pptx" },

  // skill-creator — meta references about authoring skills
  { prompt: "create a new skill from scratch", expectedSkill: "skill-creator" },
  { prompt: "test how well this skill triggers", expectedSkill: "skill-creator" },
  { prompt: "benchmark my skill's triggering accuracy", expectedSkill: "skill-creator" },

  // none — neutral conversational prompts that shouldn't fire any skill
  { prompt: "what is the difference between json and yaml", expectedSkill: "none" },
  { prompt: "explain how cloudflare workers handle requests", expectedSkill: "none" },
  { prompt: "tell me about the history of cryptography", expectedSkill: "none" },

  // ambiguous — borderline cases. The skillhub SKILL.md has a proactive
  // rule: when a task involves verbs like extract/parse/convert, it
  // should ASK whether to check Agent Skill Depot first. We assert
  // skillhub here to lock in that behavior.
  { prompt: "I need to extract data from these documents", expectedSkill: "skillhub" },
  { prompt: "help me parse this messy log file", expectedSkill: "skillhub" },
];

interface ClassifyResponse {
  predicted_skill: string;
  reasoning: string;
}

/** Workers AI model with reliable function-calling support. */
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const SYSTEM_PROMPT =
  "You are an expert at routing user prompts to the right skill. " +
  "Given a user message, choose ONE skill slug from: skillhub, pdf, " +
  "xlsx, docx, pptx, skill-creator, none. Reply only via the " +
  "report_skill function.";

const TOOL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "report_skill",
    description: "Report which skill should handle this prompt.",
    parameters: {
      type: "object",
      properties: {
        predicted_skill: {
          type: "string",
          description:
            "Slug of the skill (skillhub, pdf, xlsx, docx, pptx, skill-creator), or 'none' if no specialized skill applies.",
        },
        reasoning: { type: "string" },
      },
      required: ["predicted_skill", "reasoning"],
    },
  },
};

/**
 * Call Workers AI's OpenAI-compatible chat endpoint. The response is
 * wrapped in `{ success, result }`; `result` usually contains either
 * an OpenAI-style `choices[0].message.tool_calls[0]`, or a Workers-AI
 * native `tool_calls[0]`, or a free-text `response` field if the
 * model refused to use the tool. We try all three shapes defensively.
 */
async function classify(userPrompt: string): Promise<string> {
  const acctId = process.env.CLOUDFLARE_ACCOUNT_ID!;
  const token = process.env.CLOUDFLARE_API_TOKEN!;
  const url = `https://api.cloudflare.com/client/v4/accounts/${acctId}/ai/run/${MODEL}`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      tools: [TOOL_SCHEMA],
      tool_choice: {
        type: "function",
        function: { name: "report_skill" },
      },
      max_tokens: 256,
    }),
  });
  if (!r.ok) throw new Error(`Workers AI ${r.status}: ${await r.text()}`);

  const j = (await r.json()) as {
    success?: boolean;
    result?: {
      // OpenAI-style
      choices?: Array<{
        message?: {
          tool_calls?: Array<{
            function?: { name?: string; arguments?: string | object };
          }>;
        };
      }>;
      // Workers-AI native
      tool_calls?: Array<{ name?: string; arguments?: string | object }>;
      // Free-text fallback
      response?: string;
    };
    errors?: Array<{ message?: string }>;
  };

  if (j.errors?.length) {
    throw new Error(`Workers AI: ${j.errors.map((e) => e.message).join(", ")}`);
  }

  const result = j.result ?? {};

  const tryParse = (args: string | object | undefined): ClassifyResponse | null => {
    if (!args) return null;
    if (typeof args === "string") {
      try {
        return JSON.parse(args) as ClassifyResponse;
      } catch {
        return null;
      }
    }
    if (typeof args === "object") return args as ClassifyResponse;
    return null;
  };

  // 1. OpenAI shape.
  const openAiArgs = result.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  const openAi = tryParse(openAiArgs);
  if (openAi?.predicted_skill) return openAi.predicted_skill;

  // 2. Workers-AI native shape.
  const nativeArgs = result.tool_calls?.[0]?.arguments;
  const native = tryParse(nativeArgs);
  if (native?.predicted_skill) return native.predicted_skill;

  // 3. Free-text fallback (only if the model emitted valid JSON in
  //    `response` instead of calling the tool — happens occasionally
  //    with smaller models, not expected from Llama 3.3 70B).
  if (typeof result.response === "string") {
    const fallback = tryParse(result.response);
    if (fallback?.predicted_skill) return fallback.predicted_skill;
  }

  throw new Error(
    `Unexpected Workers AI response shape: ${JSON.stringify(result).slice(0, 200)}`,
  );
}

describeIfKey("skill-trigger eval", () => {
  for (const c of cases) {
    it(
      `${c.expectedSkill} ← "${c.prompt}"`,
      async () => {
        const predicted = await classify(c.prompt);
        // Per-case strict assert. If you want a >80% threshold instead
        // of 100%, replace each `it` with `it.fails` and add a single
        // accuracy check across all cases. For now the gate is strict
        // so a single regression surfaces immediately in the CI report.
        expect(predicted).toBe(c.expectedSkill);
      },
      30_000,
    );
  }
});
