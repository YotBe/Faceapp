import { expect, test } from "vitest";

process.env["DATABASE_URL"] ??= "postgres://localhost/unused";
process.env["APP_SECRET"] = "test-secret-for-result-links-only";

const { signResultLink, verifyResultLink, BadResultLink, MAX_LINKED_PHOTOS } =
  await import("../resultlink");

/**
 * The keep-link is the one place in this product where a result set travels
 * outside the request that produced it. Nothing is stored behind it, so the
 * signature is the only thing standing between a link and a way to read
 * somebody else's photographs out of the same album — and the attack is not
 * forging a whole token, it is editing one you were legitimately given.
 */

const EVENT = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
const FACES = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

test("a link round-trips the event and the faces it was made from", () => {
  const link = verifyResultLink(signResultLink(EVENT, FACES));

  expect(link.eventId).toBe(EVENT);
  expect(link.faceIds).toEqual(FACES);
  expect(link.expiresAt * 1000).toBeGreaterThan(Date.now());
});

test("it survives being pasted somewhere URL-safe", () => {
  const token = signResultLink(EVENT, FACES);

  // base64url, so no +, / or = to be mangled by a messaging app or a shell.
  expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(encodeURIComponent(token)).toBe(token);
});

test("editing any byte is refused", () => {
  // The real attack: take a link you were given, change a face id to another id
  // from the same album, and collect a stranger's photographs. Every byte is
  // covered, not just the ids — a shifted expiry or a swapped event would each
  // be their own hole.
  const token = signResultLink(EVENT, FACES);
  const raw = Buffer.from(token, "base64url");

  for (let i = 0; i < raw.length; i += 1) {
    const tampered = Buffer.from(raw);
    tampered[i] = tampered[i]! ^ 0x01;
    expect(() => verifyResultLink(tampered.toString("base64url"))).toThrow(BadResultLink);
  }
});

test("an expired link is refused", () => {
  const token = signResultLink(EVENT, FACES, -1);

  expect(() => verifyResultLink(token)).toThrow(/expired/);
});

test("a link signed with a different secret does not verify", () => {
  const token = signResultLink(EVENT, FACES);

  // A rotated APP_SECRET invalidates every outstanding link, which is the
  // intended behaviour: rotating it is what you do after a leak, and a link
  // that survived the rotation would make the rotation pointless.
  process.env["APP_SECRET"] = "a-completely-different-secret-value";
  try {
    expect(() => verifyResultLink(token)).toThrow(BadResultLink);
  } finally {
    process.env["APP_SECRET"] = "test-secret-for-result-links-only";
  }

  expect(verifyResultLink(token).eventId).toBe(EVENT);
});

test("a truncated link is refused rather than read as something shorter", () => {
  const raw = Buffer.from(signResultLink(EVENT, FACES), "base64url");

  expect(() => verifyResultLink(raw.subarray(0, raw.length - 8).toString("base64url"))).toThrow(
    BadResultLink,
  );
  expect(() => verifyResultLink("")).toThrow(BadResultLink);
  expect(() => verifyResultLink("not-a-token")).toThrow(BadResultLink);
});

test("an empty result set still produces a verifiable link", () => {
  // Not reachable through the search route, which only makes a link when there
  // is something in it — but a zero-length payload must not read as malformed.
  expect(verifyResultLink(signResultLink(EVENT, [])).faceIds).toEqual([]);
});

test("more faces than the cap are trimmed, and the trim is visible", () => {
  const many = Array.from(
    { length: MAX_LINKED_PHOTOS + 20 },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  );

  const link = verifyResultLink(signResultLink(EVENT, many));

  // Trimmed rather than rejected, and the caller is told how many made it so it
  // can say "the first 60" instead of showing a count that disagrees with the
  // page the link opens.
  expect(link.faceIds).toHaveLength(MAX_LINKED_PHOTOS);
  expect(link.faceIds).toEqual(many.slice(0, MAX_LINKED_PHOTOS));
});

test("a token stays short enough to be a link", () => {
  const many = Array.from(
    { length: MAX_LINKED_PHOTOS },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  );

  // Uuids are packed as 16 raw bytes rather than 36 characters of hex for this
  // reason. Well inside what every browser and messaging app accepts.
  expect(signResultLink(EVENT, many).length).toBeLessThan(1500);
});

test("something that is not a uuid is refused at signing, not at opening", () => {
  expect(() => signResultLink("not-a-uuid", FACES)).toThrow(BadResultLink);
  expect(() => signResultLink(EVENT, ["nope"])).toThrow(BadResultLink);
});
