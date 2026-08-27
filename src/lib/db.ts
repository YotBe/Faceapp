import { Pool, type PoolClient } from "pg";

import { env } from "./env";

/**
 * Database access, in two flavours.
 *
 * `asOperator` runs a transaction with `request.jwt.claims` set to the signed-in
 * operator, so every query goes through the same Row Level Security policies
 * that protect the database from a compromised app server. It would be easier to
 * pass `operator_id` into each WHERE clause and trust ourselves to never forget
 * one. That is exactly the bet RLS exists to avoid making — a forgotten filter
 * is one missing line of code away from serving another operator's album.
 *
 * `asService` bypasses RLS and is for the three things that genuinely cannot go
 * through an operator session: the attendee search path (no account exists), the
 * ingestion worker, and the retention job.
 */

declare global {
  // Next.js reloads modules in development; without this the pool leaks a
  // connection set per edit until Postgres refuses new ones.
  var __faceappPool: Pool | undefined;
}

function pool(): Pool {
  if (!globalThis.__faceappPool) {
    globalThis.__faceappPool = new Pool({
      connectionString: env.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }
  return globalThis.__faceappPool;
}

export type Db = Pick<PoolClient, "query">;

/**
 * Run inside a transaction as a signed-in operator.
 *
 * `SET LOCAL` ties the claim to the transaction, so it cannot leak to the next
 * caller that borrows this pooled connection. Using plain `SET` here would be a
 * cross-tenant data leak under load, and an intermittent one.
 */
export async function asOperator<T>(
  operatorId: string,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: operatorId, role: "authenticated" }),
    ]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    // Belt and braces: `reset role` is redundant after commit/rollback ends the
    // transaction, but a connection returning to the pool still wearing another
    // user's role is bad enough to be worth two lines.
    await client.query("reset role").catch(() => {});
    client.release();
  }
}

/** Bypasses RLS. Only for the attendee search path, the worker and retention. */
export async function asService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function serviceTransaction<T>(
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
