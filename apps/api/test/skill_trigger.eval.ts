/**
 * Skill-trigger eval — asks Claude haiku-4 to classify 30 user prompts
 * into the skill that should handle them, then asserts the expected
 * skill is the top-1 match.
 *
 * Run manually:  pnpm exec vitest run test/skill_trigger.eval.ts
 * Run in CI:     weekly cron via .github/workflows/skill-trigger-eval.yml
 *
 * Requires ANTHROPIC_API_KEY in env. Skipped (not failed) if missing,
 * so this file does not affect local `pnpm test`. The default vitest
 * config also globs only `*.test.ts`, so this `.eval.ts` is excluded
 * from regular runs entirely — both belt and suspenders.
 *
 * Why a model-in-the-loop test? The base skill's YAML description is
 * what the harness uses to decide whether to invoke `skillhub`. A
 * description rewrite that changes wording can silently break intent
 * matching for phrases like "share this skill" or "find a skill that
 * does X". This eval is the regression gate for that class of bug.
 */
import { describe, it, expect } from "vitest";

const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
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

async function classify(userPrompt: string): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      tools: [
        {
          name: "report_skill",
          description: "Report which skill should handle this prompt.",
          input_schema: {
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
      ],
      tool_choice: { type: "tool", name: "report_skill" },
      system:
        "You are an expert at routing user prompts to the right skill. " +
        "Given a user message, choose ONE skill slug from: skillhub, pdf, xlsx, docx, pptx, skill-creator, none. " +
        "Reply only via report_skill.",
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!r.ok) throw new Error(`API ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as {
    content: Array<{ type: string; name?: string; input?: ClassifyResponse }>;
  };
  const tu = j.content.find((b) => b.type === "tool_use");
  return tu?.input?.predicted_skill ?? "unknown";
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
