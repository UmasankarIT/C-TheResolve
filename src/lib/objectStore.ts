import { randomUUID } from 'crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';

/**
 * Object storage for citizen photos and proof-of-work images.
 *
 * Why this exists: every issue photo used to be stored as a base64 `data:` URL
 * inside Postgres (`issues.image_url`, `issue_reports.image_url`). A citizen
 * upload is resized to 1280x1280 WebP in the browser (MediaUpload.tsx), which
 * is ~100-200 KB of base64 text per report, and a proof-of-work photo is an
 * unresized original that can be several megabytes. The shared ISSUE_SELECT
 * fragment then dragged `image_url` and `resolution_proof_url` into all seven
 * issue queries, so the feed, map, admin portal and analytics all moved image
 * blobs row by row. That does not survive contact with a real pilot.
 *
 * So the bytes live in an S3-compatible bucket and Postgres keeps only a
 * short `/api/images/<key>` path. Both are valid values for an <img src>, so
 * the UI needed no changes.
 *
 * Targets MinIO locally (docker-compose) and any S3/GCS bucket in production
 * via S3_ENDPOINT. If no bucket is configured, or the upload fails, we fall
 * back to keeping the original `data:` URL. That mirrors how the codebase
 * already degrades elsewhere (Gemini -> heuristic classifier, data.gov.in ->
 * curated baseline): the reporting flow must never break because a storage
 * dependency is unavailable.
 *
 * Keys carry a random component because the image route is deliberately
 * public -- GET /api/issues is unauthenticated, so gating images behind a
 * session would render broken thumbnails for anonymous feed visitors. Issue
 * ids are `iss-<epoch-millis>` and therefore trivially enumerable, so a
 * predictable key would let anyone walk the archive.
 */

const BUCKET = process.env.S3_BUCKET || 'civicresolve';
const ENDPOINT = process.env.S3_ENDPOINT || 'http://civic-minio:9000';
const REGION = process.env.S3_REGION || 'us-east-1';

let client: S3Client | null = null;
let bucketReady: Promise<void> | null = null;

export function isObjectStoreConfigured(): boolean {
  return Boolean(process.env.S3_BUCKET || process.env.S3_ENDPOINT);
}

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      region: REGION,
      // MinIO and most self-hosted gateways need an explicit endpoint and
      // path-style addressing; GCS ignores endpoint when it is unset.
      ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || 'minioadmin',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || 'miniopassword',
      },
    });
  }
  return client;
}

/**
 * MinIO does not create buckets on first upload, so make sure it exists.
 * Memoised: called on the first write and then reused for the process
 * lifetime. A failure is not cached, so a store that starts before MinIO is
 * ready will retry on the next request rather than stay broken forever.
 */
async function ensureBucket(): Promise<void> {
  if (!bucketReady) {
    bucketReady = (async () => {
      const s3 = getClient();
      try {
        await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
      } catch {
        try {
          await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
          console.log(`[objects] created bucket ${BUCKET}`);
        } catch (err) {
          // Someone else created it between the HEAD and the CREATE, or the
          // bucket already exists in a provider that reports that as an error.
          const code = (err as { name?: string })?.name || '';
          if (code !== 'BucketAlreadyOwnedByYou' && code !== 'BucketAlreadyExists') {
            throw err;
          }
        }
      }
    })().catch((err) => {
      bucketReady = null;
      throw err;
    });
  }
  return bucketReady;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
};

/** Public path written into Postgres. Same-origin, so <img src> just works. */
export function publicImagePath(key: string): string {
  return `/api/images/${key}`;
}

export interface ParsedDataUrl {
  buffer: Buffer;
  contentType: string;
}

/** Decode a `data:<mime>;base64,<payload>` URL into bytes. */
export function parseDataUrl(dataUrl: string): ParsedDataUrl | null {
  const m = dataUrl.match(/^data:([A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+)?;base64,([\s\S]+)$/);
  if (!m) return null;
  const contentType = m[1] || 'application/octet-stream';
  try {
    return { buffer: Buffer.from(m[2], 'base64'), contentType };
  } catch {
    return null;
  }
}

/**
 * Move a data URL into the bucket and return the `/api/images/...` path.
 *
 * Returns the input unchanged when the value is not a data URL (already a
 * path, or empty) or when the upload fails, so callers can assign the result
 * unconditionally.
 */
export async function storeImageDataUrl(
  dataUrl: string,
  folder: 'issue' | 'proof'
): Promise<string> {
  if (!dataUrl) return dataUrl;
  if (!dataUrl.startsWith('data:')) return dataUrl; // already a stored path
  if (!isObjectStoreConfigured()) {
    // No bucket configured: keep the inline data URL (works, just not scalable).
    return dataUrl;
  }

  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    console.warn('[objects] value looked like a data URL but could not be parsed; storing inline');
    return dataUrl;
  }
  if (!parsed.contentType.startsWith('image/')) {
    // Refuse non-image payloads rather than serving them from the image route.
    console.warn(`[objects] refusing to store non-image content type ${parsed.contentType}`);
    return dataUrl;
  }

  const ext = EXT_BY_MIME[parsed.contentType] || 'bin';
  const key = `${folder}/${randomUUID()}.${ext}`;

  try {
    await ensureBucket();
    await getClient().send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: parsed.buffer,
        ContentType: parsed.contentType,
        // Objects are immutable and addressed randomly, so cache them hard.
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );
    return publicImagePath(key);
  } catch (err) {
    console.error('[objects] upload failed, keeping inline data URL:', err);
    return dataUrl;
  }
}

export interface FetchedImage {
  buffer: Buffer;
  contentType: string;
}

export async function fetchImage(key: string): Promise<FetchedImage | null> {
  try {
    await ensureBucket();
    const res = await getClient().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    if (!res.Body) return null;
    const bytes = await res.Body.transformToByteArray();
    return {
      buffer: Buffer.from(bytes),
      contentType: res.ContentType || 'application/octet-stream',
    };
  } catch (err) {
    const name = (err as { name?: string })?.name || '';
    if (name === 'NoSuchKey' || name === 'NotFound') return null;
    console.error('[objects] read failed:', err);
    return null;
  }
}

/**
 * Reject anything that is not a plain object key. The route concatenates this
 * into a bucket read, so `..` segments or an absolute path must never survive.
 */
export function isSafeObjectKey(key: string): boolean {
  if (!key || key.length > 200) return false;
  if (key.startsWith('/') || key.includes('//') || key.includes('\\')) return false;
  if (key.includes('..')) return false;
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(key)) return false;
  return /^[a-z]+\/[A-Za-z0-9._-]+\.[A-Za-z0-9]+$/.test(key);
}
