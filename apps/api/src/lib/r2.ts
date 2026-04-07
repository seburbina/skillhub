/**
 * R2 helpers — uses the native R2 binding (no AWS SDK needed).
 *
 * The binding is set in wrangler.toml as `SKILLS_BUCKET`. The Worker
 * accesses it as `env.SKILLS_BUCKET.put(...)` etc. — direct in-network
 * calls, no signing required, no public-internet round-trip, zero egress.
 *
 * For pre-signed URLs (so an arbitrary HTTP client can download a skill
 * without going through the Worker), we use `aws4fetch` against R2's
 * S3-compatible endpoint. That requires the R2 access key id + secret
 * (different credentials than the binding).
 */
import { AwsClient } from "aws4fetch";
import type { Bindings } from "@/types";

/** Build the canonical R2 key for a skill version. */
export function skillVersionKey(slug: string, semver: string): string {
  return `skills/${slug}/v${semver}.skill`;
}

/** Upload an object via the R2 binding. Direct, in-network. */
export async function putSkill(
  bucket: R2Bucket,
  key: string,
  body: ArrayBuffer | Uint8Array,
  contentType = "application/zip",
): Promise<void> {
  await bucket.put(key, body, {
    httpMetadata: { contentType },
  });
}

/**
 * Generate a short-lived presigned GET URL for a skill version.
 *
 * Used by the download endpoint to redirect agents directly to R2 so the
 * Worker isn't in the bandwidth path.
 */
export async function signedDownloadUrl(
  env: Bindings,
  key: string,
): Promise<string> {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error(
      "R2 S3-API credentials not configured (R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY)",
    );
  }
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  // Bucket name is whichever the binding points at — we don't know that
  // from the binding alone, so the env var BUCKET_NAME is also read.
  const bucketName =
    env.ENVIRONMENT === "production"
      ? "skillhub-skills-prod"
      : "skillhub-skills-dev";
  const ttl = Number(env.SIGNED_URL_TTL ?? 300);
  const url = `https://${bucketName}.${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${key}?X-Amz-Expires=${ttl}`;
  const signed = await client.sign(url, { method: "GET", aws: { signQuery: true } });
  return signed.url;
}
