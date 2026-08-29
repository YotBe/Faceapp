import { env } from "./env";

/**
 * Client for the Python enrollment service.
 *
 * Model execution never happens in a route handler. That is a stack rule with
 * two reasons behind it: onnxruntime in a serverless function is a cold-start
 * and a memory problem, and keeping every inference path in one Python process
 * means the quality gate guarding ingestion is literally the same code as the
 * one guarding search.
 */

export interface EnrollmentResult {
  embedding: number[];
  framesUsed: number;
  elapsedMs: number;
  warnings: string[];
}

export class EnrollmentFailed extends Error {
  readonly warnings: string[];

  constructor(message: string, warnings: string[]) {
    super(message);
    this.name = "EnrollmentFailed";
    this.warnings = warnings;
  }
}

export class MlServiceUnavailable extends Error {
  constructor(cause: unknown) {
    super(
      `the enrollment service at ${env.mlServiceUrl} is not reachable. ` +
        `Start it with: cd ml && uvicorn faceapp_worker.service:app --port 8000`,
    );
    this.name = "MlServiceUnavailable";
    this.cause = cause;
  }
}

/**
 * The service is up, and still loading its model.
 *
 * Every host that sleeps an idle container — which is every free tier — makes
 * the first search after a quiet spell wait the better part of a minute while
 * buffalo_l loads. From the attendee's side that is indistinguishable from a
 * broken product, so it is worth the extra round trip to be able to say which
 * of the two it is.
 */
export class MlServiceWarming extends Error {
  constructor() {
    super("the face matching service is still loading its model");
    this.name = "MlServiceWarming";
  }
}

export async function enroll(frames: Blob[]): Promise<EnrollmentResult> {
  const body = new FormData();
  for (const [i, frame] of frames.entries()) {
    body.append("frames", frame, `frame-${i}.jpg`);
  }

  let response: Response;
  try {
    response = await fetch(`${env.mlServiceUrl}/enroll`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.mlServiceToken}` },
      body,
      // Long enough to sit through a cold start rather than failing halfway
      // into one and making the attendee start again. A warm service answers a
      // crowded selfie in a couple of seconds; this ceiling is for the model
      // load, not for the work.
      signal: AbortSignal.timeout(90_000),
    });
  } catch (cause) {
    // Only now, on the failure path, is it worth asking which failure this is.
    throw (await warming()) ? new MlServiceWarming() : new MlServiceUnavailable(cause);
  }

  if (response.status === 401) {
    // A configuration error, not a bad selfie. Say so plainly rather than
    // letting it surface to an attendee as "we could not read your face".
    throw new Error(
      "the enrollment service rejected our token — ML_SERVICE_TOKEN differs " +
        "between the web app and the container",
    );
  }

  if (response.status === 422) {
    const detail = (await response.json().catch(() => null)) as {
      detail?: { warnings?: string[] };
    } | null;
    const warnings = detail?.detail?.warnings ?? [];
    throw new EnrollmentFailed(
      warnings[0] ?? "we could not read a face in those frames",
      warnings,
    );
  }
  if (!response.ok) {
    throw new Error(`enrollment service returned ${response.status}`);
  }

  const data = (await response.json()) as {
    embedding: number[];
    frames_used: number;
    elapsed_ms: number;
    warnings: string[];
  };

  return {
    embedding: data.embedding,
    framesUsed: data.frames_used,
    elapsedMs: data.elapsed_ms,
    warnings: data.warnings,
  };
}

export interface MlHealth {
  ok: boolean;
  engine: string;
  modelLoaded: boolean;
}

export async function mlHealth(timeoutMs = 3000): Promise<MlHealth | null> {
  try {
    const response = await fetch(`${env.mlServiceUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      ok?: boolean;
      engine?: string;
      model_loaded?: boolean;
    };
    return {
      ok: body.ok !== false,
      engine: body.engine ?? "unknown",
      // Absent on an older container. Treating that as loaded is the right
      // default: it is what the old blocking /health meant when it answered.
      modelLoaded: body.model_loaded ?? true,
    };
  } catch {
    return null;
  }
}

export async function mlServiceHealthy(timeoutMs = 2000): Promise<boolean> {
  return (await mlHealth(timeoutMs)) !== null;
}

/** Up, but not ready yet. */
async function warming(): Promise<boolean> {
  const health = await mlHealth();
  return health !== null && !health.modelLoaded;
}

/** pgvector's text input format. */
export function toVector(values: number[]): string {
  return `[${values.map((v) => v.toFixed(7)).join(",")}]`;
}
