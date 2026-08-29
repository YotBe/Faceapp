import { expect, test } from "vitest";

process.env["DATABASE_URL"] ??= "postgres://localhost/unused";
process.env["APP_SECRET"] ??= "test-secret-not-used-anywhere-real";

const { makeSlug, summariseSearches } = await import("../events");
type SearchRecord = import("../events").SearchRecord;

test("slugs are not guessable from the event name", () => {
  const a = makeSlug("Smith Wedding");
  const b = makeSlug("Smith Wedding");
  expect(a).not.toBe(b);
  expect(a).toMatch(/^smith-wedding-[0-9a-f]{10}$/);
});

test("slugs satisfy the database's format constraint", () => {
  // Mirrors events_slug_check in the schema. A slug the app can generate but
  // the database refuses is an event that cannot be created at all.
  const pattern = /^[a-z0-9]([a-z0-9-]{4,62})[a-z0-9]$/;
  for (const name of [
    "Smith Wedding",
    "  ...  ",
    "ÉVÉNEMENT",
    "a",
    "A very long event name that goes on and on and should be truncated safely",
  ]) {
    const slug = makeSlug(name);
    expect(slug, `rejected by the schema: ${slug}`).toMatch(pattern);
    expect(slug.length).toBeLessThanOrEqual(64);
  }
});

/**
 * The run report's arithmetic.
 *
 * This is the instrument you read after a live run to find out whether the
 * product worked, so the two numbers that matter are the count of searches that
 * came back empty and the best score among them. A near miss and a stranger look
 * identical from the attendee's side — "I got nothing" — and only this tells
 * them apart.
 */

const log = (over: Partial<SearchRecord> = {}): SearchRecord => ({
  created_at: "2026-08-28T10:00:00Z",
  outcome: "ok",
  results_returned: 4,
  maybe_returned: 0,
  top_score: 0.62,
  duration_ms: 1400,
  ...over,
});

test("an empty log summarises to zeroes rather than NaN", () => {
  expect(summariseSearches([])).toMatchObject({
    total: 0,
    found: 0,
    empty: 0,
    medianDurationMs: null,
    bestMiss: null,
  });
});

test("outcomes are counted separately", () => {
  const summary = summariseSearches([
    log(),
    log(),
    log({ outcome: "no_match", results_returned: 0, top_score: 0.41 }),
    log({ outcome: "rate_limited", top_score: null }),
    log({ outcome: "rejected_quality", top_score: null }),
    log({ outcome: "error", top_score: null }),
  ]);

  expect(summary).toMatchObject({
    total: 6,
    found: 2,
    empty: 1,
    rateLimited: 1,
    poorCapture: 1,
    failed: 1,
  });
});

test("the best miss is the highest score among searches that found nothing", () => {
  const summary = summariseSearches([
    log({ outcome: "no_match", top_score: 0.31 }),
    log({ outcome: "no_match", top_score: 0.48 }),
    // A successful search scoring higher must not be mistaken for a miss.
    log({ outcome: "ok", top_score: 0.71 }),
  ]);

  expect(summary.bestMiss).toBe(0.48);
});

test("a miss with no score at all does not become a zero", () => {
  // rate_limited and rejected_quality rows carry no score. Averaging them in as
  // 0 would drag the number down and hide a real near miss.
  const summary = summariseSearches([
    log({ outcome: "no_match", top_score: null }),
    log({ outcome: "no_match", top_score: 0.45 }),
  ]);

  expect(summary.bestMiss).toBe(0.45);
});

test("duration is the median, so one cold start does not describe the run", () => {
  const summary = summariseSearches([
    log({ duration_ms: 1200 }),
    log({ duration_ms: 1300 }),
    // A sleeping container waking up. The mean would be over 20 seconds and
    // would describe no search that actually happened.
    log({ duration_ms: 61000 }),
  ]);

  expect(summary.medianDurationMs).toBe(1300);
});

test("rows with no duration are skipped rather than counted as instant", () => {
  const summary = summariseSearches([
    log({ duration_ms: null }),
    log({ duration_ms: 2000 }),
  ]);

  expect(summary.medianDurationMs).toBe(2000);
});
