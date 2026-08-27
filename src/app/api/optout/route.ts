import { NextResponse } from "next/server";

import { asService, serviceTransaction } from "@/lib/db";
import { EnrollmentFailed, enroll, toVector } from "@/lib/mlclient";
import { EXCLUSION_RADIUS } from "@/lib/search";

/**
 * Opt-out.
 *
 * Anyone can remove themselves from an album without holding an account and
 * without proving who they are — asking for identification would defeat the
 * point, since the person asking not to be in a face database is exactly the
 * person who should not have to hand over more identity to get out of it.
 *
 * Two things happen, and both are necessary:
 *
 *   1. Every face vector in this album that matches is deleted. That removes
 *      them from existing search results.
 *   2. The embedding is stored in `exclusions`. That keeps them out of FUTURE
 *      results, including after a re-index that would otherwise recompute the
 *      vectors we just deleted.
 *
 * Step 2 means retaining a biometric template for someone who asked us not to
 * process them, which looks like the opposite of honouring the request. It is
 * the only way to enforce it, it is scoped to this one event, no operator can
 * read it, and it dies with the album. That reasoning belongs in the privacy
 * notice in plain words — see docs/COMPLIANCE.md §7.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "expected multipart form data" }, { status: 400 });
  }

  const slug = String(form.get("slug") ?? "");
  const frames = form.getAll("frames").filter((f): f is File => f instanceof File);

  if (!slug || frames.length === 0) {
    return NextResponse.json({ error: "missing event or frames" }, { status: 400 });
  }

  const event = await asService(async (db) => {
    const { rows } = await db.query<{ id: string; name: string }>(
      "select id, name from events where slug = $1 and delete_after > now()",
      [slug],
    );
    return rows[0] ?? null;
  });
  if (!event) {
    return NextResponse.json({ error: "that album is not available" }, { status: 404 });
  }

  let enrollment;
  try {
    enrollment = await enroll(frames.map((f) => f as unknown as Blob));
  } catch (error) {
    if (error instanceof EnrollmentFailed) {
      return NextResponse.json(
        { error: error.message, warnings: error.warnings },
        { status: 422 },
      );
    }
    throw error;
  }

  const vector = toVector(enrollment.embedding);

  const { facesRemoved, photosAffected } = await serviceTransaction(async (db) => {
    const { rows: removed } = await db.query<{ photo_id: string }>(
      `delete from faces
        where event_id = $1
          and (embedding <=> $2::vector) < $3
        returning photo_id`,
      [event.id, vector, EXCLUSION_RADIUS],
    );

    await db.query(
      "insert into exclusions (event_id, embedding) values ($1, $2::vector)",
      [event.id, vector],
    );

    await db.query(
      "update events set face_count = greatest(0, face_count - $2) where id = $1",
      [event.id, removed.length],
    );

    await db.query(
      `insert into deletion_audit (event_id, kind, actor, details)
       values ($1, 'exclusion_purge', 'attendee', $2::jsonb)`,
      [
        event.id,
        JSON.stringify({
          faces_deleted: removed.length,
          photos_affected: new Set(removed.map((r) => r.photo_id)).size,
          radius: EXCLUSION_RADIUS,
        }),
      ],
    );

    return {
      facesRemoved: removed.length,
      photosAffected: new Set(removed.map((r) => r.photo_id)).size,
    };
  });

  // The template used to find them is dropped here. The copy in `exclusions` is
  // the only one that survives, and only to keep them out.
  enrollment.embedding.length = 0;

  return NextResponse.json({
    event: event.name,
    facesRemoved,
    photosAffected,
    message:
      "You have been removed from this album. Future searches will not return you.",
  });
}
