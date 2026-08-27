"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { UntrustedThresholdBanner, buttonClass, secondaryButtonClass } from "./Chrome";

/**
 * Three-frame selfie capture.
 *
 * Camera only. There is no file picker in this flow, and that is the first line
 * of defence against the biggest abuse vector in this product category: nothing
 * else stops someone uploading a photograph of another attendee to collect their
 * photographs.
 *
 * Three frames over about two seconds, then a check that they are not identical.
 * A still photograph held up to the camera produces frames that differ only by
 * sensor noise; a living face does not. It is a cheap check, not liveness
 * detection, and it is described as such.
 */

const FRAME_COUNT = 3;
const FRAME_INTERVAL_MS = 700;
const CAPTURE_WIDTH = 720;

/**
 * Mean absolute difference below which consecutive frames are treated as the
 * same image. Tuned to sit above sensor noise from a static scene and well
 * below the movement of a person breathing and blinking.
 */
const REPLAY_THRESHOLD = 1.4;

interface Match {
  photoId: string;
  previewUrl: string | null;
  thumbUrl: string | null;
  score: number;
  bucket: string;
}

interface SearchResponse {
  confident: Match[];
  maybe: Match[];
  warnings: string[];
  thresholdsTrusted: boolean;
  selfieDeleted: { elapsedMs: number; withinSla: boolean };
}

type Phase = "intro" | "starting" | "ready" | "capturing" | "searching" | "results" | "error";

export function SelfieCapture({ slug, eventName }: { slug: string; eventName: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [phase, setPhase] = useState<Phase>("intro");
  const [message, setMessage] = useState("");
  const [hints, setHints] = useState<string[]>([]);
  const [captured, setCaptured] = useState(0);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [showMaybe, setShowMaybe] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  /**
   * Attach the stream once the <video> is actually in the DOM.
   *
   * The element is only rendered in the ready/capturing phases, so at the
   * moment getUserMedia resolves `videoRef.current` is still null and assigning
   * srcObject there does nothing. The symptom is a permanently black preview and
   * a capture that fails with "could not read from the camera" — the stream is
   * live, it was simply never connected to anything.
   */
  useEffect(() => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      void video.play().catch(() => {});
    }
  }, [phase]);

  const startCamera = useCallback(async () => {
    setPhase("starting");
    setMessage("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      streamRef.current = stream;
      setPhase("ready");
    } catch (error) {
      setPhase("error");
      setMessage(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Camera access was refused. This search only works with the camera — there is no photo upload, so that nobody can search using a picture of someone else."
          : "No camera available on this device.",
      );
    }
  }, []);

  const grabFrame = useCallback((): { blob: Promise<Blob | null>; data: ImageData } | null => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return null;

    const scale = CAPTURE_WIDTH / video.videoWidth;
    const canvas = document.createElement("canvas");
    canvas.width = CAPTURE_WIDTH;
    canvas.height = Math.round(video.videoHeight * scale);

    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    return {
      blob: new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.9),
      ),
      data: context.getImageData(0, 0, canvas.width, canvas.height),
    };
  }, []);

  const capture = useCallback(async () => {
    setPhase("capturing");
    setCaptured(0);
    setHints([]);

    // A <video> reports 0x0 until the first frame has arrived. Capturing before
    // then yields a blank canvas and a search that fails for a reason that has
    // nothing to do with the person's face.
    const video = videoRef.current;
    for (let waited = 0; video && !video.videoWidth && waited < 5000; waited += 100) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const blobs: Blob[] = [];
    const frames: ImageData[] = [];

    for (let i = 0; i < FRAME_COUNT; i++) {
      const grabbed = grabFrame();
      if (!grabbed) {
        setPhase("error");
        setMessage("Could not read from the camera.");
        return;
      }
      const blob = await grabbed.blob;
      if (blob) {
        blobs.push(blob);
        frames.push(grabbed.data);
        setCaptured(i + 1);
      }
      if (i < FRAME_COUNT - 1) {
        await new Promise((r) => setTimeout(r, FRAME_INTERVAL_MS));
      }
    }

    if (blobs.length < 2) {
      setPhase("error");
      setMessage("Could not capture enough frames. Try again.");
      return;
    }

    if (framesAreIdentical(frames)) {
      setPhase("error");
      setMessage(
        "Those frames were identical, which usually means the camera was pointed at a photograph or a screen. Point it at your face and try again.",
      );
      return;
    }

    setPhase("searching");
    stopCamera();

    const body = new FormData();
    body.append("slug", slug);
    for (const [i, blob] of blobs.entries()) {
      body.append("frames", blob, `frame-${i}.jpg`);
    }

    try {
      const response = await fetch("/api/search", { method: "POST", body });
      const data = (await response.json()) as SearchResponse & {
        error?: string;
        warnings?: string[];
        detail?: string;
      };

      if (!response.ok) {
        setPhase("error");
        setMessage(data.error ?? "Something went wrong.");
        setHints(data.warnings ?? []);
        return;
      }

      setResults(data);
      setPhase("results");
    } catch {
      setPhase("error");
      setMessage("The network dropped. Try again.");
    }
  }, [grabFrame, slug, stopCamera]);

  const reset = useCallback(() => {
    setResults(null);
    setPhase("intro");
    setMessage("");
    setHints([]);
    setShowMaybe(false);
  }, []);

  // ---- results -----------------------------------------------------------
  if (phase === "results" && results) {
    const total = results.confident.length + results.maybe.length;
    return (
      <div className="space-y-5">
        {!results.thresholdsTrusted ? <UntrustedThresholdBanner /> : null}

        <div>
          <h2 className="text-lg font-semibold">
            {results.confident.length > 0
              ? `${results.confident.length} ${results.confident.length === 1 ? "photo" : "photos"} of you`
              : total > 0
                ? "No confident matches"
                : "We did not find you"}
          </h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Your selfie was deleted {Math.round(results.selfieDeleted.elapsedMs / 100) / 10}s
            after you took it. We did not keep it.
          </p>
        </div>

        {results.confident.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {results.confident.map((match) => (
              <Photo key={match.photoId} match={match} />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-muted)]">
            <p>
              Nothing matched confidently. In wide crowd shots faces are often too
              small or turned too far away to match reliably, and we would rather
              show you nothing than show you someone else&apos;s photographs.
            </p>
          </div>
        )}

        {results.maybe.length > 0 ? (
          <div>
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => setShowMaybe((v) => !v)}
            >
              {showMaybe ? "Hide" : `More possible matches (${results.maybe.length})`}
            </button>
            {showMaybe ? (
              <>
                <p className="mt-3 text-sm text-[var(--color-muted)]">
                  These are less certain. Check them yourself before downloading —
                  they are not included automatically and are never sent to you.
                </p>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {results.maybe.map((match) => (
                    <Photo key={match.photoId} match={match} dimmed />
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {results.warnings.length > 0 ? (
          <ul className="space-y-1 text-xs text-[var(--color-muted)]">
            {results.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap gap-3 pt-2">
          {results.confident.length > 0 ? (
            <button
              type="button"
              className={buttonClass}
              disabled={downloading}
              onClick={async () => {
                setDownloading(true);
                try {
                  // Only the confident set. The "maybe" bucket is never included
                  // automatically — a borderline match has to be looked at by a
                  // person before it goes anywhere.
                  const response = await fetch("/api/download", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      slug,
                      photoIds: results.confident.map((m) => m.photoId),
                    }),
                  });
                  if (!response.ok) return;
                  const blob = await response.blob();
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = "my-photos.zip";
                  link.click();
                  URL.revokeObjectURL(url);
                } finally {
                  setDownloading(false);
                }
              }}
            >
              {downloading ? "Preparing…" : `Download ${results.confident.length}`}
            </button>
          ) : null}
          <button type="button" className={secondaryButtonClass} onClick={reset}>
            Search again
          </button>
          <a className={secondaryButtonClass} href={`/e/${slug}/opt-out`}>
            Remove me from this album
          </a>
        </div>
      </div>
    );
  }

  // ---- capture -----------------------------------------------------------
  return (
    <div className="space-y-5">
      {phase === "intro" ? (
        <>
          <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
            <h2 className="font-medium">Find your photos from {eventName}</h2>
            <ul className="mt-3 space-y-2 text-sm text-[var(--color-muted)]">
              <li>Take a short selfie — three frames, about two seconds.</li>
              <li>We match it against the album and show you what we find.</li>
              <li>
                <strong className="text-[var(--color-ink)]">
                  Your selfie is deleted within a minute
                </strong>{" "}
                and is never stored.
              </li>
              <li>Searches are logged and rate-limited.</li>
            </ul>
          </div>
          <button type="button" className={`${buttonClass} w-full py-3 text-base`} onClick={startCamera}>
            Turn on the camera
          </button>
        </>
      ) : null}

      {phase === "starting" ? (
        <p className="text-sm text-[var(--color-muted)]">Asking for camera access…</p>
      ) : null}

      {(phase === "ready" || phase === "capturing") ? (
        <>
          <div className="relative overflow-hidden rounded-xl border border-[var(--color-line)] bg-black">
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="mirror aspect-[3/4] w-full object-cover"
            />
            {phase === "capturing" ? (
              <div className="absolute inset-x-0 bottom-0 bg-black/60 px-4 py-3 text-center text-sm text-white">
                Hold still — frame {captured} of {FRAME_COUNT}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className={`${buttonClass} w-full py-3 text-base`}
            disabled={phase === "capturing"}
            onClick={capture}
          >
            {phase === "capturing" ? "Capturing…" : "Take the selfie"}
          </button>
          <p className="text-center text-xs text-[var(--color-muted)]">
            Face the light. Make sure it is just you in frame.
          </p>
        </>
      ) : null}

      {phase === "searching" ? (
        <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-8 text-center">
          <p className="text-sm">Searching the album…</p>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Your selfie is deleted as soon as this finishes.
          </p>
        </div>
      ) : null}

      {phase === "error" ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-[var(--color-warn-line)] bg-[var(--color-warn-bg)] p-4 text-sm text-[var(--color-warn-ink)]">
            <p>{message}</p>
            {hints.length ? (
              <ul className="mt-2 space-y-1 text-xs">
                {hints.map((hint) => (
                  <li key={hint}>{hint}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <button type="button" className={buttonClass} onClick={reset}>
            Start again
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Photo({ match, dimmed = false }: { match: Match; dimmed?: boolean }) {
  const src = match.thumbUrl ?? match.previewUrl;
  if (!src) return null;
  return (
    <a
      href={match.previewUrl ?? src}
      target="_blank"
      rel="noreferrer"
      className={`block overflow-hidden rounded-lg border border-[var(--color-line)] ${
        dimmed ? "opacity-80" : ""
      }`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className="aspect-square w-full object-cover" loading="lazy" />
    </a>
  );
}

/**
 * Are these frames the same image?
 *
 * Mean absolute difference across consecutive frames, on a subsample. A
 * photograph or a phone screen held up to the camera produces frames that differ
 * only by sensor noise; a real face moves. This raises the cost of the simplest
 * impersonation attempt — it is not liveness detection and should not be
 * described as such to anyone.
 */
function framesAreIdentical(frames: ImageData[]): boolean {
  if (frames.length < 2) return false;

  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!.data;
    const b = frames[i]!.data;
    if (a.length !== b.length) return false;

    let total = 0;
    let samples = 0;
    // Every 40th pixel: enough signal, a fraction of the work on a mid-range
    // phone where this runs.
    for (let p = 0; p < a.length; p += 160) {
      total += Math.abs(a[p]! - b[p]!);
      samples++;
    }
    if (samples > 0 && total / samples > REPLAY_THRESHOLD) return false;
  }
  return true;
}
