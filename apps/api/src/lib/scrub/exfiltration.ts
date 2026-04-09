/**
 * Anti-exfiltration filter for skill publishing.
 *
 * Runs after the existing regex scrub (`scanSkill` in ./regex.ts). Unlike
 * that scrub — which protects the *publisher* from leaking their own secrets —
 * this pass protects the *downstream session* from a rogue skill that tries
 * to exfiltrate user data or override safety instructions once it's loaded
 * into Claude's context via `jit_load.py`.
 *
 * Three severity tiers:
 *   - "block"  → auto-reject at publish time. High-precision rules only
 *                (invisible-Unicode injection, explicit webhook sinks,
 *                curl-pipe-shell, base64 decodes-to-block).
 *   - "review" → publish succeeds, but the resulting skill_versions row is
 *                marked reviewStatus='pending' and stays invisible to
 *                search/download until a human clears it. Used for fuzzier
 *                heuristics that would have too many false positives on
 *                legitimate security-tooling skills (e.g. a skill that
 *                *discusses* prompt injection or uses subprocess).
 *   - "warn"   → informational, recorded in the scrub report but does not
 *                affect publish.
 *
 * Keep this file in rough sync with the block-tier parity port in
 * `base-skill/skillhub/scripts/sanitize.py` and the rule documentation in
 * `base-skill/skillhub/references/scrubbing.md`.
 */

import type { ScanFile } from "./regex";

export type ExfiltrationSeverity = "block" | "review" | "warn" | "info";

export interface ExfiltrationFinding {
  type: string;
  severity: ExfiltrationSeverity;
  /** Which pass produced this. "rule" today; "llm" when the classifier is enabled. */
  tier: "rule" | "llm";
  file: string;
  line: number;
  snippet: string;
  reason: string;
}

export interface ExfiltrationResult {
  /** Worst severity seen across all findings, or "clean". */
  overallSeverity: ExfiltrationSeverity | "clean";
  findings: ExfiltrationFinding[];
}

// ---------------------------------------------------------------------------
// Host allowlist — hosts legitimate skills are allowed to POST/PUT/PATCH to
// without triggering a review. Keep short; err on the side of review.
// ---------------------------------------------------------------------------

const HOST_ALLOWLIST: readonly string[] = [
  "agentskilldepot.com",
  "api.anthropic.com",
  "localhost",
  "127.0.0.1",
];

// ---------------------------------------------------------------------------
// Block-tier: explicit exfiltration sinks. Presence → auto-reject.
// ---------------------------------------------------------------------------

const WEBHOOK_SINK_PATTERNS: readonly { rx: RegExp; label: string }[] = [
  { rx: /discord(?:app)?\.com\/api\/webhooks/gi, label: "discord_webhook" },
  { rx: /\bwebhook\.site\b/gi, label: "webhook_site" },
  { rx: /\brequestbin\b/gi, label: "requestbin" },
  { rx: /\bpipedream\.net\b/gi, label: "pipedream" },
  { rx: /\bngrok\.(?:io|app|dev)\b/gi, label: "ngrok_tunnel" },
  { rx: /\btrycloudflare\.com\b/gi, label: "cloudflare_tunnel" },
  { rx: /\blocaltunnel\.me\b/gi, label: "localtunnel" },
  { rx: /\bserveo\.net\b/gi, label: "serveo_tunnel" },
  { rx: /\bburpcollaborator\.net\b/gi, label: "burp_collaborator" },
  { rx: /\bcanarytokens\.com\b/gi, label: "canarytokens" },
  { rx: /\bdnslog\.cn\b/gi, label: "dnslog" },
  { rx: /\b[a-z0-9.-]+\.onion\b/gi, label: "onion_address" },
];

// curl … | sh  /  wget … | bash  /  bash -c "$(curl …)"
const CURL_PIPE_SHELL = [
  /\bcurl\b[^\n|&;]{0,200}\|\s*(?:sh|bash|zsh|ksh|dash)\b/gi,
  /\bwget\b[^\n|&;]{0,200}\|\s*(?:sh|bash|zsh|ksh|dash)\b/gi,
  /\$\(\s*curl\b[^)]{0,200}\)/gi,
  /\$\(\s*wget\b[^)]{0,200}\)/gi,
];

// Invisible / zero-width / tag characters. These have no legitimate use in
// skill docs and are a known prompt-injection vector.
// eslint-disable-next-line no-misleading-character-class, no-control-regex
const INVISIBLE_UNICODE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFE00-\uFE0F\uFFF9-\uFFFC]|[\uDB40][\uDC00-\uDC7F]/g;

// ---------------------------------------------------------------------------
// Review-tier heuristics. Fire often on benign skills — hence review, not block.
// ---------------------------------------------------------------------------

const HIDDEN_INSTRUCTION_PATTERNS: readonly { rx: RegExp; label: string }[] = [
  { rx: /ignore\s+(?:all\s+)?(?:previous|above|prior)\s+instructions/gi, label: "ignore_previous_instructions" },
  { rx: /disregard\s+(?:all\s+)?(?:previous|above|prior|safety|rules)/gi, label: "disregard_rules" },
  { rx: /you\s+are\s+now\s+(?:a|an|in)\s+/gi, label: "role_override" },
  { rx: /\bDAN\s+mode\b/gi, label: "dan_mode" },
  { rx: /\bjailbreak\b/gi, label: "jailbreak_keyword" },
  { rx: /developer\s+mode\s+(?:enabled|on)/gi, label: "developer_mode" },
  { rx: /system\s+prompt\s*[:=]/gi, label: "system_prompt_override" },
  { rx: /override\s+(?:safety|guardrails|instructions)/gi, label: "safety_override" },
];

const UNSAFE_CALL_PATTERNS: readonly { rx: RegExp; label: string }[] = [
  // Python
  { rx: /\beval\s*\(/g, label: "eval_call" },
  { rx: /\bexec\s*\(/g, label: "exec_call" },
  { rx: /\bcompile\s*\(/g, label: "compile_call" },
  { rx: /\b__import__\s*\(/g, label: "dunder_import" },
  { rx: /\bos\.system\s*\(/g, label: "os_system" },
  { rx: /\bsubprocess\.(?:run|call|Popen|check_output|check_call)\s*\(/g, label: "subprocess_call" },
  { rx: /\bpty\.spawn\s*\(/g, label: "pty_spawn" },
  // Node
  { rx: /\bnew\s+Function\s*\(/g, label: "new_function" },
  { rx: /\bchild_process\b/g, label: "child_process" },
  { rx: /\brequire\s*\(\s*['"]vm['"]\s*\)/g, label: "vm_require" },
  // Shell
  { rx: /\bbash\s+-c\s+["']/g, label: "bash_dash_c" },
];

// Files that look like user data / secrets — in proximity to a network call,
// that's an exfil shape.
const EXFIL_SINK_PATTERNS: readonly { rx: RegExp; label: string }[] = [
  { rx: /~\/\.ssh\b/g, label: "ssh_dir" },
  { rx: /~\/\.aws\b/g, label: "aws_dir" },
  { rx: /~\/\.config\b/g, label: "config_dir" },
  { rx: /\bprocess\.env\b/g, label: "process_env" },
  { rx: /\bdocument\.cookie\b/g, label: "document_cookie" },
  { rx: /\blocalStorage\b/g, label: "local_storage" },
  { rx: /\bsessionStorage\b/g, label: "session_storage" },
  { rx: /\/etc\/passwd\b/g, label: "etc_passwd" },
  { rx: /\/etc\/shadow\b/g, label: "etc_shadow" },
  { rx: /\b\.env\b/g, label: "dotenv_file" },
];

const NETWORK_CALL_PATTERNS: readonly RegExp[] = [
  /\brequests\.(?:get|post|put|patch|delete)\s*\(/g,
  /\burllib\.request\b/g,
  /\bhttp\.client\b/g,
  /\bhttpx\.(?:get|post|put|patch|delete)\s*\(/g,
  /\bfetch\s*\(/g,
  /\baxios\.(?:get|post|put|patch|delete)\s*\(/g,
  /\bcurl\b/g,
];

const POST_CALL_WITH_URL =
  /\b(?:requests|httpx|axios)\.(?:post|put|patch)\s*\(\s*["']?(https?:\/\/[^\s"']+)/gi;

const FETCH_POST_PATTERN =
  /\bfetch\s*\(\s*["']?(https?:\/\/[^\s"']+)[^)]*\bmethod\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/gi;

// ---------------------------------------------------------------------------
// File-type gate — we only scan text files, and not e.g. vendored minified JS
// where false positives dominate.
// ---------------------------------------------------------------------------

const SCANNABLE_EXTENSIONS = new Set([
  "md", "markdown", "txt", "rst",
  "py", "pyi",
  "js", "mjs", "cjs", "ts", "tsx", "jsx",
  "json", "yaml", "yml", "toml",
  "sh", "bash", "zsh",
  "html", "xml",
]);

// Files that define the exfiltration rules themselves. Scanning them
// produces guaranteed false positives (they contain every block-tier
// pattern by design). Kept in sync with `_EXFIL_SELF_REFERENTIAL_SUFFIXES`
// in base-skill/skillhub/scripts/sanitize.py.
const SELF_REFERENTIAL_SUFFIXES: readonly string[] = [
  "references/scrubbing.md",
  "scripts/sanitize.py",
];

function isScannable(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  // Skip common vendor/bundled paths outright.
  if (/\b(?:node_modules|vendor|dist|build|\.min\.)/i.test(normalized)) return false;
  // Skip the detector's own spec/source.
  for (const suffix of SELF_REFERENTIAL_SUFFIXES) {
    if (normalized === suffix || normalized.endsWith("/" + suffix)) return false;
  }
  const ext = normalized.split(".").pop() ?? "";
  return SCANNABLE_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the rule-based exfiltration detectors over a set of extracted skill
 * files. Does not touch the network; pure regex + string work.
 */
export function detectExfiltration(files: ScanFile[]): ExfiltrationResult {
  const findings: ExfiltrationFinding[] = [];

  for (const file of files) {
    if (!isScannable(file.path)) continue;
    scanFile(file, findings);
    scanDecodedBase64(file, findings);
  }

  return {
    overallSeverity: worstSeverity(findings),
    findings,
  };
}

// ---------------------------------------------------------------------------
// Per-file scan
// ---------------------------------------------------------------------------

function scanFile(file: ScanFile, out: ExfiltrationFinding[]): void {
  const { path, content } = file;

  // --- BLOCK: invisible Unicode ---
  for (const m of content.matchAll(INVISIBLE_UNICODE)) {
    out.push(makeFinding({
      type: "invisible_unicode",
      severity: "block",
      file: path,
      offset: m.index ?? 0,
      content,
      snippet: describeCodepoint(m[0]!),
      reason:
        "File contains invisible / zero-width / tag characters. These have no " +
        "legitimate use in skill content and are a known prompt-injection vector.",
    }));
  }

  // --- BLOCK: explicit webhook/exfil sinks ---
  for (const { rx, label } of WEBHOOK_SINK_PATTERNS) {
    for (const m of content.matchAll(rx)) {
      out.push(makeFinding({
        type: `webhook_sink:${label}`,
        severity: "block",
        file: path,
        offset: m.index ?? 0,
        content,
        snippet: truncate(m[0]!),
        reason: `URL references a known data-exfiltration sink (${label}).`,
      }));
    }
  }

  // --- BLOCK: curl | sh ---
  for (const rx of CURL_PIPE_SHELL) {
    for (const m of content.matchAll(rx)) {
      out.push(makeFinding({
        type: "curl_pipe_shell",
        severity: "block",
        file: path,
        offset: m.index ?? 0,
        content,
        snippet: truncate(m[0]!),
        reason:
          "Piping curl/wget output directly into a shell executes remote code " +
          "unconditionally at install time.",
      }));
    }
  }

  // --- REVIEW: hidden instructions ---
  for (const { rx, label } of HIDDEN_INSTRUCTION_PATTERNS) {
    for (const m of content.matchAll(rx)) {
      out.push(makeFinding({
        type: `hidden_instruction:${label}`,
        severity: "review",
        file: path,
        offset: m.index ?? 0,
        content,
        snippet: truncate(m[0]!),
        reason:
          "Matches a prompt-injection phrase pattern. Legitimate security " +
          "skills may discuss this — routed to human review rather than blocked.",
      }));
    }
  }

  // --- REVIEW: unsafe call surfaces ---
  for (const { rx, label } of UNSAFE_CALL_PATTERNS) {
    for (const m of content.matchAll(rx)) {
      out.push(makeFinding({
        type: `unsafe_call:${label}`,
        severity: "review",
        file: path,
        offset: m.index ?? 0,
        content,
        snippet: truncate(m[0]!),
        reason:
          "Dynamic code execution or subprocess call. Legitimate for some " +
          "skills; routed to review.",
      }));
    }
  }

  // --- REVIEW: non-allowlisted POST/PUT/PATCH ---
  scanNetworkTargets(file, out);

  // --- REVIEW: exfil sink near a network call (proximity heuristic) ---
  scanProximity(file, out);
}

function scanNetworkTargets(file: ScanFile, out: ExfiltrationFinding[]): void {
  const { path, content } = file;

  const tag = (
    rx: RegExp,
    urlGroup: number,
    reason: string,
    typeLabel: string,
  ) => {
    for (const m of content.matchAll(rx)) {
      const url = m[urlGroup];
      if (!url) continue;
      const host = extractHost(url);
      if (!host) continue;
      if (isAllowlisted(host)) continue;
      out.push(makeFinding({
        type: typeLabel,
        severity: "review",
        file: path,
        offset: m.index ?? 0,
        content,
        snippet: truncate(m[0]!),
        reason: `${reason} (host: ${host})`,
      }));
    }
  };

  tag(
    POST_CALL_WITH_URL,
    1,
    "Non-allowlisted HTTP write call",
    "network_post_unknown_host",
  );
  tag(
    FETCH_POST_PATTERN,
    1,
    "Non-allowlisted fetch() with write method",
    "fetch_post_unknown_host",
  );
}

function scanProximity(file: ScanFile, out: ExfiltrationFinding[]): void {
  const lines = file.content.split("\n");
  const PROXIMITY = 5;

  // Precompute line numbers where network calls occur.
  const netLines = new Set<number>();
  lines.forEach((line, i) => {
    for (const rx of NETWORK_CALL_PATTERNS) {
      if (rx.test(line)) {
        netLines.add(i);
        break;
      }
    }
  });
  if (netLines.size === 0) return;

  lines.forEach((line, i) => {
    for (const { rx, label } of EXFIL_SINK_PATTERNS) {
      if (!rx.test(line)) continue;
      // Any network call within PROXIMITY lines?
      let hit = false;
      for (let j = Math.max(0, i - PROXIMITY); j <= Math.min(lines.length - 1, i + PROXIMITY); j++) {
        if (netLines.has(j)) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
      out.push({
        type: `exfil_proximity:${label}`,
        severity: "review",
        tier: "rule",
        file: file.path,
        line: i + 1,
        snippet: truncate(line),
        reason:
          `Sensitive source '${label}' appears within ${PROXIMITY} lines of a ` +
          "network call. Classic exfiltration shape; routed to human review.",
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Base64 single-decode pass
// ---------------------------------------------------------------------------

// Base64 chunks long enough to hide a URL + path. Tuned conservative.
const BASE64_CHUNK = /[A-Za-z0-9+/]{120,}={0,2}/g;

function scanDecodedBase64(file: ScanFile, out: ExfiltrationFinding[]): void {
  const matches = file.content.matchAll(BASE64_CHUNK);
  for (const m of matches) {
    const raw = m[0]!;
    let decoded: string;
    try {
      // atob is available in Workers runtime.
      decoded = atob(raw);
    } catch {
      continue;
    }
    // Only care if the decoded bytes look like text.
    if (!isMostlyPrintable(decoded)) continue;

    // Re-run ONLY block-tier detectors on the decoded content. We do not
    // recurse into review-tier or another base64 pass — keeps this bounded.
    const subFile: ScanFile = {
      path: `${file.path} (decoded base64 @ offset ${m.index ?? 0})`,
      content: decoded,
    };
    const subFindings: ExfiltrationFinding[] = [];

    for (const hit of decoded.matchAll(INVISIBLE_UNICODE)) {
      subFindings.push(makeFinding({
        type: "invisible_unicode_in_base64",
        severity: "block",
        file: subFile.path,
        offset: hit.index ?? 0,
        content: decoded,
        snippet: describeCodepoint(hit[0]!),
        reason: "Invisible Unicode inside a base64 blob.",
      }));
    }
    for (const { rx, label } of WEBHOOK_SINK_PATTERNS) {
      for (const hit of decoded.matchAll(rx)) {
        subFindings.push(makeFinding({
          type: `webhook_sink_in_base64:${label}`,
          severity: "block",
          file: subFile.path,
          offset: hit.index ?? 0,
          content: decoded,
          snippet: truncate(hit[0]!),
          reason: `Base64 chunk decodes to a known exfiltration sink (${label}).`,
        }));
      }
    }
    for (const rx of CURL_PIPE_SHELL) {
      for (const hit of decoded.matchAll(rx)) {
        subFindings.push(makeFinding({
          type: "curl_pipe_shell_in_base64",
          severity: "block",
          file: subFile.path,
          offset: hit.index ?? 0,
          content: decoded,
          snippet: truncate(hit[0]!),
          reason: "Base64 chunk decodes to a curl|sh command.",
        }));
      }
    }

    if (subFindings.length > 0) {
      out.push(...subFindings);
    }
  }
}

function isMostlyPrintable(s: string): boolean {
  if (s.length === 0) return false;
  let printable = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13) printable++;
  }
  return printable / s.length > 0.85;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    const m = url.match(/^https?:\/\/([^/\s"'`]+)/i);
    return m ? m[1]!.toLowerCase() : null;
  }
}

function isAllowlisted(host: string): boolean {
  for (const allowed of HOST_ALLOWLIST) {
    if (host === allowed || host.endsWith("." + allowed)) return true;
  }
  return false;
}

function worstSeverity(
  findings: readonly ExfiltrationFinding[],
): ExfiltrationResult["overallSeverity"] {
  if (findings.some((f) => f.severity === "block")) return "block";
  if (findings.some((f) => f.severity === "review")) return "review";
  if (findings.some((f) => f.severity === "warn")) return "warn";
  return "clean";
}

function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

function truncate(s: string, limit = 160): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : collapsed.slice(0, limit) + "…";
}

function describeCodepoint(s: string): string {
  const cps: string[] = [];
  for (const ch of s) {
    cps.push("U+" + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0"));
  }
  return `invisible char ${cps.join(",")}`;
}

interface MakeFindingArgs {
  type: string;
  severity: ExfiltrationSeverity;
  file: string;
  offset: number;
  content: string;
  snippet: string;
  reason: string;
}

function makeFinding(args: MakeFindingArgs): ExfiltrationFinding {
  return {
    type: args.type,
    severity: args.severity,
    tier: "rule",
    file: args.file,
    line: lineOf(args.content, args.offset),
    snippet: args.snippet,
    reason: args.reason,
  };
}

// ---------------------------------------------------------------------------
// Merge helper for the publish route.
// ---------------------------------------------------------------------------

/** Fold a set of exfiltration findings and return the worst overall severity. */
export function worstOf(
  ...results: readonly ExfiltrationResult[]
): ExfiltrationResult["overallSeverity"] {
  const order: Record<ExfiltrationResult["overallSeverity"], number> = {
    clean: 0,
    info: 1,
    warn: 2,
    review: 3,
    block: 4,
  };
  let worst: ExfiltrationResult["overallSeverity"] = "clean";
  for (const r of results) {
    if (order[r.overallSeverity] > order[worst]) worst = r.overallSeverity;
  }
  return worst;
}
