import { NextResponse } from "next/server";

import { hashIp } from "@/lib/auth";
import { asService, serviceTransaction } from "@/lib/db";
import { env } from "@/lib/env";
import { EnrollmentFailed, MlServiceUnavailable, enroll } from "@/lib/mlclient";
import { searchEvent } from "@/lib/search";
import { UntunedThresholdError, loadThresholds } from "@/lib/thresholds";

/**
 * Attendee search.
 *
 * Runs under the service role because the attendee has no account and never
 * touches the database — that is a product decision (no signup, no app) and a
 * privacy one (there is no attendee record to breach). Everything RLS would
 * have enforced is enforced here instead: the event is looked up by slug, and
 * every subsequent query is scoped to the id that lookup returned.
 *
 * The order of operations is the compliance story:
 *
 *   rate limit -> enroll -> search -> DESTROY -> audit -> respond
 *
 * The frames and the template they produce never touch a table. They exist as
 * local variables for the length of one request and are gone before the
 * response is written, with a `deletion_audit` row recording how long that took
 * against the 60-second promise in docs/COMPLIANCE.md.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FRAMES = 5;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "0.0.0.0";
}

export async function POST(request: Request) {
  const startedAt = Date.now();

  let thresholds;
  try {
    thresholds = await loadThresholds();
  } catch (error) {
    if (error instanceof UntunedThresholdError) {
      // 503, not 500: the service is correctly configured and deliberately
      // refusing, and the operator needs to see why.
      return NextResponse.json(
        { error: "search_unavailable", detail: error.message },
        { status: 503 },
      );
    }
    throw error;
  }

  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "expected multipart form data" }, { status: 400 });
  }

  const slug = String(form.get("slug") ?? "");
  const frames = form.getAll("frames").filter((f): f is File => f instanceof File);

  if (!slug) {
    return NextResponse.json({ error: "missing event" }, { status: 400 });
  }
  if (frames.length === 0) {
    return NextResponse.json({ error: "no frames captured" }, { status: 400 });
  }
  if (frames.length > MAX_FRAMES) {
    return NextResponse.json({ error: "too many frames" }, { status: 400 });
  }
  if (frames.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_BYTES) {
    return NextResponse.json({ error: "frames too large" }, { status: 413 });
  }

  const ipHash = hashIp(clientIp(request));

  const event = await asService(async (db) => {
    const { rows } = await db.query<{
      id: string;
      name: string;
      status: string;
      is_youth_event: boolean;
      youth_attestation_at: string | null;
    }>(
      `select id, name, status, is_youth_event, youth_attestation_at
         from events where slug = $1 and delete_after > now()`,
      [slug],
    );
    return rows[0] ?? null;
  });

  if (!event) {
    return NextResponse.json({ error: "that album is not available" }, { status: 404 });
  }
  if (event.status !== "ready") {
    return NextResponse.json(
      { error: "this album is still being prepared — try again shortly" },
      { status: 409 },
    );
  }
  // A youth-flagged event cannot be searched until the organizer has attested
  // that parental consent was handled. The database refuses to let it reach
  // 'ready' without one; this is the second lock on the same door.
  if (event.is_youth_event && !event.youth_attestation_at) {
    return NextResponse.json(
      { error: "this album is not open for search" },
      { status: 403 },
    );
  }

  // --- rate limit -------------------------------------------------------
  const recent = await asService(async (db) => {
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from search_logs
        where event_id = $1 and ip_hash = $2
          and created_at > now() - interval '1 hour'
          and outcome <> 'rate_limited'`,
      [event.id, ipHash],
    );
    return Number(rows[0]?.count ?? 0);
  });

  if (recent >= env.searchRateLimit) {
    await logSearch({
      eventId: event.id,
      ipHash,
      outcome: "rate_limited",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json(
      {
        error: `that is ${env.searchRateLimit} searches in an hour from this device. ` +
          `Searches are logged. Try again later.`,
      },
      { status: 429 },
    );
  }

  // --- enroll -----------------------------------------------------------
  let enrollment;
  try {
    enrollment = await enroll(frames.map((f) => f as unknown as Blob));
  } catch (error) {
    if (error instanceof EnrollmentFailed) {
      await logSearch({
        eventId: event.id,
        ipHash,
        outcome: "rejected_quality",
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: error.message, warnings: error.warnings },
        { status: 422 },
      );
    }
    if (error instanceof MlServiceUnavailable) {
      await logSearch({
        eventId: event.id,
        ipHash,
        outcome: "error",
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: "face matching is temporarily unavailable", detail: error.message },
        { status: 503 },
      );
    }
    throw error;
  }

  // --- search -----------------------------------------------------------
  const outcome = await serviceTransaction((db) =>
    searchEvent(db, {
      eventId: event.id,
      embedding: enrollment.embedding,
      thresholds,
    }),
  );

  // --- destroy ----------------------------------------------------------
  // The template is dropped here, before anything is written and before the
  // response is built. `frames` are File handles over the request body, which
  // goes out of scope with this function. Nothing was persisted at any point.
  const embeddingLength = enrollment.embedding.length;
  enrollment.embedding.length = 0;
  const elapsedMs = Date.now() - startedAt;

  await asService(async (db) => {
    await db.query("select log_selfie_deletion($1, $2, $3, $4)", [
      event.id,
      elapsedMs,
      enrollment.framesUsed,
      "search",
    ]);
  });

  await logSearch({
    eventId: event.id,
    ipHash,
    outcome: outcome.confident.length + outcome.maybe.length > 0 ? "ok" : "no_match",
    resultsReturned: outcome.confident.length,
    maybeReturned: outcome.maybe.length,
    topScore: outcome.topScore,
    durationMs: elapsedMs,
  });

  return NextResponse.json({
    event: { name: event.name, slug },
    confident: outcome.confident,
    maybe: outcome.maybe,
    framesUsed: enrollment.framesUsed,
    warnings: enrollment.warnings,
    // The client renders a banner when this is false. It is in the payload
    // rather than only in a config file so it cannot be forgotten by a
    // deployment that builds the UI separately.
    thresholdsTrusted: thresholds.trusted,
    selfieDeleted: { embeddingLength, elapsedMs, withinSla: elapsedMs <= 60_000 },
  });
}

async function logSearch(entry: {
  eventId: string;
  ipHash: string;
  outcome: string;
  resultsReturned?: number;
  maybeReturned?: number;
  topScore?: number | null;
  durationMs: number;
}) {
  await asService(async (db) => {
    await db.query(
      `insert into search_logs
         (event_id, ip_hash, results_returned, maybe_returned, top_score, duration_ms, outcome)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.eventId,
        entry.ipHash,
        entry.resultsReturned ?? 0,
        entry.maybeReturned ?? 0,
        entry.topScore ?? null,
        entry.durationMs,
        entry.outcome,
      ],
    );
  });
}
