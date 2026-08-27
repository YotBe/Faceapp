/**
 * Environment, validated once at import.
 *
 * Everything that can bring the system down quietly is checked here rather than
 * read ad hoc with `??` defaults: a missing signing secret that falls back to a
 * constant is not a configuration bug, it is a way for anyone to mint signed
 * URLs for a stranger's photographs.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const env = {
  databaseUrl: required("DATABASE_URL"),

  /** Signs storage URLs and session cookies. Never has a default. */
  secret: required("APP_SECRET"),

  /** Salts the IP hash in search_logs. Separate from APP_SECRET so it can be
   *  rotated on its own, which is the point of a salted hash. */
  ipHashSecret: optional("IP_HASH_SECRET", required("APP_SECRET")),

  storageRoot: optional("STORAGE_ROOT", ".storage"),
  mlServiceUrl: optional("ML_SERVICE_URL", "http://127.0.0.1:8000"),

  signedUrlTtlSeconds: Number(optional("SIGNED_URL_TTL_SECONDS", "900")),

  /** Searches allowed per IP hash, per event, per hour. */
  searchRateLimit: Number(optional("SEARCH_RATE_LIMIT_PER_HOUR", "3")),

  isProduction: process.env.NODE_ENV === "production",

  /**
   * Runs the search path with thresholds that have NOT been measured on a real
   * labeled album. See src/lib/thresholds.ts — this is refused in production
   * and puts a banner on every attendee page.
   */
  devThresholds: process.env["FACEAPP_DEV_THRESHOLDS"] === "1",
} as const;
