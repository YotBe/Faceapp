import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

/**
 * The gate that stands between an untuned deployment and somebody's photographs.
 *
 * The rule these enforce: placeholder thresholds are reachable *only* by a
 * caller that asks for them explicitly, for one event, having ticked a box. Not
 * by an environment variable, not in development, not by default. The previous
 * shape of this — `FACEAPP_DEV_THRESHOLDS=1` — applied to every event on a
 * server at once and is exactly what these tests exist to keep from coming back.
 *
 * `loadThresholds` reads `ml/config/thresholds.toml` relative to `process.cwd()`,
 * so each test builds a whole fake tree and points the process at it.
 */

let dir: string;
let cwd: string;

async function withConfig(toml: string, reports: Record<string, string> = {}) {
  await mkdir(path.join(dir, "ml", "config"), { recursive: true });
  await mkdir(path.join(dir, "ml", "eval", "reports"), { recursive: true });
  await writeFile(path.join(dir, "ml", "config", "thresholds.toml"), toml);
  for (const [name, body] of Object.entries(reports)) {
    await writeFile(path.join(dir, "ml", "eval", "reports", name), body);
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "thresholds-"));
  cwd = process.cwd();
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(process.cwd()).toBe(cwd);
});

const UNTUNED = `status = "untuned"\n\n[thresholds]\nt_high =\nt_low =\n`;

test("an untuned config refuses by default", async () => {
  await withConfig(UNTUNED);
  const { loadThresholds, UntunedThresholdError } = await import("../thresholds");

  await expect(loadThresholds()).rejects.toBeInstanceOf(UntunedThresholdError);
});

test("a missing config refuses too, rather than assuming a number", async () => {
  const { loadThresholds, UntunedThresholdError } = await import("../thresholds");

  await expect(loadThresholds()).rejects.toBeInstanceOf(UntunedThresholdError);
});

test("the refusal names the demonstration box, since that is the way through", async () => {
  await withConfig(UNTUNED);
  const { loadThresholds } = await import("../thresholds");

  await expect(loadThresholds()).rejects.toThrow(/demonstration box/);
});

test("allowUntuned returns placeholders, marked untrusted", async () => {
  await withConfig(UNTUNED);
  const { loadThresholds } = await import("../thresholds");

  const t = await loadThresholds({ allowUntuned: true });
  expect(t.trusted).toBe(false);
  expect(t.source).toMatch(/PLACEHOLDER/);
  expect(t.tLow).toBeLessThan(t.tHigh);
});

test("no environment variable opens the gate", async () => {
  await withConfig(UNTUNED);
  // Every name this project has ever used for the escape hatch, plus the
  // development environment it used to key on.
  process.env["FACEAPP_DEV_THRESHOLDS"] = "1";
  process.env["ALLOW_UNTUNED_THRESHOLDS"] = "1";
  const nodeEnv = process.env.NODE_ENV;
  try {
    const { loadThresholds, UntunedThresholdError } = await import("../thresholds");
    await expect(loadThresholds()).rejects.toBeInstanceOf(UntunedThresholdError);
  } finally {
    delete process.env["FACEAPP_DEV_THRESHOLDS"];
    delete process.env["ALLOW_UNTUNED_THRESHOLDS"];
    expect(process.env.NODE_ENV).toBe(nodeEnv);
  }
});

function tuned(report: string, digest: string, precision = "0.9932") {
  return [
    'status = "tuned"',
    "",
    "[thresholds]",
    "t_high = 0.47",
    "t_low = 0.38",
    "",
    "[provenance]",
    `report = "${report}"`,
    `report_sha256 = "${digest}"`,
    'dataset_kind = "real"',
    'dataset_id = "rooftop-2026"',
    `precision_at_t_high = ${precision}`,
    "",
  ].join("\n");
}

test("measured thresholds load, and are trusted", async () => {
  const body = '{"report": "whatever"}';
  const digest = createHash("sha256").update(body).digest("hex");
  await withConfig(tuned("r.json", digest), { "r.json": body });
  const { loadThresholds } = await import("../thresholds");

  const t = await loadThresholds();
  expect(t).toMatchObject({ tHigh: 0.47, tLow: 0.38, trusted: true });
  expect(t.source).toContain("rooftop-2026");
});

test("a threshold edited by hand fails the digest check", async () => {
  const body = '{"report": "whatever"}';
  const digest = createHash("sha256").update(body).digest("hex");
  // The provenance block is intact and plausible; only the report has moved on.
  await withConfig(tuned("r.json", digest), { "r.json": body + " " });
  const { loadThresholds } = await import("../thresholds");

  await expect(loadThresholds()).rejects.toThrow(/does not match the digest/);
});

test("allowUntuned does not rescue a corrupt tuned config", async () => {
  // The escape hatch covers "not measured yet". It must not paper over a file
  // that claims to be measured and is not — that is a broken deployment, and a
  // demonstration event silently falling back to placeholders would hide it.
  const body = "{}";
  await withConfig(tuned("r.json", createHash("sha256").update("other").digest("hex")), {
    "r.json": body,
  });
  const { loadThresholds } = await import("../thresholds");

  await expect(loadThresholds({ allowUntuned: true })).rejects.toThrow(
    /does not match the digest/,
  );
});

test("a synthetic dataset is not enough to be trusted", async () => {
  const body = "{}";
  const digest = createHash("sha256").update(body).digest("hex");
  await withConfig(
    tuned("r.json", digest).replace('dataset_kind = "real"', 'dataset_kind = "synthetic"'),
    { "r.json": body },
  );
  const { loadThresholds } = await import("../thresholds");

  await expect(loadThresholds()).rejects.toThrow(/synthetic/);
});

test("precision below the 0.99 floor is refused", async () => {
  const body = "{}";
  const digest = createHash("sha256").update(body).digest("hex");
  await withConfig(tuned("r.json", digest, "0.9712"), { "r.json": body });
  const { loadThresholds } = await import("../thresholds");

  await expect(loadThresholds()).rejects.toThrow(/below the 0.99 floor/);
});

test("bucketOf keeps a weak face out of the confident set", async () => {
  const { bucketOf } = await import("../thresholds");
  const t = { tHigh: 0.5, tLow: 0.4, trusted: true, source: "test" };

  expect(bucketOf(0.62, 2, t)).toBe("confident");
  // Same similarity, tier 1: a small or badly-posed face is a "maybe" however
  // well it scores, because the score is less meaningful at that quality.
  expect(bucketOf(0.62, 1, t)).toBe("maybe");
  expect(bucketOf(0.45, 2, t)).toBe("maybe");
  expect(bucketOf(0.31, 2, t)).toBe("reject");
});
