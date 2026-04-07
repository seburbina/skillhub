// Diagnostic route — pure Node, zero imports beyond Next types.
// If this works but /api/v1/health on nodejs runtime doesn't, the issue
// is in our shared module graph. If this also hangs, the issue is in
// Vercel project/runtime configuration.

export const runtime = "nodejs";

export function GET() {
  return new Response(
    JSON.stringify({ pong: true, ts: Date.now() }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}
