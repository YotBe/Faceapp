import { ZipArchive } from "archiver";
import { NextResponse } from "next/server";
import { Readable } from "node:stream";

import { asService } from "@/lib/db";
import { BUCKET, storage } from "@/lib/storage";

/**
 * Download a selection of photographs as a zip.
 *
 * Only photo ids the caller already received from a search are downloadable —
 * except that the server has no memory of what it returned, so it cannot check
 * that. What it does instead is the thing that actually matters: it never
 * accepts a request for an entire album. The caller must name each photograph,
 * the count is capped, and every id is checked to belong to the named event.
 * Someone who has scraped valid ids can download those photographs; someone who
 * has not cannot enumerate them.
 *
 * Streams rather than buffers. A 200-photo selection at 4MB each is 800MB, and
 * building that in memory would take the process down.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PHOTOS = 300;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    slug?: string;
    photoIds?: string[];
  } | null;

  const slug = body?.slug;
  const photoIds = body?.photoIds ?? [];

  if (!slug || photoIds.length === 0) {
    return NextResponse.json({ error: "nothing selected" }, { status: 400 });
  }
  if (photoIds.length > MAX_PHOTOS) {
    return NextResponse.json(
      { error: `at most ${MAX_PHOTOS} photographs at a time` },
      { status: 400 },
    );
  }
  if (!photoIds.every((id) => /^[0-9a-f-]{36}$/i.test(id))) {
    return NextResponse.json({ error: "bad photo id" }, { status: 400 });
  }

  const rows = await asService(async (db) => {
    const { rows } = await db.query<{
      id: string;
      storage_key: string;
      preview_key: string | null;
    }>(
      `select p.id, p.storage_key, p.preview_key
         from photos p
         join events e on e.id = p.event_id
        where e.slug = $1 and e.delete_after > now()
          and e.status = 'ready'
          and p.id = any($2::uuid[])
          and p.status = 'done'`,
      [slug, photoIds],
    );
    return rows;
  });

  if (rows.length === 0) {
    return NextResponse.json({ error: "nothing to download" }, { status: 404 });
  }

  // level 0: JPEG and WebP are already compressed, so deflate spends CPU to
  // save nothing. Store-only keeps a 300-photo zip cheap to produce.
  const archive = new ZipArchive({ zlib: { level: 0 }, store: true });
  const driver = storage();

  for (const row of rows) {
    // The watermarked preview, not the original. Releasing originals is the
    // operator's decision to make, not a side effect of finding yourself.
    const key = row.preview_key ?? row.storage_key;
    const name = `${row.id.slice(0, 8)}.${key.split(".").pop() ?? "webp"}`;
    archive.append(await driver.getStream(BUCKET, key), { name });
  }
  void archive.finalize();

  return new NextResponse(
    Readable.toWeb(archive) as unknown as ReadableStream,
    {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="photos.zip"`,
        "cache-control": "no-store",
      },
    },
  );
}
