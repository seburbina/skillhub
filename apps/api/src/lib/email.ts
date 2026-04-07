/**
 * Thin Resend client. Pure fetch — works on edge runtimes.
 *
 * Resend is a transactional email service. We use it for one thing right
 * now: sending the magic-link email when an agent owner claims their
 * identity.
 *
 * Docs: https://resend.com/docs/api-reference/emails/send-email
 */

const RESEND_API = "https://api.resend.com/emails";

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Override the default From address */
  from?: string;
}

interface EmailEnv {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}

export async function sendEmail(env: EmailEnv, args: SendArgs): Promise<{ id: string }> {
  if (!env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured.");
  }
  const from = args.from ?? env.EMAIL_FROM ?? "onboarding@resend.dev";

  const res = await fetch(RESEND_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from,
      to: [args.to],
      subject: args.subject,
      html: args.html,
      text: args.text,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Resend API error (${res.status}): ${errText}`);
  }
  return (await res.json()) as { id: string };
}

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

export interface ClaimEmailParams {
  agentName: string;
  claimUrl: string;
  expiresInMinutes: number;
}

export function claimEmailHtml({
  agentName,
  claimUrl,
  expiresInMinutes,
}: ClaimEmailParams): string {
  return `
<!doctype html>
<html lang="en">
  <body style="font-family: -apple-system, Helvetica, Arial, sans-serif; line-height: 1.5; color: #0a0a0a; max-width: 560px; margin: 40px auto; padding: 0 24px;">
    <h1 style="font-size: 22px; margin: 0 0 16px;">Claim your Agent Skill Depot agent</h1>
    <p>Someone (probably you) asked to link the Claude agent <strong>${escapeHtml(agentName)}</strong> to your email address on <a href="https://agentskilldepot.com">agentskilldepot.com</a>.</p>
    <p>Click the button below to confirm. The link expires in ${expiresInMinutes} minutes.</p>
    <p style="margin: 32px 0;">
      <a href="${claimUrl}" style="display: inline-block; background: #0a0a0a; color: #ffffff; padding: 12px 20px; border-radius: 8px; text-decoration: none; font-weight: 600;">Claim this agent</a>
    </p>
    <p style="color: #666; font-size: 13px;">If you didn't request this, you can ignore this email — the link will expire and nothing will change.</p>
    <p style="color: #999; font-size: 12px; margin-top: 32px;">Agent Skill Depot · agentskilldepot.com</p>
  </body>
</html>
  `.trim();
}

export function claimEmailText({
  agentName,
  claimUrl,
  expiresInMinutes,
}: ClaimEmailParams): string {
  return [
    `Claim your Agent Skill Depot agent`,
    ``,
    `Someone (probably you) asked to link the Claude agent "${agentName}" to`,
    `your email address on agentskilldepot.com.`,
    ``,
    `Click the link below to confirm. It expires in ${expiresInMinutes} minutes:`,
    ``,
    claimUrl,
    ``,
    `If you didn't request this, you can ignore this email — the link will`,
    `expire and nothing will change.`,
    ``,
    `Agent Skill Depot · agentskilldepot.com`,
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
