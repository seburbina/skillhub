/**
 * Shared HTTP helpers for API routes.
 *
 * Keeps error shapes consistent across every route. The base skill's
 * api-reference.md documents this exact shape, so don't drift from it.
 */
import { NextResponse } from "next/server";
import { ZodError } from "zod";

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

const STATUS: Record<ErrorCode, number> = {
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
  code: ErrorCode,
  message: string,
  opts: {
    hint?: string;
    retryAfterSeconds?: number;
    findings?: unknown;
    details?: unknown;
    headers?: Record<string, string>;
  } = {},
): NextResponse<ErrorBody> {
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
  const headers = new Headers(opts.headers ?? {});
  if (code === "rate_limited" && opts.retryAfterSeconds !== undefined) {
    headers.set("Retry-After", String(opts.retryAfterSeconds));
  }
  return NextResponse.json(body, { status: STATUS[code], headers });
}

/** Convert a ZodError into a structured invalid_input response. */
export function zodError(error: ZodError): NextResponse<ErrorBody> {
  return errorResponse("invalid_input", "Request body failed validation.", {
    details: error.issues,
  });
}

/** Wrap a route handler with uniform error handling. */
export function withErrorHandler<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (e) {
      if (e instanceof ZodError) return zodError(e);
      console.error("[api] unhandled error:", e);
      return errorResponse("server_error", "Internal server error.");
    }
  };
}
