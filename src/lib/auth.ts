import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { createHmac } from "node:crypto";
import { cookies } from "next/headers";

import { asService } from "./db";
import { env } from "./env";

/**
 * Operator authentication.
 *
 * THE SEAM. On a Supabase deployment this module is replaced by `@supabase/ssr`
 * and `operator_credentials` goes unused — identity becomes Supabase Auth's
 * problem, which is where it belongs. Everything else in the app depends only on
 * `getSession()` returning an operator id, so that swap does not reach any other
 * file.
 *
 * What is here is a real implementation, not a stub: scrypt with per-row
 * parameters, HMAC-signed session cookies, constant-time comparison. An app that
 * cannot be run without a cloud account is an app whose tests are all mocks.
 *
 * Attendees have no account and never appear here. That is a product decision
 * (no signup, no app install) and a privacy one — there is no attendee record to
 * breach.
 */

/**
 * `promisify` picks the 3-argument overload of scrypt, which drops the cost
 * parameters. Wrapping it by hand keeps N, r and p — without them this silently
 * becomes scrypt at its defaults, which is a much weaker hash than the stored
 * parameters claim.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

const SESSION_COOKIE = "faceapp_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  // Parameters travel with the digest so they can be raised later without
  // invalidating every existing password.
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltB64, hashB64] = parts as [
    string, string, string, string, string, string,
  ];
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");

  const derived = await scrypt(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

interface SessionPayload {
  sub: string;
  email: string;
  exp: number;
}

function sign(value: string): string {
  return createHmac("sha256", env.secret).update(value).digest("base64url");
}

function encodeSession(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function decodeSession(token: string): SessionPayload | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = Buffer.from(sign(body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as SessionPayload;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export interface Session {
  operatorId: string;
  email: string;
}

export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = decodeSession(token);
  if (!payload) return null;
  return { operatorId: payload.sub, email: payload.email };
}

export async function startSession(operatorId: string, email: string) {
  const token = encodeSession({
    sub: operatorId,
    email,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProduction,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function endSession() {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function registerOperator(
  email: string,
  password: string,
): Promise<Session> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new Error("that does not look like an email address");
  }
  if (password.length < 10) {
    throw new Error("password must be at least 10 characters");
  }

  const passwordHash = await hashPassword(password);
  const id = randomUUID();

  return asService(async (db) => {
    const existing = await db.query(
      "select 1 from operator_credentials where email = $1",
      [normalized],
    );
    if (existing.rowCount) throw new Error("that email is already registered");

    // On Supabase, auth.users is managed by Supabase Auth and this insert is
    // refused — which is correct, because there you would be using Supabase Auth
    // instead of this module.
    await db.query(
      "insert into auth.users (id, email) values ($1, $2) on conflict do nothing",
      [id, normalized],
    );
    await db.query(
      "insert into operator_credentials (user_id, email, password_hash) values ($1, $2, $3)",
      [id, normalized, passwordHash],
    );
    return { operatorId: id, email: normalized };
  });
}

export async function authenticate(
  email: string,
  password: string,
): Promise<Session | null> {
  const normalized = email.trim().toLowerCase();
  return asService(async (db) => {
    const result = await db.query<{ user_id: string; password_hash: string }>(
      "select user_id, password_hash from operator_credentials where email = $1",
      [normalized],
    );
    const row = result.rows[0];
    if (!row) {
      // Hash anyway. Returning early on an unknown email leaks which addresses
      // are registered through response timing.
      await hashPassword(password);
      return null;
    }
    if (!(await verifyPassword(password, row.password_hash))) return null;
    return { operatorId: row.user_id, email: normalized };
  });
}

/** HMAC of an IP with a rotatable secret. A raw IP is never stored. */
export function hashIp(ip: string): string {
  return createHmac("sha256", env.ipHashSecret).update(ip).digest("base64url");
}
