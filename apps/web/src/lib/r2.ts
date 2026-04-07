/**
 * Cloudflare R2 client — S3-compatible put + signed GET URLs.
 */
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY ?? "";
export const R2_BUCKET = process.env.R2_BUCKET ?? "skillhub-skills-dev";
const R2_SIGNED_URL_TTL = Number(process.env.R2_SIGNED_URL_TTL ?? 300);

let client: S3Client | null = null;

function getClient(): S3Client {
  if (client) return client;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error("R2 credentials are not configured.");
  }
  client = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  return client;
}

/** Upload an object and return its key. */
export async function putObject(
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<string> {
  const c = getClient();
  await c.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return key;
}

/** Generate a short-lived GET URL for a stored object. */
export async function signedDownloadUrl(key: string): Promise<string> {
  const c = getClient();
  return getSignedUrl(
    c,
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
    { expiresIn: R2_SIGNED_URL_TTL },
  );
}

/** Delete an object (used by yank). */
export async function deleteObject(key: string): Promise<void> {
  const c = getClient();
  await c.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}

/** Build the canonical R2 key for a skill version. */
export function skillVersionKey(slug: string, semver: string): string {
  return `skills/${slug}/v${semver}.skill`;
}
