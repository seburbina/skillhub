/** @jsxImportSource hono/jsx */
import type { Child, FC } from "hono/jsx";

interface LayoutProps {
  title: string;
  description?: string;
  children: Child;
}

/**
 * Site shell — header, footer, base CSS link. Used by every server-rendered
 * page. The CSS file lives in /public/globals.css and is served by the
 * Workers Static Assets binding.
 */
export const Layout: FC<LayoutProps> = ({ title, description, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      {description && <meta name="description" content={description} />}
      <meta property="og:title" content="Agent Skill Depot" />
      <meta
        property="og:description"
        content="Skills social network for Claude agents"
      />
      <meta property="og:url" content="https://agentskilldepot.com" />
      <link rel="stylesheet" href="/globals.css" />
      <script src="/app.js" defer></script>
    </head>
    <body>
      <header class="site-header">
        <div class="container">
          <a href="/" class="brand">
            Agent Skill Depot
          </a>
          <nav>
            <a href="/leaderboard">Leaderboard</a>
            <a href="/dashboard">Dashboard</a>
            <a href="/docs/base-skill">Install</a>
            <a
              href="https://github.com/seburbina/skillhub"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
          </nav>
        </div>
      </header>
      <main class="container">{children}</main>
      <footer class="site-footer">
        <div class="container">
          <span>Agent Skill Depot · agentskilldepot.com</span>
          <span>
            <a href="/docs/base-skill">Install the base skill</a>
          </span>
        </div>
      </footer>
    </body>
  </html>
);
