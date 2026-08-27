import { randomBytes, randomUUID } from "node:crypto";

import { asOperator, type Db } from "./db";

/**
 * Event creation and the operator's view of an album.
 */

export interface EventSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  photo_count: number;
  face_count: number;
  faces_rejected: number;
  delete_after: string;
  jurisdiction_code: string;
  is_youth_event: boolean;
  youth_attestation_at: string | null;
  created_at: string;
}

export interface IngestProgress {
  pending: number;
  running: number;
  done: number;
  failed: number;
}

/**
 * Slugs are random, not derived from the event name.
 *
 * A slug is the public URL of an album. `smith-wedding-2026` is guessable and
 * `smith-wedding-2027` is the next one along, which turns "share this link with
 * your guests" into "anyone can enumerate our customers' events". 40 bits of
 * randomness after a short readable prefix keeps it typeable without being
 * walkable.
 */
export function makeSlug(name: string): string {
  const prefix =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "event";
  return `${prefix}-${randomBytes(5).toString("hex")}`.slice(0, 62);
}

export async function listEvents(operatorId: string): Promise<EventSummary[]> {
  return asOperator(operatorId, async (db) => {
    const { rows } = await db.query<EventSummary>(
      `select id, name, slug, status, photo_count, face_count, faces_rejected,
              delete_after, jurisdiction_code, is_youth_event,
              youth_attestation_at, created_at
         from events order by created_at desc`,
    );
    return rows;
  });
}

export async function getEvent(
  operatorId: string,
  eventId: string,
): Promise<EventSummary | null> {
  return asOperator(operatorId, async (db) => {
    const { rows } = await db.query<EventSummary>(
      `select id, name, slug, status, photo_count, face_count, faces_rejected,
              delete_after, jurisdiction_code, is_youth_event,
              youth_attestation_at, created_at
         from events where id = $1`,
      [eventId],
    );
    return rows[0] ?? null;
  });
}

export async function createEvent(
  operatorId: string,
  input: {
    name: string;
    jurisdiction: string;
    retentionDays: number;
    isYouthEvent: boolean;
    consentNoticeUrl?: string;
  },
): Promise<EventSummary> {
  const name = input.name.trim();
  if (!name) throw new Error("the event needs a name");

  const days = Math.round(input.retentionDays);
  if (!Number.isFinite(days) || days < 1 || days > 180) {
    throw new Error("retention must be between 1 and 180 days");
  }

  return asOperator(operatorId, async (db) => {
    const { rows } = await db.query<EventSummary>(
      `insert into events
         (id, operator_id, name, slug, delete_after, jurisdiction_code,
          is_youth_event, consent_notice_url, status)
       values ($1, $2, $3, $4, now() + make_interval(days => $5), $6, $7, $8, 'draft')
       returning id, name, slug, status, photo_count, face_count, faces_rejected,
                 delete_after, jurisdiction_code, is_youth_event,
                 youth_attestation_at, created_at`,
      [
        randomUUID(),
        operatorId,
        name,
        makeSlug(name),
        days,
        input.jurisdiction,
        input.isYouthEvent,
        input.consentNoticeUrl?.trim() || null,
      ],
    );
    return rows[0]!;
  });
}

export async function ingestProgress(
  db: Db,
  eventId: string,
): Promise<IngestProgress> {
  const { rows } = await db.query<{ state: string; count: string }>(
    `select state, count(*)::text as count from ingest_jobs
      where event_id = $1 group by state`,
    [eventId],
  );
  const progress: IngestProgress = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const row of rows) {
    if (row.state in progress) {
      progress[row.state as keyof IngestProgress] = Number(row.count);
    }
  }
  return progress;
}

export interface FailedPhoto {
  id: string;
  storage_key: string;
  error: string | null;
}

export async function failedPhotos(
  db: Db,
  eventId: string,
): Promise<FailedPhoto[]> {
  const { rows } = await db.query<FailedPhoto>(
    `select id, storage_key, error from photos
      where event_id = $1 and status = 'failed'
      order by storage_key limit 100`,
    [eventId],
  );
  return rows;
}

export async function listJurisdictions() {
  const { asService } = await import("./db");
  return asService(async (db) => {
    const { rows } = await db.query<{
      code: string;
      name: string;
      allowed: boolean;
      reason: string;
    }>("select code, name, allowed, reason from jurisdictions order by allowed desc, name");
    return rows;
  });
}
