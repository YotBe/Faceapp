import { randomUUID } from "node:crypto";

import { asService } from "./db";
import { configProblems, env, storageProblems } from "./env";
import { mlServiceHealthy } from "./mlclient";
import { BUCKET, storage } from "./storage";
import { UntunedThresholdError, loadThresholds } from "./thresholds";

/**
 * Live checks against every dependency.
 *
 * The configuration page used to check only whether variables were *set*, which
 * cannot tell you that the password is wrong, that the migrations never ran, or
 * that the two halves of the shared secret disagree — which is most of what
 * actually goes wrong on a first deployment. These probe the real thing.
 *
 * Every check is independent and none throws: a deployment with three broken
 * dependencies should show three red rows, not the first one and a stack trace.
 */

export type CheckState = "pass" | "fail" | "warn";

export interface Check {
  name: string;
  state: CheckState;
  detail: string;
  /** What to do about it. Empty when passing. */
  fix?: string;
}

const TIMEOUT_MS = 8000;

async function timed<T>(work: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
    ),
  ]);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function checkDatabase(): Promise<Check[]> {
  if (!process.env["DATABASE_URL"]) {
    return [
      {
        name: "Database",
        state: "fail",
        detail: "DATABASE_URL is not set",
        fix: "A Postgres connection string. On Supabase: Project settings → Database → Connection string.",
      },
    ];
  }

  try {
    const rows = await timed(
      asService(async (db) => {
        const version = await db.query<{ v: string }>("select version() as v");
        const vector = await db.query<{ extversion: string }>(
          "select extversion from pg_extension where extname = 'vector'",
        );
        // The newest migration creates this view. If it is absent, the schema
        // is either missing or stale, and every other symptom follows from that.
        const migrated = await db.query<{ ok: boolean }>(
          "select to_regclass('public.storage_gc_backlog') is not null as ok",
        );
        return {
          version: version.rows[0]?.v ?? "",
          vector: vector.rows[0]?.extversion ?? null,
          migrated: migrated.rows[0]?.ok ?? false,
        };
      }),
      "database",
    );

    const checks: Check[] = [
      {
        name: "Database reachable",
        state: "pass",
        detail: rows.version.split(" on ")[0] ?? "connected",
      },
    ];

    checks.push(
      rows.migrated
        ? { name: "Migrations applied", state: "pass", detail: "schema is up to date" }
        : {
            name: "Migrations applied",
            state: "fail",
            detail: "the newest migration has not run",
            fix: "Apply supabase/migrations/*.sql in filename order, or run: supabase db push",
          },
    );

    if (!rows.vector) {
      checks.push({
        name: "pgvector",
        state: "fail",
        detail: "the vector extension is not installed",
        fix: "create extension if not exists vector;  — on Supabase it is available by default.",
      });
    } else {
      // Below 0.8 there is no hnsw.iterative_scan, so an approximate index scan
      // combined with a per-event filter can return fewer matches than exist.
      // The app adapts, but it is a real recall loss rather than a nicety.
      const major = Number(rows.vector.split(".")[0] ?? 0);
      const minor = Number(rows.vector.split(".")[1] ?? 0);
      const modern = major > 0 || minor >= 8;
      checks.push({
        name: "pgvector version",
        state: modern ? "pass" : "warn",
        detail: rows.vector,
        ...(modern
          ? {}
          : {
              fix:
                "Below 0.8 there is no iterative index scan, so a filtered search " +
                "can silently return fewer photographs than exist. Upgrade if you can.",
            }),
      });
    }

    return checks;
  } catch (error) {
    return [
      {
        name: "Database reachable",
        state: "fail",
        detail: messageOf(error),
        fix: "Check DATABASE_URL. On Supabase use the connection string with the password filled in.",
      },
    ];
  }
}

async function checkMlService(): Promise<Check[]> {
  if (!process.env["ML_SERVICE_URL"]) {
    return [
      {
        name: "Face matching service",
        state: "fail",
        detail: "ML_SERVICE_URL is not set",
        fix: "Deploy ml/ as a container and point this at its URL. See docs/DEPLOY_WALKTHROUGH.md.",
      },
    ];
  }

  const reachable = await mlServiceHealthy(TIMEOUT_MS).catch(() => false);
  if (!reachable) {
    return [
      {
        name: "Face matching service",
        state: "fail",
        detail: `${env.mlServiceUrl} did not answer /health`,
        fix:
          "On a free container tier the instance may be asleep — open the URL once " +
          "and retry. Otherwise check the service is deployed and the URL is right.",
      },
    ];
  }

  const checks: Check[] = [
    { name: "Face matching service", state: "pass", detail: `${env.mlServiceUrl} is up` },
  ];

  if (!process.env["ML_SERVICE_TOKEN"]) {
    checks.push({
      name: "Service token",
      state: "fail",
      detail: "ML_SERVICE_TOKEN is not set",
      fix:
        "openssl rand -base64 32 — set the same value here and on the container. " +
        "Without it that service is an open endpoint that turns face photographs " +
        "into biometric templates.",
    });
    return checks;
  }

  // An empty POST: 400 means the token was accepted and the body was rejected,
  // which is exactly what we want to know. 401 means the two halves disagree.
  try {
    const response = await timed(
      fetch(`${env.mlServiceUrl}/enroll`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.mlServiceToken}` },
        body: new FormData(),
      }),
      "token check",
    );
    checks.push(
      response.status === 401
        ? {
            name: "Service token",
            state: "fail",
            detail: "the service rejected our token",
            fix: "ML_SERVICE_TOKEN differs between this app and the container. Make them identical.",
          }
        : { name: "Service token", state: "pass", detail: "accepted" },
    );
  } catch (error) {
    checks.push({
      name: "Service token",
      state: "fail",
      detail: messageOf(error),
      fix: "Could not reach the service to check the token.",
    });
  }

  return checks;
}

async function checkStorage(): Promise<Check[]> {
  const driver = storage();
  const problems = storageProblems();

  if (problems.length > 0) {
    return [
      {
        name: "Photo storage",
        state: "fail",
        detail: `using the local filesystem: ${problems[0]!.variable} not set`,
        fix: problems[0]!.how,
      },
    ];
  }

  // A real round trip. "The credentials parse" is not the same as "we can write
  // a photograph and read it back", and only one of those matters.
  const key = `_diagnostics/${randomUUID()}.txt`;
  const payload = new TextEncoder().encode("faceapp storage probe");

  try {
    await timed(driver.put(BUCKET, key, payload, "text/plain"), "storage write");
  } catch (error) {
    return [
      {
        name: "Photo storage",
        state: "fail",
        detail: `write failed: ${messageOf(error)}`,
        fix: "Check the endpoint, region, bucket name and access keys. The bucket must already exist.",
      },
    ];
  }

  const checks: Check[] = [
    { name: "Photo storage writable", state: "pass", detail: `${driver.kind} driver` },
  ];

  try {
    const stream = await timed(driver.getStream(BUCKET, key), "storage read");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const readBack = Buffer.concat(chunks).toString();
    checks.push(
      readBack === "faceapp storage probe"
        ? { name: "Photo storage readable", state: "pass", detail: "round trip verified" }
        : {
            name: "Photo storage readable",
            state: "fail",
            detail: "what came back was not what went in",
            fix: "The bucket may be shared with something else writing to the same keys.",
          },
    );
  } catch (error) {
    checks.push({
      name: "Photo storage readable",
      state: "fail",
      detail: messageOf(error),
      fix: "The write succeeded but the read did not. Check the key's read permissions.",
    });
  }

  try {
    const url = await timed(driver.signedUrl(BUCKET, key, 60), "signed url");
    checks.push({
      name: "Signed URLs",
      state: "pass",
      detail: url.startsWith("http") ? "presigned by the object store" : "signed by this app",
    });
  } catch (error) {
    checks.push({ name: "Signed URLs", state: "fail", detail: messageOf(error) });
  }

  // Leave nothing behind. A probe object per page load would otherwise
  // accumulate in a bucket nobody is watching.
  await driver.delete(BUCKET, key).catch(() => {});

  return checks;
}

async function checkThresholds(): Promise<Check> {
  try {
    const thresholds = await loadThresholds();
    return {
      name: "Match thresholds",
      state: "pass",
      detail: `T_high ${thresholds.tHigh}, T_low ${thresholds.tLow} — ${thresholds.source}`,
    };
  } catch (error) {
    if (error instanceof UntunedThresholdError) {
      return {
        name: "Match thresholds",
        state: "warn",
        detail: "not measured on any album",
        fix:
          "Real events will refuse to search, which is deliberate — an unmeasured " +
          "threshold returns strangers' photographs. Events created with the " +
          "demonstration box ticked will still work, on placeholder numbers and " +
          "labelled as untrustworthy. See ml/eval/README.md to measure them.",
      };
    }
    return { name: "Match thresholds", state: "fail", detail: messageOf(error) };
  }
}

export async function runDiagnostics(): Promise<Check[]> {
  const missingSecret = configProblems().some((p) => p.variable === "APP_SECRET");

  // Run everything at once. On a cold free-tier container the ML check alone can
  // take several seconds, and there is no reason to pay for that serially.
  const [database, ml, storageChecks, thresholds] = await Promise.all([
    checkDatabase(),
    checkMlService(),
    // Storage signing needs APP_SECRET for the local driver; skip rather than throw.
    missingSecret
      ? Promise.resolve<Check[]>([
          {
            name: "Photo storage",
            state: "fail",
            detail: "APP_SECRET is not set, so URLs cannot be signed",
            fix: "openssl rand -base64 48",
          },
        ])
      : checkStorage().catch((error: unknown) => [
          { name: "Photo storage", state: "fail" as const, detail: messageOf(error) },
        ]),
    checkThresholds(),
  ]);

  const secret: Check = missingSecret
    ? {
        name: "APP_SECRET",
        state: "fail",
        detail: "not set",
        fix: "openssl rand -base64 48 — signs session cookies and storage URLs.",
      }
    : { name: "APP_SECRET", state: "pass", detail: "set" };

  return [secret, ...database, ...ml, ...storageChecks, thresholds];
}
