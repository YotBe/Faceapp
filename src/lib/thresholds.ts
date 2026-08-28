import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The match thresholds, read from the same file the Python side reads, with the
 * same refusal to invent one.
 *
 * `ml/config/thresholds.toml` is written only by `eval.select_thresholds`, from
 * a real labeled album, and carries the SHA-256 of the report that justified the
 * numbers. This module re-checks that digest before letting a search run. The
 * check is not ceremony: without it, editing `t_high` from 0.47 to 0.41 and
 * leaving the provenance block intact produces a file indistinguishable from a
 * tuned one, and 0.41 is the difference between a search result and a personal
 * data breach.
 *
 * There is one way past the refusal, and it is a property of the *event* rather
 * than of the server: an operator who ticked the demonstration box. See
 * DEV_THRESHOLDS below. It is never a default and never read from the
 * environment.
 */

export interface Thresholds {
  tHigh: number;
  tLow: number;
  /** True when these came from a measured, verified evaluation. */
  trusted: boolean;
  /** Human-readable provenance, shown in the operator UI. */
  source: string;
}

export class UntunedThresholdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntunedThresholdError";
  }
}

/**
 * Placeholder values, for events explicitly marked as demonstrations.
 *
 * These are the midpoint of the range that ArcFace cosine similarity is
 * generally quoted at. That is precisely the number the spec tells you never to
 * ship: the right value depends on the detector, the model and the photographic
 * conditions of the album, and quoting a range is as far as anyone can go
 * without data.
 *
 * They are reachable only by passing `allowUntuned`, which only the search route
 * does, and only for an event whose operator ticked the demonstration box. A
 * real event gets an error instead.
 *
 * Everything that touches them is marked: the search response carries
 * `thresholdsTrusted: false`, the attendee page shows a banner, and the
 * search_logs row records it.
 */
const DEV_THRESHOLDS: Thresholds = {
  tHigh: 0.5,
  tLow: 0.4,
  trusted: false,
  source: "DEVELOPMENT PLACEHOLDER — not measured on any album",
};

const CONFIG_PATH = path.join(process.cwd(), "ml", "config", "thresholds.toml");
const REPORTS_DIR = path.join(process.cwd(), "ml", "eval", "reports");

/** Minimal reader for the flat, generated subset of TOML this file uses. */
function readScalar(toml: string, section: string, key: string): string | null {
  const sectionBody = section
    ? (toml.split(`[${section}]`)[1] ?? "").split(/^\[/m)[0]
    : toml.split(/^\[/m)[0];
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m").exec(
    sectionBody ?? "",
  );
  if (!match?.[1]) return null;
  return match[1].replace(/^["']|["']$/g, "");
}

export interface LoadOptions {
  /**
   * Permit untuned placeholder thresholds.
   *
   * Set only for an event whose operator explicitly marked it a demonstration.
   * Never a default, never derived from the environment: the question is
   * whether *this album's* results can be trusted, and that is a property of
   * the event rather than of the server it runs on.
   */
  allowUntuned?: boolean;
}

export async function loadThresholds(
  options: LoadOptions = {},
): Promise<Thresholds> {
  let toml: string;
  try {
    toml = await readFile(CONFIG_PATH, "utf8");
  } catch {
    return untunedOr(`no threshold config at ${CONFIG_PATH}`, options);
  }

  const status = readScalar(toml, "", "status");
  const tHigh = Number(readScalar(toml, "thresholds", "t_high"));
  const tLow = Number(readScalar(toml, "thresholds", "t_low"));

  if (status !== "tuned" || !Number.isFinite(tHigh) || !Number.isFinite(tLow)) {
    return untunedOr("thresholds have not been measured yet", options);
  }
  if (!(tLow > 0 && tLow <= tHigh && tHigh < 1)) {
    throw new UntunedThresholdError(
      `${CONFIG_PATH}: need 0 < t_low <= t_high < 1, got ${tLow} and ${tHigh}`,
    );
  }

  const reportName = readScalar(toml, "provenance", "report");
  const recordedDigest = readScalar(toml, "provenance", "report_sha256");
  const datasetKind = readScalar(toml, "provenance", "dataset_kind");
  const datasetId = readScalar(toml, "provenance", "dataset_id");
  const precision = Number(readScalar(toml, "provenance", "precision_at_t_high"));

  if (!reportName || !recordedDigest) {
    throw new UntunedThresholdError(
      `${CONFIG_PATH}: thresholds are present but carry no provenance. ` +
        `Re-run: python -m eval.select_thresholds --report <report> --write`,
    );
  }
  if (datasetKind !== "real") {
    throw new UntunedThresholdError(
      `${CONFIG_PATH}: thresholds were derived from a ${datasetKind} dataset. ` +
        `The synthetic generator proves the harness computes the right arithmetic; ` +
        `it says nothing about a backlit face at 45 pixels.`,
    );
  }
  if (!(precision >= 0.99)) {
    throw new UntunedThresholdError(
      `${CONFIG_PATH}: measured precision at t_high is ${precision}, below the 0.99 floor.`,
    );
  }

  let report: Buffer;
  try {
    report = await readFile(path.join(REPORTS_DIR, reportName));
  } catch {
    throw new UntunedThresholdError(
      `${CONFIG_PATH}: the report that justified these thresholds is missing ` +
        `(${reportName}). It has to ship with the code that uses the numbers.`,
    );
  }

  const actual = createHash("sha256").update(report).digest("hex");
  if (actual !== recordedDigest) {
    throw new UntunedThresholdError(
      `${reportName} does not match the digest recorded when these thresholds ` +
        `were chosen. Either the report changed or a threshold was edited by hand.`,
    );
  }

  return {
    tHigh,
    tLow,
    trusted: true,
    source: `${datasetId} via ${reportName} (precision ${precision.toFixed(4)})`,
  };
}

function untunedOr(reason: string, options: LoadOptions): Thresholds {
  if (options.allowUntuned) return DEV_THRESHOLDS;

  throw new UntunedThresholdError(
    `${reason}.\n\n` +
      `Search is disabled for this event until thresholds are measured on a ` +
      `labeled album:\n` +
      `  cd ml\n` +
      `  python -m eval.run --dataset eval/datasets/<name>\n` +
      `  python -m eval.select_thresholds --report eval/reports/<report>.json --write\n\n` +
      `See ml/eval/README.md.\n\n` +
      `To try the product before that exists, create an event with the ` +
      `demonstration box ticked. Those search on placeholder numbers, are ` +
      `capped at 30 days, and are labelled as untrustworthy everywhere they ` +
      `appear.`,
  );
}

/** Classify one scored face. A tier-1 face never reaches the confident set. */
export function bucketOf(
  similarity: number,
  qualityTier: number,
  t: Thresholds,
): "confident" | "maybe" | "reject" {
  if (similarity >= t.tHigh && qualityTier >= 2) return "confident";
  if (similarity >= t.tLow) return "maybe";
  return "reject";
}
