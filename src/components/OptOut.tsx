"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { buttonClass, secondaryButtonClass } from "./Chrome";

/**
 * The opt-out capture.
 *
 * Same camera-only capture as search, for the same reason: without it, anyone
 * could remove anyone else from an album using a photograph of them.
 */

interface Result {
  facesRemoved: number;
  photosAffected: number;
  message: string;
}

export function OptOut({ slug }: { slug: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [phase, setPhase] = useState<"intro" | "ready" | "working" | "done" | "error">("intro");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setPhase("ready");
    } catch {
      setPhase("error");
      setMessage("Camera access is needed, so that nobody can remove someone else.");
    }
  }, []);

  const submit = useCallback(async () => {
    const video = videoRef.current;
    if (!video?.videoWidth) return;
    setPhase("working");

    const blobs: Blob[] = [];
    for (let i = 0; i < 2; i++) {
      const canvas = document.createElement("canvas");
      const scale = 720 / video.videoWidth;
      canvas.width = 720;
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9));
      if (blob) blobs.push(blob);
      if (i === 0) await new Promise((r) => setTimeout(r, 500));
    }

    const body = new FormData();
    body.append("slug", slug);
    for (const [i, b] of blobs.entries()) body.append("frames", b, `f${i}.jpg`);

    try {
      const response = await fetch("/api/optout", { method: "POST", body });
      const data = (await response.json()) as Result & { error?: string };
      if (!response.ok) {
        setPhase("error");
        setMessage(data.error ?? "Something went wrong.");
        return;
      }
      stop();
      setResult(data);
      setPhase("done");
    } catch {
      setPhase("error");
      setMessage("The network dropped. Try again.");
    }
  }, [slug, stop]);

  if (phase === "done" && result) {
    return (
      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
        <h2 className="font-medium">Done</h2>
        <p className="mt-2 text-sm">{result.message}</p>
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          {result.facesRemoved} face {result.facesRemoved === 1 ? "measurement" : "measurements"} across{" "}
          {result.photosAffected} {result.photosAffected === 1 ? "photograph" : "photographs"} were deleted.
        </p>
        <p className="mt-3 text-xs leading-relaxed text-[var(--color-muted)]">
          To keep you out of future searches we have to keep one measurement of
          your face for this album — otherwise re-processing the photographs
          would simply find you again. It is only used to exclude you, no
          operator can read it, and it is deleted with the rest of the album.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {phase === "intro" ? (
        <>
          <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5 text-sm">
            <p>
              Take a quick selfie and we will delete every face measurement of you
              in this album, and keep you out of every future search of it.
            </p>
            <p className="mt-3 text-[var(--color-muted)]">
              The photographs themselves belong to the photographer and are not
              deleted by this — but you will not be findable in them.
            </p>
          </div>
          <button type="button" className={`${buttonClass} w-full py-3`} onClick={start}>
            Turn on the camera
          </button>
        </>
      ) : null}

      {phase === "ready" || phase === "working" ? (
        <>
          <div className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-black">
            <video ref={videoRef} playsInline muted autoPlay className="mirror aspect-[3/4] w-full object-cover" />
          </div>
          <button
            type="button"
            className={`${buttonClass} w-full py-3`}
            disabled={phase === "working"}
            onClick={submit}
          >
            {phase === "working" ? "Removing…" : "Remove me from this album"}
          </button>
        </>
      ) : null}

      {phase === "error" ? (
        <div className="space-y-3">
          <p className="rounded-lg border border-[var(--color-warn-line)] bg-[var(--color-warn-bg)] p-3 text-sm text-[var(--color-warn-ink)]">
            {message}
          </p>
          <button type="button" className={secondaryButtonClass} onClick={() => setPhase("intro")}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}
