import { expect, test } from "vitest";

process.env["DATABASE_URL"] ??= "postgres://localhost/unused";
process.env["APP_SECRET"] ??= "test-secret-not-used-anywhere-real";

const { assertSafeKey, assertSafeBucket, signKey, verifySignature, storage, LocalStorage } =
  await import("../storage");

/**
 * Signed URLs are the only thing between an attendee link and permanent public
 * access to somebody's photographs, so the failure cases get more attention
 * here than the happy path.
 */

const soon = () => Math.floor(Date.now() / 1000) + 900;

test("a valid signature verifies", () => {
  const exp = soon();
  const sig = signKey("event-photos", "abc/def.webp", exp);
  expect(verifySignature("event-photos", "abc/def.webp", exp, sig)).toBe(true);
});

test("an expired signature is refused however valid it was", () => {
  const past = Math.floor(Date.now() / 1000) - 1;
  const sig = signKey("event-photos", "a.webp", past);
  expect(verifySignature("event-photos", "a.webp", past, sig)).toBe(false);
});

test("a signature for one key does not work for another", () => {
  const exp = soon();
  const sig = signKey("event-photos", "mine.webp", exp);
  expect(verifySignature("event-photos", "yours.webp", exp, sig)).toBe(false);
});

test("a signature cannot be moved to another bucket", () => {
  const exp = soon();
  const sig = signKey("event-photos", "a.webp", exp);
  expect(verifySignature("other-bucket", "a.webp", exp, sig)).toBe(false);
});

test("extending the expiry invalidates the signature", () => {
  const exp = soon();
  const sig = signKey("event-photos", "a.webp", exp);
  expect(verifySignature("event-photos", "a.webp", exp + 3600, sig)).toBe(false);
});

test("a malformed signature is refused rather than throwing", () => {
  const exp = soon();
  expect(verifySignature("event-photos", "a.webp", exp, "")).toBe(false);
  expect(verifySignature("event-photos", "a.webp", exp, "short")).toBe(false);
  expect(verifySignature("event-photos", "a.webp", Number.NaN, "x")).toBe(false);
});

test("path traversal is refused", () => {
  for (const key of [
    "../etc/passwd",
    "a/../../b",
    "/absolute",
    "with\0null",
    "spaces are not allowed",
    "",
  ]) {
    expect(() => assertSafeKey(key), `accepted: ${key}`).toThrow(
      /unsafe storage key/,
    );
  }
});

test("ordinary keys and buckets are accepted", () => {
  expect(() => assertSafeKey("2f3a-11ee/originals/deadbeef.jpg")).not.toThrow();
  expect(() => assertSafeBucket("event-photos")).not.toThrow();
  expect(() => assertSafeBucket("Event Photos")).toThrow(/unsafe bucket/);
});


// ---------------------------------------------------------------------------
// Driver selection
// ---------------------------------------------------------------------------

test("without R2 configured, the local driver is used", () => {
  expect(storage().kind).toBe("local");
  expect(storage()).toBeInstanceOf(LocalStorage);
});

test("the local driver keeps every key inside its bucket", async () => {
  const local = new LocalStorage("/tmp/faceapp-test-root");
  expect(local.path("event-photos", "a/b.webp")).toBe(
    "/tmp/faceapp-test-root/event-photos/a/b.webp",
  );
  expect(() => local.path("event-photos", "../../escape")).toThrow();
});
