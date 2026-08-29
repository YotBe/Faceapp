import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "./env";

/**
 * A link that survives closing the tab.
 *
 * Results currently exist only in the open page. Everyone closes it, and then
 * their photographs are gone unless they search again — which, given the rate
 * limit, several of them cannot.
 *
 * **The whole result set lives in the URL**, signed, not in a table. That is the
 * point rather than a shortcut:
 *
 *   - There is no record joining a person to the photographs they were found
 *     in. Storing one would be a new pile of personal data with its own
 *     retention question, created for a convenience.
 *   - Nothing survives the event: the link cannot outlive the album, because
 *     the photographs it names are deleted by `run_retention` and the route
 *     resolves ids at request time rather than trusting the URL.
 *   - Nothing to clean up, and no way for a stale row to hand someone a
 *     photograph after they asked to be forgotten. The token names the *faces*
 *     that matched rather than the photographs, so an opt-out that purges a face
 *     also stops every link that depended on it — the registry is applied when
 *     the link is opened, not only when it was made.
 *
 * The signature is what stops the obvious attack, which is not forgery of the
 * whole token but editing it: a photo id swapped for another id in the same
 * album would otherwise hand a stranger's photograph to whoever tried it.
 *
 * Layout, all big-endian:
 *
 *     version   u8      always 1
 *     expiry    u32     unix seconds
 *     event     16      uuid bytes
 *     count     u8
 *     photos    16 * n  uuid bytes
 *     mac       16      HMAC-SHA256 of everything above, truncated
 */

const VERSION = 1;
const MAC_BYTES = 16;

/**
 * Enough for anyone's night out, and short enough that the URL survives being
 * pasted into a messaging app. Beyond this the link carries the first 60 and
 * says so rather than being silently truncated.
 */
export const MAX_LINKED_PHOTOS = 60;

export class BadResultLink extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadResultLink";
  }
}

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32 || !/^[0-9a-f]{32}$/i.test(hex)) {
    throw new BadResultLink(`not a uuid: ${uuid}`);
  }
  return Buffer.from(hex, "hex");
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function mac(payload: Buffer): Buffer {
  return createHmac("sha256", env.secret).update(payload).digest().subarray(0, MAC_BYTES);
}

export interface ResultLink {
  eventId: string;
  /**
   * The faces that matched, not the photographs they are in.
   *
   * This is what lets the link be re-checked against the opt-out registry when
   * it is opened: a face purged by an opt-out simply no longer resolves, so a
   * link issued beforehand stops showing that photograph. Photo ids would have
   * survived the purge and kept working.
   */
  faceIds: string[];
  expiresAt: number;
}

/**
 * @param ttlSeconds how long the link works for. Defaults to a week: long
 * enough to be useful the morning after, short enough that a link forwarded
 * onward months later is already dead.
 */
export function signResultLink(
  eventId: string,
  faceIds: string[],
  ttlSeconds = 7 * 24 * 3600,
): string {
  const ids = faceIds.slice(0, MAX_LINKED_PHOTOS);
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;

  const payload = Buffer.alloc(1 + 4 + 16 + 1 + ids.length * 16);
  payload.writeUInt8(VERSION, 0);
  payload.writeUInt32BE(expiry, 1);
  uuidToBytes(eventId).copy(payload, 5);
  payload.writeUInt8(ids.length, 21);
  ids.forEach((id, i) => uuidToBytes(id).copy(payload, 22 + i * 16));

  return Buffer.concat([payload, mac(payload)]).toString("base64url");
}

export function verifyResultLink(token: string): ResultLink {
  let raw: Buffer;
  try {
    raw = Buffer.from(token, "base64url");
  } catch {
    throw new BadResultLink("that link is not readable");
  }

  if (raw.length < 22 + MAC_BYTES) throw new BadResultLink("that link is too short");

  const payload = raw.subarray(0, raw.length - MAC_BYTES);
  const supplied = raw.subarray(raw.length - MAC_BYTES);
  const expected = mac(payload);

  // Length is fixed by construction, so timingSafeEqual cannot throw here — but
  // the comparison itself has to be constant time, because a byte-at-a-time
  // comparison against a signature is forgeable given enough attempts.
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new BadResultLink("that link has been altered");
  }

  if (payload.readUInt8(0) !== VERSION) {
    throw new BadResultLink("that link was made by an older version");
  }

  const expiresAt = payload.readUInt32BE(1);
  if (expiresAt * 1000 <= Date.now()) {
    throw new BadResultLink("that link has expired");
  }

  const count = payload.readUInt8(21);
  if (payload.length !== 22 + count * 16) {
    throw new BadResultLink("that link is malformed");
  }

  const faceIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    faceIds.push(bytesToUuid(payload.subarray(22 + i * 16, 38 + i * 16)));
  }

  return { eventId: bytesToUuid(payload.subarray(5, 21)), faceIds, expiresAt };
}
