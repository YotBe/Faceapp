import type { Db } from "./db";
import { toVector } from "./mlclient";
import { BUCKET, storage } from "./storage";
import { bucketOf, type Thresholds } from "./thresholds";

/**
 * The search itself.
 *
 * Scored per face, returned per photograph. An attendee sees a grid of
 * photographs, not a list of faces, so one good match in a photo full of
 * strangers means that photo is theirs.
 */

export interface MatchedPhoto {
  photoId: string;
  /**
   * The best-scoring face in this photograph — the one that made it a match.
   *
   * Carried so a keep-link can be re-checked against the opt-out registry when
   * it is opened rather than only when it was made. Without it, a link issued
   * before somebody opted out would keep working afterwards.
   */
  faceId: string;
  /** Storage keys. Turned into expiring URLs by `signUrls`, never returned raw. */
  previewKey: string | null;
  thumbKey: string | null;
  previewUrl: string | null;
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
  takenAt: string | null;
  score: number;
  bucket: "confident" | "maybe";
  /** How many faces in this photo matched. Almost always 1. */
  faceMatches: number;
  /** Similarity plus the prominence boost. Ordering only, never thresholding. */
  rankScore: number;
}

export interface SearchOutcome {
  confident: MatchedPhoto[];
  maybe: MatchedPhoto[];
  topScore: number | null;
  facesConsidered: number;
}

interface FaceRow {
  face_id: string;
  photo_id: string;
  similarity: number;
  quality_tier: number;
  face_px: number;
  bbox: { x: number; y: number; w: number; h: number };
  preview_key: string | null;
  thumb_key: string | null;
  width: number | null;
  height: number | null;
  taken_at: string | null;
}

/** How many nearest faces to pull before thresholding. */
const CANDIDATE_LIMIT = 500;

/**
 * Does this server's pgvector support `hnsw.iterative_scan`?
 *
 * It matters because an approximate HNSW scan combined with a
 * `where event_id = $1` filter post-filters: a top-k query can return far fewer
 * than k rows for the event even though more exist, so an attendee silently
 * loses photographs. pgvector 0.8 added iterative scan to fix precisely that.
 *
 * Setting it blindly on an older server is worse than not setting it. `hnsw` is
 * a reserved GUC prefix, but only once pgvector has been loaded into the
 * backend — so on a pooled connection the first search succeeds (the extension
 * has not loaded yet when the SET runs) and every subsequent search on that
 * same connection fails with "invalid configuration parameter name", aborting
 * the transaction. A bug that appears only from the second request onward, only
 * on a reused connection, is not one to leave in.
 *
 * Resolved once per process and cached.
 */
let iterativeScanSupport: Promise<boolean> | null = null;

function supportsIterativeScan(db: Db): Promise<boolean> {
  iterativeScanSupport ??= db
    .query<{ supported: boolean }>(
      `select coalesce(
                (select extversion from pg_extension where extname = 'vector')
                >= '0.8.0', false) as supported`,
    )
    .then((result) => result.rows[0]?.supported ?? false)
    .catch(() => false);
  return iterativeScanSupport;
}

/**
 * A face this close to an opt-out registration is treated as that person and
 * dropped from the results.
 *
 * Deliberately far below any matching threshold: an opt-out is a person saying
 * "do not show me", and the failure that matters is showing them anyway. Being
 * too eager here costs a few photographs of someone who looks similar; being too
 * conservative breaks a promise we made in the privacy notice.
 */
const EXCLUSION_RADIUS = 0.32;

export async function searchEvent(
  db: Db,
  {
    eventId,
    embedding,
    thresholds,
  }: { eventId: string; embedding: number[]; thresholds: Thresholds },
): Promise<SearchOutcome> {
  const vector = toVector(embedding);

  // pgvector's `<=>` is cosine *distance*; similarity is 1 - distance. The
  // embeddings on both sides are L2-normalized, which is what makes that
  // identity hold and what the HNSW index was built assuming.
  if (await supportsIterativeScan(db)) {
    await db.query("set local hnsw.iterative_scan = relaxed_order");
  }

  const { rows } = await db.query<FaceRow>(
    `
    select f.id as face_id,
           f.photo_id,
           1 - (f.embedding <=> $1::vector) as similarity,
           f.quality_tier, f.face_px, f.bbox,
           p.preview_key, p.thumb_key, p.width, p.height,
           p.taken_at
      from faces f
      join photos p on p.id = f.photo_id
     where f.event_id = $2
       and p.status = 'done'
       -- The opt-out registry. Anyone who asked not to be findable is removed
       -- here, before thresholds, so no threshold change can ever expose them.
       and not exists (
         select 1 from exclusions x
          where x.event_id = f.event_id
            and (x.embedding <=> f.embedding) < $3
       )
     order by f.embedding <=> $1::vector
     limit $4
    `,
    [vector, eventId, EXCLUSION_RADIUS, CANDIDATE_LIMIT],
  );

  return signUrls(rank(rows, thresholds));
}

/**
 * The photographs a set of already-matched faces belong to.
 *
 * This is how a keep-link resolves. It re-runs the *only* part of the search
 * that can change between issuing a link and opening it: the opt-out registry.
 * The predicate below is the same one `searchEvent` applies, deliberately in
 * this file beside it — two copies of it would drift, and the way that drift
 * shows up is somebody who asked not to be findable still being found through a
 * link issued before they asked.
 *
 * No thresholds and no ranking, because both already happened. These faces were
 * in the confident set when the link was made, and re-scoring them now would
 * need the selfie, which was destroyed within a second of the search that
 * produced them.
 */
export async function photosForFaces(
  db: Db,
  eventId: string,
  faceIds: string[],
): Promise<MatchedPhoto[]> {
  if (faceIds.length === 0) return [];

  const { rows } = await db.query<{
    face_id: string;
    photo_id: string;
    preview_key: string | null;
    thumb_key: string | null;
    width: number | null;
    height: number | null;
    taken_at: string | null;
  }>(
    `
    select f.id as face_id, f.photo_id,
           p.preview_key, p.thumb_key, p.width, p.height, p.taken_at
      from faces f
      join photos p on p.id = f.photo_id
     where f.id = any($1::uuid[])
       and f.event_id = $2
       and p.status = 'done'
       and not exists (
         select 1 from exclusions x
          where x.event_id = f.event_id
            and (x.embedding <=> f.embedding) < $3
       )
     order by p.taken_at nulls last, p.id
    `,
    [faceIds, eventId, EXCLUSION_RADIUS],
  );

  const photos: MatchedPhoto[] = rows.map((row) => ({
    photoId: row.photo_id,
    faceId: row.face_id,
    previewKey: row.preview_key,
    thumbKey: row.thumb_key,
    previewUrl: null,
    thumbUrl: null,
    width: row.width,
    height: row.height,
    takenAt: row.taken_at,
    // The scores are not re-derivable and are not shown on this page. Reporting
    // a made-up one would be worse than reporting none.
    score: 0,
    rankScore: 0,
    bucket: "confident" as const,
    faceMatches: 1,
  }));

  const signed = await signUrls({
    confident: photos,
    maybe: [],
    topScore: null,
    facesConsidered: photos.length,
  });
  return signed.confident;
}

/**
 * Replace storage keys with expiring URLs.
 *
 * Separate from `rank` because ranking is pure arithmetic and signing is I/O —
 * presigning an R2 object is asynchronous, and mixing the two would make the
 * ranking logic untestable without a storage back end.
 */
export async function signUrls(outcome: SearchOutcome): Promise<SearchOutcome> {
  const driver = storage();

  const sign = async (photo: MatchedPhoto) => {
    photo.previewUrl = photo.previewKey
      ? await driver.signedUrl(BUCKET, photo.previewKey)
      : null;
    photo.thumbUrl = photo.thumbKey
      ? await driver.signedUrl(BUCKET, photo.thumbKey)
      : null;
    // The keys are an internal detail; handing them to a browser would leak the
    // storage layout and outlive the signature.
    photo.previewKey = null;
    photo.thumbKey = null;
  };

  await Promise.all([...outcome.confident, ...outcome.maybe].map(sign));
  return outcome;
}

export function rank(rows: FaceRow[], thresholds: Thresholds): SearchOutcome {
  // Group by photograph, keeping the best-scoring face in each.
  const best = new Map<string, { row: FaceRow; score: number; count: number }>();

  for (const row of rows) {
    const score = Number(row.similarity);
    const bucket = bucketOf(score, row.quality_tier, thresholds);
    if (bucket === "reject") continue;

    const existing = best.get(row.photo_id);
    if (!existing) {
      best.set(row.photo_id, { row, score, count: 1 });
    } else {
      existing.count += 1;
      if (score > existing.score) {
        existing.row = row;
        existing.score = score;
      }
    }
  }

  const confident: MatchedPhoto[] = [];
  const maybe: MatchedPhoto[] = [];

  for (const { row, score, count } of best.values()) {
    const bucket = bucketOf(score, row.quality_tier, thresholds);
    if (bucket === "reject") continue;

    const photo: MatchedPhoto = {
      photoId: row.photo_id,
      faceId: row.face_id,
      rankScore: score + prominenceBoost(row),
      previewKey: row.preview_key,
      thumbKey: row.thumb_key,
      previewUrl: null,
      thumbUrl: null,
      width: row.width,
      height: row.height,
      takenAt: row.taken_at,
      score,
      bucket,
      faceMatches: count,
    };
    (bucket === "confident" ? confident : maybe).push(photo);
  }

  confident.sort(byRank);
  maybe.sort(byRank);

  const topScore = rows.length ? Math.max(...rows.map((r) => Number(r.similarity))) : null;

  return {
    confident,
    maybe,
    topScore,
    facesConsidered: rows.length,
  };
}

/**
 * How much to favour a photograph where this person is the subject.
 *
 * A shot where they are large and central is worth more to them than one where
 * they are a face in the crowd, even if the crowd shot scores marginally
 * higher. Capped at 0.05 so it only ever reorders near-ties — a genuinely
 * better match always wins.
 *
 * This affects ordering ONLY. Thresholding happens on the raw similarity, so
 * prominence can never promote a photograph into the confident set. That
 * separation is the point: the confident set is a precision guarantee, and
 * nothing cosmetic is allowed to reach into it.
 */
function prominenceBoost(row: FaceRow): number {
  if (!row.width || !row.height) return 0;

  // Face height as a fraction of image height, saturating at a third.
  const size = Math.min(row.bbox.h / row.height, 0.33) / 0.33;

  // 1 at dead centre, 0 at the edge.
  const cx = (row.bbox.x + row.bbox.w / 2) / row.width;
  const cy = (row.bbox.y + row.bbox.h / 2) / row.height;
  const offCentre = Math.hypot(cx - 0.5, cy - 0.5) / Math.hypot(0.5, 0.5);
  const centrality = 1 - Math.min(offCentre, 1);

  return 0.05 * (0.6 * size + 0.4 * centrality);
}

function byRank(a: MatchedPhoto, b: MatchedPhoto): number {
  return b.rankScore - a.rankScore;
}

export { CANDIDATE_LIMIT, EXCLUSION_RADIUS };
