/**
 * Environment.
 *
 * Read lazily, through getters, and this is not a style choice: Next.js
 * evaluates every route module during `next build` to collect its
 * configuration. A module that validates configuration at import time
 * therefore fails the *build* on any host where the variables are set at
 * runtime rather than build time — Vercel among them. The symptom is a deploy
 * that fails with "DATABASE_URL is not set" on a project where DATABASE_URL is
 * perfectly well configured.
 *
 * So: nothing is read until something actually needs it. What is not negotiable
 * is the absence of fallbacks. A signing secret that quietly defaults to a
 * constant is not a missing configuration value, it is a way for anyone to mint
 * signed URLs for a stranger's photographs.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new MissingConfigError(name);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/** First of several names that is set, or a MissingConfigError naming them all. */
function firstOf(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new MissingConfigError(names.join(" or "));
}

/** Each entry is one setting; the strings inside it are interchangeable names. */
const S3_REQUIRED = [
  ["S3_ENDPOINT", "R2_ENDPOINT"],
  ["S3_BUCKET", "R2_BUCKET"],
  ["S3_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID"],
  ["S3_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY"],
] as const;

export class MissingConfigError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(
      `${variable} is not set. Locally: copy .env.example to .env.local. ` +
        `On a host: set it in the project's environment variables.`,
    );
    this.name = "MissingConfigError";
    this.variable = variable;
  }
}

export const env = {
  get databaseUrl(): string {
    return required("DATABASE_URL");
  },

  /** Signs storage URLs and session cookies. Never has a default. */
  get secret(): string {
    return required("APP_SECRET");
  },

  /**
   * Salts the IP hash in search_logs. Separate from APP_SECRET so it can be
   * rotated on its own, which is the point of a salted hash.
   */
  get ipHashSecret(): string {
    return process.env["IP_HASH_SECRET"] ?? required("APP_SECRET");
  },

  get storageRoot(): string {
    return optional("STORAGE_ROOT", ".storage");
  },

  // --- S3-compatible object storage ---------------------------------------
  //
  // Cloudflare R2 and Supabase Storage both speak S3, so one driver covers
  // both. The R2_* names are accepted as aliases because they were here first.
  //
  // Region is configurable rather than hardcoded: R2 has no regions and wants
  // the literal "auto", while Supabase Storage wants the project's real region
  // and rejects "auto" in the signature.
  //
  // All of them or none. A half-configured bucket falls back to the local
  // driver, and on a serverless host that means uploads appear to succeed and
  // the photographs are gone by the next request — a failure with no error
  // message anywhere. `s3Configured` is what makes that impossible.
  get s3Configured(): boolean {
    return S3_REQUIRED.every((names) => names.some((name) => process.env[name]));
  },
  get s3Endpoint(): string {
    return firstOf("S3_ENDPOINT", "R2_ENDPOINT");
  },
  get s3Bucket(): string {
    return firstOf("S3_BUCKET", "R2_BUCKET");
  },
  get s3AccessKeyId(): string {
    return firstOf("S3_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID");
  },
  get s3SecretAccessKey(): string {
    return firstOf("S3_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY");
  },
  get s3Region(): string {
    // "auto" is R2's convention and is what it expects; Supabase needs its own.
    return process.env["S3_REGION"] ?? process.env["R2_REGION"] ?? "auto";
  },

  get mlServiceUrl(): string {
    return optional("ML_SERVICE_URL", "http://127.0.0.1:8000");
  },

  /**
   * Shared secret for the enrollment service. No default: every common
   * container host gives that service a public URL, and unauthenticated it
   * turns face photographs into biometric templates for anyone who finds it.
   */
  get mlServiceToken(): string {
    return required("ML_SERVICE_TOKEN");
  },

  get signedUrlTtlSeconds(): number {
    return Number(optional("SIGNED_URL_TTL_SECONDS", "900"));
  },

  /** Searches allowed per IP hash, per event, per hour. */
  get searchRateLimit(): number {
    return Number(optional("SEARCH_RATE_LIMIT_PER_HOUR", "3"));
  },

  get isProduction(): boolean {
    return process.env.NODE_ENV === "production";
  },

} as const;

export interface ConfigProblem {
  variable: string;
  what: string;
  how: string;
}

/**
 * What is missing, without throwing.
 *
 * Lets a deployed-but-unconfigured instance explain itself instead of
 * returning a 500 that means nothing to whoever opened the link. A half-set-up
 * deployment is the normal state of a project someone is still wiring together;
 * it should say so.
 */
export function configProblems(): ConfigProblem[] {
  const problems: ConfigProblem[] = [];

  if (!process.env["DATABASE_URL"]) {
    problems.push({
      variable: "DATABASE_URL",
      what: "Postgres with the pgvector extension",
      how: "Any Postgres will do; Supabase is one. Then apply supabase/migrations.",
    });
  }
  if (!process.env["APP_SECRET"]) {
    problems.push({
      variable: "APP_SECRET",
      what: "signs session cookies and storage URLs",
      how: "Generate one with: openssl rand -base64 48",
    });
  }
  if (!process.env["ML_SERVICE_URL"]) {
    problems.push({
      variable: "ML_SERVICE_URL",
      what: "the Python enrollment service that turns selfie frames into a template",
      how:
        "It runs onnxruntime and cannot live in a serverless function. Deploy " +
        "ml/ as a container (Railway, Render, Fly.io) and point this at it. " +
        "See docs/DEPLOY_WALKTHROUGH.md.",
    });
  }
  if (!process.env["ML_SERVICE_TOKEN"]) {
    problems.push({
      variable: "ML_SERVICE_TOKEN",
      what: "the shared secret the enrollment service requires",
      how:
        "Generate with: openssl rand -base64 32 — then set the same value here " +
        "and on the container. Without it that service is an open endpoint that " +
        "turns face photographs into biometric templates.",
    });
  }
  return problems;
}

/**
 * Object storage keeps its own list, because the local driver silently does the
 * wrong thing on a serverless host rather than failing: writes appear to
 * succeed and the file is gone by the next request.
 */
export function storageProblems(): ConfigProblem[] {
  if (env.s3Configured) return [];

  const onServerless = Boolean(
    process.env["VERCEL"] ?? process.env["AWS_LAMBDA_FUNCTION_NAME"],
  );
  if (!onServerless) return [];

  const partial = S3_REQUIRED.filter(
    (names) => !names.some((name) => process.env[name]),
  ).map((names) => names[0]);

  return [
    {
      variable: partial.join(", "),
      what: "uploaded photographs have nowhere durable to live",
      how:
        "Without these the local storage driver is used, and on a serverless " +
        "host its filesystem is read-only or discarded between requests — the " +
        "upload appears to succeed and the photograph is gone. Supabase Storage " +
        "and Cloudflare R2 both work; see docs/DEPLOY_WALKTHROUGH.md.",
    },
  ];
}
