import { NextRequest, NextResponse } from 'next/server';
import { fetchImage, isSafeObjectKey } from '@/lib/objectStore';

export const dynamic = 'force-dynamic';

/**
 * GET /api/images/<key>
 *
 * Streams a stored citizen photo or proof-of-work image out of the object
 * bucket. Postgres holds the `/api/images/<key>` path in place of the old
 * base64 data URL, so this is what every <img src> in the app resolves to.
 *
 * Deliberately unauthenticated: GET /api/issues is public, so the neighbourhood
 * feed is browsable without signing in and its thumbnails have to render for
 * anonymous visitors. Citizen photos reach this route only through unguessable
 * random keys -- issue ids are `iss-<epoch-millis>` and would otherwise be
 * trivially enumerable. If you need photos gated behind a session, that also
 * means gating the issue feed.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { key: string[] } }
) {
  const key = Array.isArray(params?.key) ? params.key.join('/') : '';

  if (!isSafeObjectKey(key)) {
    return NextResponse.json({ error: 'Invalid image key.' }, { status: 400 });
  }

  const image = await fetchImage(key);
  if (!image) {
    return NextResponse.json({ error: 'Image not found.' }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(image.buffer), {
    status: 200,
    headers: {
      'Content-Type': image.contentType,
      'Content-Length': String(image.buffer.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
