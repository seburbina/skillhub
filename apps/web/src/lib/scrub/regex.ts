/**
 * Server-side regex re-scan — defense in depth.
 *
 * This is the TypeScript mirror of `base-skill/skillhub/scripts/sanitize.py`.
 * It runs on every successful `/v1/publish` request AFTER the client has
 * already run sanitize.py locally. If the client skipped the local scrub,
 * or if a newer version of our rule set catches something an older client
 * missed, this is where we block it.
 *
 * The LLM review (stage 2 in the client pipeline) is NOT mirrored on the
 * server — that runs in the user's own Claude session before upload. We
 * trust the regex layer here and use the client's `scrub_report.llm.json`
 * as informational audit material only.
 *
 * Keep this in sync with `base-skill/skillhub/references/scrubbing.md` and
 * `base-skill/skillhub/scripts/sanitize.py`. A CI job runs the same corpus
 * through both implementations to prevent drift.
 */

export type Severity = "block" | "warn" | "info";

export interface Finding {
  file: string;
  line: number;
  column: number;
  rule: string;
  severity: Severity;
  snippet: string;
  replacement: string;
}

export interface ScrubResult {
  overallSeverity: Severity | "clean";
  findings: Finding[];
  filesScanned: number;
  filesExcluded: string[];
}

interface Rule {
  name: string;
  severity: Severity;
  pattern: RegExp;
  replacement: string | ((match: string) => string);
}

// ---------------------------------------------------------------------------
// File-level exclusions
// ---------------------------------------------------------------------------

const EXCLUDED_FILENAMES = new Set([
  ".env",
  ".envrc",
  ".netrc",
  "id_rsa",
  "id_rsa.pub",
  "id_ed25519",
  "id_ed25519.pub",
  "credentials",
  "credentials.json",
  "credentials.yaml",
  "credentials.yml",
]);

const EXCLUDED_FILENAME_PATTERNS: RegExp[] = [
  /^\.env(\.|$)/,
  /^secrets?(\.|$)/i,
  /.*\.pem$/i,
  /.*\.key$/i,
  /.*\.pfx$/i,
  /.*\.p12$/i,
];

const EXCLUDED_DIRS = new Set([".aws", ".ssh", "__pycache__", "node_modules", ".git"]);

// ---------------------------------------------------------------------------
// Rules — identical to sanitize.py's set
// ---------------------------------------------------------------------------

const RULES: readonly Rule[] = [
  // block — credentials
  { name: "aws_access_key",   severity: "block", pattern: /\bAKIA[0-9A-Z]{16}\b/g,                                replacement: "<AWS_ACCESS_KEY_REDACTED>" },
  { name: "aws_secret",       severity: "block", pattern: /aws.{0,20}?(?:secret|access).{0,20}?['"]([A-Za-z0-9/+=]{40})['"]/gi, replacement: (m) => m.replace(/['"][A-Za-z0-9/+=]{40}['"]/, '"<AWS_SECRET_REDACTED>"') },
  { name: "github_pat",       severity: "block", pattern: /\bghp_[A-Za-z0-9]{36}\b/g,                             replacement: "<GITHUB_TOKEN_REDACTED>" },
  { name: "github_oauth",     severity: "block", pattern: /\bgho_[A-Za-z0-9]{36}\b/g,                             replacement: "<GITHUB_TOKEN_REDACTED>" },
  { name: "github_app",       severity: "block", pattern: /\bghs_[A-Za-z0-9]{36}\b/g,                             replacement: "<GITHUB_TOKEN_REDACTED>" },
  { name: "github_refresh",   severity: "block", pattern: /\bghr_[A-Za-z0-9]{36}\b/g,                             replacement: "<GITHUB_TOKEN_REDACTED>" },
  { name: "anthropic_key",    severity: "block", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,                       replacement: "<ANTHROPIC_KEY_REDACTED>" },
  { name: "openai_key",       severity: "block", pattern: /\bsk-(?!ant-)[A-Za-z0-9]{20,}\b/g,                     replacement: "<OPENAI_KEY_REDACTED>" },
  { name: "stripe_key",       severity: "block", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g,        replacement: "<STRIPE_KEY_REDACTED>" },
  { name: "google_api",       severity: "block", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,                           replacement: "<GOOGLE_API_KEY_REDACTED>" },
  { name: "slack_token",      severity: "block", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,                    replacement: "<SLACK_TOKEN_REDACTED>" },
  { name: "twilio_key",       severity: "block", pattern: /\bSK[0-9a-fA-F]{32}\b/g,                               replacement: "<TWILIO_KEY_REDACTED>" },
  { name: "sendgrid_key",     severity: "block", pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,        replacement: "<SENDGRID_KEY_REDACTED>" },
  { name: "private_key_pem",  severity: "block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,                  replacement: "<PRIVATE_KEY_REDACTED>" },
  { name: "jwt",              severity: "block", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: "<JWT_REDACTED>" },

  // warn — personal data
  { name: "ssn_us",           severity: "warn",  pattern: /\b\d{3}-\d{2}-\d{4}\b/g,                               replacement: "<SSN_REDACTED>" },
  { name: "email",            severity: "warn",  pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,  replacement: "<EMAIL_REDACTED>" },
  { name: "phone_intl",       severity: "warn",  pattern: /\+\d{1,3}[ .-]?\d{6,14}\b/g,                           replacement: "<PHONE_REDACTED>" },
  { name: "phone_us",         severity: "warn",  pattern: /\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g,replacement: "<PHONE_REDACTED>" },
  { name: "ipv4_private",     severity: "warn",  pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g, replacement: "<PRIVATE_IP_REDACTED>" },
  { name: "ipv4_public",      severity: "warn",  pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, replacement: "<IP_REDACTED>" },
  { name: "mac_address",      severity: "warn",  pattern: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g,         replacement: "<MAC_REDACTED>" },
  { name: "absolute_user_path", severity: "warn",pattern: /(?:\/Users|\/home)\/[^/\s"']+/g,                        replacement: "~" },
  { name: "internal_dns",     severity: "warn",  pattern: /\b[a-z0-9][a-z0-9-]*\.(?:internal|corp|local|lan)\b/g, replacement: "<INTERNAL_HOST_REDACTED>" },
];

// ---------------------------------------------------------------------------
// Credit-card detector (Luhn-validated)
// ---------------------------------------------------------------------------

function luhnOk(digits: string): boolean {
  let total = 0;
  const reversed = digits.split("").reverse();
  for (let i = 0; i < reversed.length; i++) {
    let n = parseInt(reversed[i]!, 10);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    total += n;
  }
  return total % 10 === 0 && digits.length >= 13;
}

const CC_PATTERN = /\b(?:\d[ -]*?){13,16}\b/g;

function scrubCreditCards(
  text: string,
  file: string,
  findings: Finding[],
): string {
  return text.replace(CC_PATTERN, (match, offset) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 16) return match;
    if (!luhnOk(digits)) return match;
    const { line, column } = lineColumn(text, offset);
    findings.push({
      file,
      line,
      column,
      rule: "credit_card",
      severity: "warn",
      snippet: truncate(match),
      replacement: "<CARD_REDACTED>",
    });
    return "<CARD_REDACTED>";
  });
}

// ---------------------------------------------------------------------------
// Scan API
// ---------------------------------------------------------------------------

export interface ScanFile {
  /** POSIX path relative to the skill root. */
  path: string;
  /** UTF-8 content. Binary files should be excluded before calling. */
  content: string;
}

/**
 * Scan a set of extracted skill files.
 *
 * Returns:
 *   - `overallSeverity` — worst severity seen ("clean" | "warn" | "block")
 *   - `findings` — every match with file, line, column, rule, snippet
 *   - `filesScanned` — count of files that actually got scanned
 *   - `filesExcluded` — paths we refused to include (treated as `block`)
 */
export function scanSkill(files: ScanFile[]): ScrubResult {
  const findings: Finding[] = [];
  const filesExcluded: string[] = [];
  let filesScanned = 0;

  for (const file of files) {
    if (isExcluded(file.path)) {
      filesExcluded.push(file.path);
      findings.push({
        file: file.path,
        line: 0,
        column: 0,
        rule: "file_excluded",
        severity: "block",
        snippet: `file excluded from package: ${file.path}`,
        replacement: "(removed)",
      });
      continue;
    }

    filesScanned += 1;

    // Credit cards first (standalone)
    let text = scrubCreditCards(file.content, file.path, findings);

    // All other rules
    for (const rule of RULES) {
      text = text.replace(rule.pattern, (match, ..._args) => {
        // The last arg of String.replace callbacks is the offset; but
        // TypeScript types it loosely. Walk backward to find the number.
        const allArgs = _args;
        const offset = typeof allArgs[allArgs.length - 2] === "number"
          ? (allArgs[allArgs.length - 2] as number)
          : 0;
        const { line, column } = lineColumn(file.content, offset);
        const replacement =
          typeof rule.replacement === "function"
            ? rule.replacement(match)
            : rule.replacement;
        findings.push({
          file: file.path,
          line,
          column,
          rule: rule.name,
          severity: rule.severity,
          snippet: truncate(match),
          replacement,
        });
        return replacement;
      });
    }
  }

  const overallSeverity = overallSeverityOf(findings);
  return { overallSeverity, findings, filesScanned, filesExcluded };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isExcluded(relPath: string): boolean {
  const posix = relPath.replace(/\\/g, "/");
  const segments = posix.split("/").filter(Boolean);
  const basename = segments[segments.length - 1] ?? "";
  if (EXCLUDED_FILENAMES.has(basename)) return true;
  for (const pattern of EXCLUDED_FILENAME_PATTERNS) {
    if (pattern.test(basename)) return true;
  }
  // Any ancestor dir excluded?
  for (let i = 0; i < segments.length - 1; i++) {
    if (EXCLUDED_DIRS.has(segments[i]!)) return true;
  }
  return false;
}

function lineColumn(text: string, offset: number): { line: number; column: number } {
  // 1-indexed
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lastNewline = i;
    }
  }
  const column = offset - lastNewline;
  return { line, column };
}

function truncate(s: string, limit = 120): string {
  const collapsed = s.replace(/\n/g, "\\n");
  return collapsed.length <= limit ? collapsed : collapsed.slice(0, limit) + "…";
}

function overallSeverityOf(findings: Finding[]): ScrubResult["overallSeverity"] {
  if (findings.some((f) => f.severity === "block")) return "block";
  if (findings.some((f) => f.severity === "warn")) return "warn";
  return "clean";
}
