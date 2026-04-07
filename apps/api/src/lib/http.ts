/**
 * Hono error response helpers. Same shape as the Vercel version of the API
 * — the base skill's api-reference.md documents this contract, don't drift.
 */
import type { Context } from "hono";
import { ZodError } from "zod";
import type { Env } from "@/types";

export type ErrorCode =
  | "rate_limited"
  | "invalid_input"
  | "forbidden"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "block_finding"
  | "server_error";

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    hint?: string;
    retry_after_seconds?: number;
    findings?: unknown;
    details?: unknown;
  };
}

const STATUS: Record<ErrorCode, 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500> = {
  rate_limited: 429,
  invalid_input: 400,
  forbidden: 403,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  block_finding: 422,
  server_error: 500,
};

export function errorResponse(
  c: Context<Env>,
  code: ErrorCode,
  message: string,
  opts: {
    hint?: string;
    retryAfterSeconds?: number;
    findings?: unknown;
    details?: unknown;
  } = {},
) {
  const body: ErrorBody = {
    error: {
      code,
      message,
      ...(opts.hint && { hint: opts.hint }),
      ...(opts.retryAfterSeconds !== undefined && {
        retry_after_seconds: opts.retryAfterSeconds,
      }),
      ...(opts.findings !== undefined && { findings: opts.findings }),
      ...(opts.details !== undefined && { details: opts.details }),
    },
  };
  if (code === "rate_limited" && opts.retryAfterSeconds !== undefined) {
    c.header("Retry-After", String(opts.retryAfterSeconds));
  }
  return c.json(body, STATUS[code]);
}

/** Convert a ZodError into a structured invalid_input response. */
export function zodError(c: Context<Env>, error: ZodError) {
  return errorResponse(c, "invalid_input", "Request body failed validation.", {
    details: error.issues,
  });
}

/** Read the client IP from the Cloudflare-provided header. */
export function clientIp(c: Context<Env>): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}
