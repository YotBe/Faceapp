import { afterEach, beforeEach, expect, test, vi } from "vitest";

/**
 * Storage configuration, which is all-or-nothing for a reason.
 *
 * With one of the five values missing, `s3Configured` is false and the local
 * filesystem driver takes over. On Vercel that filesystem is discarded between
 * requests: the upload returns 200 and the photograph does not exist. There is
 * no error anywhere. These tests are the guard on the check that makes that
 * state impossible to reach by accident.
 *
 * The R2_* aliases are here because they came first and someone's deployment
 * still uses them.
 */

const NAMES = [
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "R2_ENDPOINT",
  "R2_REGION",
  "R2_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "VERCEL",
  "AWS_LAMBDA_FUNCTION_NAME",
  "DATABASE_URL",
  "APP_SECRET",
  "ML_SERVICE_URL",
  "ML_SERVICE_TOKEN",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  for (const name of NAMES) delete process.env[name];
  vi.resetModules();
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const S3 = {
  S3_ENDPOINT: "https://ref.storage.supabase.co/storage/v1/s3",
  S3_BUCKET: "faceapp-photos",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
};

const R2 = {
  R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
  R2_BUCKET: "faceapp-photos",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
};

test("nothing set is not configured", async () => {
  const { env } = await import("../env");
  expect(env.s3Configured).toBe(false);
});

test("the S3_* names configure it", async () => {
  Object.assign(process.env, S3);
  const { env } = await import("../env");

  expect(env.s3Configured).toBe(true);
  expect(env.s3Endpoint).toBe(S3.S3_ENDPOINT);
  expect(env.s3Bucket).toBe("faceapp-photos");
});

test("the R2_* names still work, unchanged", async () => {
  Object.assign(process.env, R2);
  const { env } = await import("../env");

  expect(env.s3Configured).toBe(true);
  expect(env.s3Endpoint).toBe(R2.R2_ENDPOINT);
  expect(env.s3AccessKeyId).toBe("key");
  expect(env.s3SecretAccessKey).toBe("secret");
});

test("S3_* wins over R2_* when both are present", async () => {
  Object.assign(process.env, R2, S3);
  const { env } = await import("../env");
  expect(env.s3Endpoint).toBe(S3.S3_ENDPOINT);
});

test.each(Object.keys(S3))("without %s it is not configured", async (missing) => {
  Object.assign(process.env, S3);
  delete process.env[missing];
  const { env } = await import("../env");

  expect(env.s3Configured).toBe(false);
});

test("region defaults to auto, which is R2's convention", async () => {
  Object.assign(process.env, R2);
  const { env } = await import("../env");
  expect(env.s3Region).toBe("auto");
});

test("region is configurable, because Supabase rejects auto in the signature", async () => {
  Object.assign(process.env, S3, { S3_REGION: "eu-central-1" });
  const { env } = await import("../env");
  expect(env.s3Region).toBe("eu-central-1");
});

test("a half-configured bucket on a serverless host is reported, loudly", async () => {
  process.env["VERCEL"] = "1";
  Object.assign(process.env, S3);
  delete process.env["S3_SECRET_ACCESS_KEY"];
  const { storageProblems } = await import("../env");

  const problems = storageProblems();
  expect(problems).toHaveLength(1);
  expect(problems[0]?.variable).toContain("S3_SECRET_ACCESS_KEY");
});

test("no storage configuration at all is fine off a serverless host", async () => {
  // Local development. The filesystem driver is the right answer there and
  // saying otherwise on every `pnpm dev` would train people to ignore it.
  const { storageProblems } = await import("../env");
  expect(storageProblems()).toEqual([]);
});

test("configProblems names every unset requirement rather than the first", async () => {
  const { configProblems } = await import("../env");

  const names = configProblems().map((p) => p.variable);
  expect(names).toEqual([
    "DATABASE_URL",
    "APP_SECRET",
    "ML_SERVICE_URL",
    "ML_SERVICE_TOKEN",
  ]);
});

test("the ML service token has no default", async () => {
  const { env, MissingConfigError } = await import("../env");
  // An unauthenticated enrollment service converts face photographs into
  // biometric templates for anyone who finds the URL, and every container host
  // gives it one.
  expect(() => env.mlServiceToken).toThrow(MissingConfigError);
});

test("APP_SECRET has no default either", async () => {
  const { env, MissingConfigError } = await import("../env");
  expect(() => env.secret).toThrow(MissingConfigError);
});

test("reading configuration never happens at import time", async () => {
  // Next.js evaluates every route module during `next build`. A module that
  // validates configuration on import fails the build on any host that supplies
  // variables at runtime — which is how this shipped broken the first time.
  await expect(import("../env")).resolves.toBeDefined();
});
