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

export async function enroll(frames: Blob[]): Promise<EnrollmentResult> {
  const body = new FormData();
  for (const [i, frame] of frames.entries()) {
    body.append("frames", frame, `frame-${i}.jpg`);
  }

  let response: Response;
  try {
    response = await fetch(`${env.mlServiceUrl}/enroll`, {
      method: "POST",
      body,
      // A crowded selfie still returns in a couple of seconds; anything longer
      // is a stuck service, and the attendee is standing at an event waiting.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    throw new MlServiceUnavailable(cause);
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

export async function mlServiceHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${env.mlServiceUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** pgvector's text input format. */
export function toVector(values: number[]): string {
  return `[${values.map((v) => v.toFixed(7)).join(",")}]`;
}
