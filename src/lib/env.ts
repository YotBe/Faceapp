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

  get mlServiceUrl(): string {
    return optional("ML_SERVICE_URL", "http://127.0.0.1:8000");
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

  /**
   * Runs the search path on thresholds that have NOT been measured on a real
   * labeled album. See src/lib/thresholds.ts — refused in production, and it
   * puts a banner on every attendee page.
   */
  get devThresholds(): boolean {
    return process.env["FACEAPP_DEV_THRESHOLDS"] === "1";
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
        "ml/ as a container (Fly.io, Railway, Render) and point this at it.",
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
  const onServerless = Boolean(process.env["VERCEL"] ?? process.env["AWS_LAMBDA_FUNCTION_NAME"]);
  if (!onServerless) return [];

  return [
    {
      variable: "storage driver",
      what: "uploaded photographs have nowhere durable to live",
      how:
        "The bundled driver writes to the local filesystem, which on a " +
        "serverless host is read-only or discarded between requests. " +
        "Implement StorageDriver in src/lib/storage.ts against R2 or Supabase " +
        "Storage before uploading anything you care about.",
    },
  ];
}
