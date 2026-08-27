"use client";

import { useCallback, useRef, useState } from "react";

import { buttonClass, secondaryButtonClass } from "./Chrome";

/**
 * Album upload.
 *
 * Batched and concurrent rather than one giant request: a 5,000-file album is
 * not a single POST, and a browser that drops its connection at 94% must not
 * have to start again. Each batch is independently retried, and the server side
 * is idempotent, so a retry that actually succeeded the first time is harmless.
 */

const BATCH_SIZE = 10;
const CONCURRENCY = 3;
const MAX_RETRIES = 3;

interface Props {
  eventId: string;
}

type Phase = "idle" | "uploading" | "done" | "error";

export function Uploader({ eventId }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [total, setTotal] = useState(0);
  const [sent, setSent] = useState(0);
  const [skipped, setSkipped] = useState<{ name: string; reason: string }[]>([]);
  const [failed, setFailed] = useState<string[]>([]);

  const upload = useCallback(
    async (files: File[]) => {
      setPhase("uploading");
      setTotal(files.length);
      setSent(0);
      setSkipped([]);
      setFailed([]);

      const batches: File[][] = [];
      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        batches.push(files.slice(i, i + BATCH_SIZE));
      }

      let cursor = 0;
      const allSkipped: { name: string; reason: string }[] = [];
      const allFailed: string[] = [];

      async function worker() {
        while (cursor < batches.length) {
          const batch = batches[cursor++];
          if (!batch) return;

          let lastError = "";
          let ok = false;

          for (let attempt = 0; attempt < MAX_RETRIES && !ok; attempt++) {
            if (attempt > 0) {
              // 400ms, 800ms, 1600ms. A flaky connection at an event venue is
              // the normal case, not the exception.
              await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
            }
            try {
              const body = new FormData();
              for (const file of batch) body.append("files", file);

              const response = await fetch(`/api/events/${eventId}/upload`, {
                method: "POST",
                body,
              });
              if (!response.ok) {
                lastError = `${response.status}`;
                continue;
              }
              const result = (await response.json()) as {
                accepted: number;
                skipped: { name: string; reason: string }[];
              };
              allSkipped.push(...result.skipped);
              ok = true;
            } catch (error) {
              lastError = error instanceof Error ? error.message : "network error";
            }
          }

          if (!ok) allFailed.push(...batch.map((f) => `${f.name} (${lastError})`));

          setSent((n) => n + batch.length);
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker),
      );

      setSkipped(allSkipped);
      setFailed(allFailed);
      setPhase(allFailed.length ? "error" : "done");

      // Reload so the server-rendered progress and counts reflect the upload.
      if (!allFailed.length) setTimeout(() => window.location.reload(), 600);
    },
    [eventId],
  );

  const percent = total ? Math.round((sent / total) * 100) : 0;

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length) void upload(files);
        }}
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={buttonClass}
          disabled={phase === "uploading"}
          onClick={() => inputRef.current?.click()}
        >
          {phase === "uploading" ? "Uploading…" : "Choose photos"}
        </button>
        {phase === "uploading" ? (
          <span className="text-sm text-[var(--color-muted)]">
            {sent} of {total}
          </span>
        ) : null}
        {phase === "done" ? (
          <span className="text-sm text-[var(--color-muted)]">
            Uploaded. Indexing starts automatically.
          </span>
        ) : null}
      </div>

      {phase === "uploading" ? (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-canvas)]">
          <div
            className="h-full rounded-full bg-[var(--color-accent)] transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}

      {skipped.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-[var(--color-muted)]">
            {skipped.length} skipped
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-[var(--color-muted)]">
            {skipped.slice(0, 20).map((s) => (
              <li key={s.name}>
                {s.name} — {s.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {failed.length ? (
        <div className="rounded-lg border border-[var(--color-warn-line)] bg-[var(--color-warn-bg)] p-3 text-sm text-[var(--color-warn-ink)]">
          <p className="font-medium">{failed.length} files could not be uploaded</p>
          <p className="mt-1 text-xs">
            Re-selecting the same folder is safe — files already uploaded are
            recognised and skipped.
          </p>
          <button
            type="button"
            className={`${secondaryButtonClass} mt-2`}
            onClick={() => inputRef.current?.click()}
          >
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}
