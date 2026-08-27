import { expect, test } from "vitest";

process.env["DATABASE_URL"] ??= "postgres://localhost/unused";
process.env["APP_SECRET"] ??= "test-secret-not-used-anywhere-real";

const { rank, signUrls } = await import("../search");
const { bucketOf } = await import("../thresholds");

const T = { tHigh: 0.5, tLow: 0.4, trusted: true, source: "test" };

interface Row {
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

function face(over: Partial<Row> & { photo_id: string; similarity: number }): Row {
  return {
    quality_tier: 2,
    face_px: 120,
    bbox: { x: 400, y: 300, w: 120, h: 140 },
    preview_key: `${over.photo_id}.preview.webp`,
    thumb_key: `${over.photo_id}.thumb.webp`,
    width: 1200,
    height: 900,
    taken_at: null,
    ...over,
  };
}

test("a photo is scored by its best matching face", () => {
  const out = rank(
    [
      face({ photo_id: "p1", similarity: 0.42 }),
      face({ photo_id: "p1", similarity: 0.81 }),
      face({ photo_id: "p1", similarity: 0.55 }),
    ],
    T,
  );
  expect(out.confident.length).toBe(1);
  expect(out.confident[0]!.score).toBe(0.81);
  expect(out.confident[0]!.faceMatches).toBe(3);
});

test("a tier-1 face can never reach the confident set, however well it scores", () => {
  const out = rank([face({ photo_id: "p1", similarity: 0.99, quality_tier: 1 })], T);
  expect(out.confident.length).toBe(0);
  expect(out.maybe.length).toBe(1);
});

test("scores below t_low are dropped entirely", () => {
  const out = rank([face({ photo_id: "p1", similarity: 0.39 })], T);
  expect(out.confident.length + out.maybe.length).toBe(0);
});

test("the confident and maybe buckets are disjoint", () => {
  const out = rank(
    [
      face({ photo_id: "high", similarity: 0.7 }),
      face({ photo_id: "mid", similarity: 0.45 }),
      face({ photo_id: "low", similarity: 0.1 }),
    ],
    T,
  );
  expect(out.confident.map((m) => m.photoId)).toEqual(["high"]);
  expect(out.maybe.map((m) => m.photoId)).toEqual(["mid"]);
});

test("prominence reorders near-ties but never changes the bucket", () => {
  // Same similarity; one is a large central face, the other small and at the edge.
  const out = rank(
    [
      face({
        photo_id: "crowd",
        similarity: 0.62,
        bbox: { x: 20, y: 20, w: 45, h: 50 },
      }),
      face({
        photo_id: "portrait",
        similarity: 0.61,
        bbox: { x: 520, y: 300, w: 300, h: 340 },
      }),
    ],
    T,
  );
  expect(out.confident.length).toBe(2);
  expect(
    out.confident[0]!.photoId,
    "the photo where they are the subject should come first",
  ).toBe("portrait");
  // Both stay confident: prominence is ordering only.
  expect(out.confident.every((m) => m.bucket === "confident")).toBeTruthy();
});

test("prominence cannot promote a photo across the threshold", () => {
  // A hugely prominent face just below t_high must stay in "maybe".
  const out = rank(
    [
      face({
        photo_id: "big-but-uncertain",
        similarity: 0.49,
        bbox: { x: 300, y: 200, w: 600, h: 600 },
      }),
    ],
    T,
  );
  expect(out.confident.length).toBe(0);
  expect(out.maybe.length).toBe(1);
});

test("ranking is pure: it produces keys, not URLs", () => {
  // Signing is I/O — presigning an R2 object is asynchronous — so it is a
  // separate step. This keeps the ranking logic testable with no storage.
  const out = rank([face({ photo_id: "p1", similarity: 0.8 })], T);
  expect(out.confident[0]!.thumbKey).toBe("p1.thumb.webp");
  expect(out.confident[0]!.thumbUrl).toBeNull();
});

test("signing produces expiring URLs and drops the keys", async () => {
  const signed = await signUrls(rank([face({ photo_id: "p1", similarity: 0.8 })], T));
  const url = signed.confident[0]!.thumbUrl!;

  expect(url).toMatch(/^\/api\/files\/event-photos\//);
  expect(url).toMatch(/[?&]exp=\d+/);
  expect(url).toMatch(/[?&]sig=/);

  // The raw key never reaches the browser: it would leak the storage layout
  // and, unlike the URL, it does not expire.
  expect(signed.confident[0]!.thumbKey).toBeNull();
  expect(signed.confident[0]!.previewKey).toBeNull();
});

test("bucket boundaries are inclusive at the threshold", () => {
  expect(bucketOf(0.5, 2, T)).toBe("confident");
  expect(bucketOf(0.4999, 2, T)).toBe("maybe");
  expect(bucketOf(0.4, 2, T)).toBe("maybe");
  expect(bucketOf(0.3999, 2, T)).toBe("reject");
});
