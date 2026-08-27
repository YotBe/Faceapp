import { createHash, randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";
import { asOperator, serviceTransaction } from "@/lib/db";
import { BUCKET, storage } from "@/lib/storage";

/**
 * Album upload.
 *
 * Files arrive in batches rather than as one enormous request, because a 100GB
 * album cannot be a single POST and a browser that loses its connection at 94%
 * must not have to start over. The client sends concurrent batches and retries
 * the ones that fail; this endpoint is the unit of retry, which is why it has to
 * be idempotent.
 *
 * Idempotency has two halves, and both are in the database rather than here:
 * `(event_id, storage_key)` is unique so re-sending a file cannot create a
 * second photo row, and `ingest_jobs.photo_id` is unique so it cannot create a
 * second job. Re-uploading an entire album is therefore a no-op, which is the
 * Phase 2 acceptance criterion.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_FILES_PER_REQUEST = 25;
const MAX_BYTES_PER_REQUEST = 120 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const { id: eventId } = await context.params;

  // Ownership is checked through RLS: this select returns nothing unless the
  // signed-in operator owns the event.
  const event = await asOperator(session.operatorId, async (db) => {
    const { rows } = await db.query<{ id: string; status: string }>(
      "select id, status from events where id = $1",
      [eventId],
    );
    return rows[0] ?? null;
  });
  if (!event) return NextResponse.json({ error: "no such event" }, { status: 404 });

  const form = await request.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File);

  if (files.length === 0) {
    return NextResponse.json({ error: "no files" }, { status: 400 });
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return NextResponse.json({ error: "too many files in one batch" }, { status: 400 });
  }
  if (files.reduce((n, f) => n + f.size, 0) > MAX_BYTES_PER_REQUEST) {
    return NextResponse.json({ error: "batch too large" }, { status: 413 });
  }

  const accepted: string[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const file of files) {
    if (!ALLOWED.has(file.type)) {
      skipped.push({ name: file.name, reason: `unsupported type ${file.type || "unknown"}` });
      continue;
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const hash = createHash("sha256").update(bytes).digest("hex");
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "jpg";
    const safeExtension = /^[a-z0-9]{1,5}$/.test(extension) ? extension : "jpg";

    // Content-addressed, so the same file uploaded twice lands on the same key
    // and the unique constraint does the deduplication for us.
    const key = `${eventId}/originals/${hash}.${safeExtension}`;

    await storage().put(BUCKET, key, bytes, file.type);

    const inserted = await serviceTransaction(async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into photos (id, event_id, storage_bucket, storage_key, bytes, content_hash)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (event_id, storage_key) do nothing
         returning id`,
        [randomUUID(), eventId, BUCKET, key, bytes.length, hash],
      );
      const photo = rows[0];
      if (!photo) return null;

      await db.query(
        `insert into ingest_jobs (photo_id, event_id) values ($1, $2)
         on conflict (photo_id) do nothing`,
        [photo.id, eventId],
      );
      await db.query(
        "update events set photo_count = photo_count + 1, status = 'indexing' where id = $1",
        [eventId],
      );
      return photo.id;
    });

    if (inserted) accepted.push(file.name);
    else skipped.push({ name: file.name, reason: "already uploaded" });
  }

  return NextResponse.json({ accepted: accepted.length, skipped });
}
