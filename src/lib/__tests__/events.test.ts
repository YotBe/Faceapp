import { expect, test } from "vitest";

process.env["DATABASE_URL"] ??= "postgres://localhost/unused";
process.env["APP_SECRET"] ??= "test-secret-not-used-anywhere-real";

const { makeSlug } = await import("../events");

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
