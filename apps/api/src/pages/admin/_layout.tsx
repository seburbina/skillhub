/** @jsxImportSource hono/jsx */
import type { Child, FC } from "hono/jsx";

interface AdminLayoutProps {
  title: string;
  children: Child;
}

/**
 * Admin shell — minimal, no public header/footer. A red banner reminds
 * the operator they're on the privileged surface. All auth happens at
 * the edge via Cloudflare Access; the Worker trusts the host.
 */
export const AdminLayout: FC<AdminLayoutProps> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} — skillhub admin</title>
      <meta name="robots" content="noindex, nofollow" />
      <link rel="stylesheet" href="/globals.css" />
      <style>{`
        .admin-banner {
          background: #b91c1c; color: white; padding: 10px 16px;
          font: 600 13px/1.4 -apple-system, system-ui, sans-serif;
          letter-spacing: 0.04em; text-transform: uppercase;
        }
        .admin-banner a { color: white; text-decoration: underline; margin-right: 18px }
        .admin-container { max-width: 1100px; margin: 24px auto; padding: 0 16px; font: 14px/1.5 -apple-system, system-ui, sans-serif }
        .admin-container h1 { font-size: 22px; margin: 8px 0 18px }
        .admin-container h2 { font-size: 16px; margin: 24px 0 8px }
        .admin-table { width: 100%; border-collapse: collapse; font-size: 13px }
        .admin-table th, .admin-table td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #e5e7eb; vertical-align: top }
        .admin-table th { background: #f9fafb; font-weight: 600 }
        .admin-table code { font-family: ui-monospace, Menlo, monospace; font-size: 12px }
        .chip { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600 }
        .chip-open { background:#fef3c7; color:#92400e }
        .chip-resolved { background:#d1fae5; color:#065f46 }
        .chip-reviewing { background:#dbeafe; color:#1e40af }
        .chip-dismissed { background:#e5e7eb; color:#374151 }
        .chip-yanked { background:#fee2e2; color:#991b1b }
        .muted { color: #6b7280 }
        .stub { background:#fef3c7; padding:8px 12px; border-radius:6px; font-size:12px; color:#92400e; margin: 12px 0 }
      `}</style>
    </head>
    <body>
      <div class="admin-banner">
        ADMIN ·{" "}
        <a href="/queue">Moderation queue</a>
        <a href="/agent">Agent lookup</a>
        <a href="/skill">Skill lookup</a>
        <span class="muted" style="margin-left:auto">read-only v1</span>
      </div>
      <main class="admin-container">{children}</main>
    </body>
  </html>
);
