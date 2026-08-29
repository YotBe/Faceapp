import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import QRCode from "qrcode";
import type { ReactNode } from "react";

import { Card, Nav, UntrustedThresholdBanner } from "@/components/Chrome";
import { Uploader } from "@/components/Uploader";
import { getSession } from "@/lib/auth";
import { asOperator } from "@/lib/db";
import {
  failedPhotos,
  getEvent,
  ingestProgress,
  recentSearches,
  summariseSearches,
} from "@/lib/events";
import { UntunedThresholdError, loadThresholds } from "@/lib/thresholds";

export const dynamic = "force-dynamic";

/**
 * One search's top score, against the threshold that decided it.
 *
 * The number on its own says nothing; the number next to the line it had to
 * clear says everything. A run full of misses at 0.48 against a T_high of 0.50
 * is a threshold slightly too strict for this album — which looks exactly like
 * "the product does not work" when all you have is the attendee telling you
 * they got nothing.
 */
function ScoreBar({
  score,
  tHigh,
  tLow,
}: {
  score: number | null;
  tHigh?: number;
  tLow?: number;
}) {
  if (score === null) return <span className="text-[var(--color-muted)]">—</span>;

  // A fixed window rather than one scaled to the data: the marks have to sit in
  // the same place on every row, and cosine similarity on these embeddings does
  // not meaningfully leave it.
  const lo = 0.2;
  const hi = 0.8;
  const pct = (v: number) => `${Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100))}%`;
  const cleared = tHigh !== undefined && score >= tHigh;

  return (
    <span className="flex items-center gap-2">
      <span className="relative h-3 w-28 overflow-hidden rounded-sm bg-[var(--color-canvas)]">
        <span
          className={`absolute inset-y-0 left-0 ${
            cleared ? "bg-[var(--color-accent)]" : "bg-[var(--color-muted)]"
          }`}
          style={{ width: pct(score) }}
        />
        {tLow !== undefined ? (
          <span
            className="absolute inset-y-0 w-px bg-[var(--color-line)]"
            style={{ left: pct(tLow) }}
            title={`T_low ${tLow}`}
          />
        ) : null}
        {tHigh !== undefined ? (
          <span
            className="absolute inset-y-0 w-px bg-[var(--color-ink)]"
            style={{ left: pct(tHigh) }}
            title={`T_high ${tHigh}`}
          />
        ) : null}
      </span>
      <span className="tabular-nums">{score.toFixed(3)}</span>
    </span>
  );
}

const OUTCOME_LABEL: Record<string, string> = {
  ok: "found photos",
  no_match: "nothing matched",
  rate_limited: "rate limited",
  rejected_quality: "capture rejected",
  error: "failed",
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div>
      <div className="text-xs text-[var(--color-muted)]">{label}</div>
      <div
        className={`mt-0.5 text-lg font-semibold ${
          tone === "warn" ? "text-[var(--color-warn-ink)]" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

export default async function EventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<ReactNode> {
  const session = await getSession();
  if (!session) redirect("/login");

  const { id } = await params;
  const event = await getEvent(session.operatorId, id);
  if (!event) notFound();

  const { progress, failures, searches } = await asOperator(
    session.operatorId,
    async (db) => ({
      progress: await ingestProgress(db, id),
      failures: await failedPhotos(db, id),
      searches: await recentSearches(db, id),
    }),
  );
  const searchStats = summariseSearches(searches);

  let thresholdState:
    | { trusted: boolean; source: string; tHigh: number; tLow: number }
    | { error: string };
  try {
    const t = await loadThresholds({ allowUntuned: event.is_demo });
    thresholdState = { trusted: t.trusted, source: t.source, tHigh: t.tHigh, tLow: t.tLow };
  } catch (error) {
    thresholdState = {
      error:
        error instanceof UntunedThresholdError
          ? error.message
          : "thresholds could not be loaded",
    };
  }

  const shareUrl = `/e/${event.slug}`;
  const qr = await QRCode.toString(shareUrl, {
    type: "svg",
    margin: 1,
    width: 160,
    color: { light: "#0000" },
  });

  const totalDetections = event.face_count + event.faces_rejected;
  const rejectionRate = totalDetections ? event.faces_rejected / totalDetections : 0;
  const inFlight = progress.pending + progress.running;

  return (
    <>
      <Nav email={session.email} />
      <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <div>
          <Link href="/dashboard" className="text-sm text-[var(--color-muted)] underline underline-offset-2">
            ← All events
          </Link>
          <h1 className="mt-2 text-xl font-semibold tracking-tight">{event.name}</h1>
        </div>

        {"error" in thresholdState ? (
          <Card className="border-[var(--color-warn-line)] bg-[var(--color-warn-bg)] p-5 text-sm text-[var(--color-warn-ink)]">
            <p className="font-semibold">Search is disabled</p>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-xs leading-relaxed">
              {thresholdState.error}
            </pre>
          </Card>
        ) : !thresholdState.trusted ? (
          <UntrustedThresholdBanner source={thresholdState.source} />
        ) : null}

        <Card className="p-5">
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-5">
            <Stat label="Photos" value={event.photo_count.toLocaleString()} />
            <Stat label="Faces indexed" value={event.face_count.toLocaleString()} />
            <Stat
              label="Detections rejected"
              value={
                totalDetections
                  ? `${event.faces_rejected.toLocaleString()} (${Math.round(rejectionRate * 100)}%)`
                  : "—"
              }
              {...(rejectionRate > 0.6 ? { tone: "warn" as const } : {})}
            />
            <Stat label="Queued" value={inFlight.toLocaleString()} />
            <Stat
              label="Failed"
              {...(progress.failed > 0 ? { tone: "warn" as const } : {})}
              value={progress.failed.toLocaleString()}
            />
          </div>

          {rejectionRate > 0.6 && totalDetections > 0 ? (
            <p className="mt-4 rounded-lg border border-[var(--color-warn-line)] bg-[var(--color-warn-bg)] px-3 py-2 text-sm text-[var(--color-warn-ink)]">
              <strong>{Math.round(rejectionRate * 100)}% of detected faces were
              too small or too uncertain to index.</strong> This album is mostly
              wide crowd shots. Attendees will find fewer of their photographs
              than you expect — tell them so before the event rather than after.
            </p>
          ) : null}

          {inFlight > 0 ? (
            <div className="mt-4">
              <div className="mb-1.5 flex justify-between text-xs text-[var(--color-muted)]">
                <span>Indexing</span>
                <span>
                  {progress.done} of {progress.done + inFlight + progress.failed}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-canvas)]">
                <div
                  className="h-full rounded-full bg-[var(--color-accent)] transition-all"
                  style={{
                    width: `${Math.round(
                      (progress.done / Math.max(1, progress.done + inFlight + progress.failed)) * 100,
                    )}%`,
                  }}
                />
              </div>
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                Refresh to update. The worker must be running:{" "}
                <code>cd ml &amp;&amp; python -m faceapp_worker.ingest</code>
              </p>
            </div>
          ) : null}
        </Card>

        <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
          <Card className="p-5">
            <h2 className="font-medium">Upload the album</h2>
            <p className="mt-1 mb-4 text-sm text-[var(--color-muted)]">
              JPEG, PNG or WebP. Uploading the same folder twice is safe — files
              already stored are recognised and skipped.
            </p>
            <Uploader eventId={event.id} />
          </Card>

          <Card className="p-5">
            <h2 className="font-medium">Attendee link</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {event.status === "ready"
                ? "Share this. No app, no signup."
                : "Available once indexing finishes."}
            </p>
            <div
              className="mx-auto mt-4 w-40 text-[var(--color-ink)]"
              dangerouslySetInnerHTML={{ __html: qr }}
            />
            <p className="mt-3 break-all text-center font-mono text-xs text-[var(--color-muted)]">
              {shareUrl}
            </p>
            <Link
              href={shareUrl}
              className="mt-3 block text-center text-sm underline underline-offset-2"
            >
              Open attendee page
            </Link>
          </Card>
        </div>

        {searches.length ? (
          <Card className="p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="font-medium">Searches</h2>
              <p className="text-sm text-[var(--color-muted)]">
                {searches.length === 1
                  ? "One attempt so far."
                  : `The last ${searches.length} attempts.`}{" "}
                No IP, no selfie, no embedding — this is what was already being
                recorded.
              </p>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-5 sm:grid-cols-5">
              <Stat label="Found photos" value={searchStats.found.toLocaleString()} />
              <Stat
                label="Matched nothing"
                value={searchStats.empty.toLocaleString()}
                {...(searchStats.empty > searchStats.found ? { tone: "warn" as const } : {})}
              />
              <Stat label="Capture rejected" value={searchStats.poorCapture.toLocaleString()} />
              <Stat
                label="Failed"
                value={searchStats.failed.toLocaleString()}
                {...(searchStats.failed > 0 ? { tone: "warn" as const } : {})}
              />
              <Stat
                label="Median time"
                value={
                  searchStats.medianDurationMs === null
                    ? "—"
                    : `${(searchStats.medianDurationMs / 1000).toFixed(1)}s`
                }
              />
            </div>

            {searchStats.bestMiss !== null &&
            !("error" in thresholdState) &&
            searchStats.bestMiss >= thresholdState.tLow ? (
              <p className="mt-4 rounded-lg border border-[var(--color-warn-line)] bg-[var(--color-warn-bg)] px-3 py-2 text-sm text-[var(--color-warn-ink)]">
                <strong>
                  A search that returned nothing had a best score of{" "}
                  {searchStats.bestMiss.toFixed(3)}, against a T_high of{" "}
                  {thresholdState.tHigh}.
                </strong>{" "}
                That is a near miss rather than a stranger: someone who is in this
                album did not get their photographs. If it keeps happening, the
                thresholds were measured on an album easier than this one — re-run
                the eval against this one rather than editing the numbers.
              </p>
            ) : null}

            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-[var(--color-muted)]">
                  <tr>
                    <th className="pb-2 font-medium">When</th>
                    <th className="pb-2 font-medium">Outcome</th>
                    <th className="pb-2 font-medium">Returned</th>
                    <th className="pb-2 font-medium">Best score</th>
                    <th className="pb-2 font-medium">Took</th>
                  </tr>
                </thead>
                <tbody className="align-middle">
                  {searches.map((search) => (
                    <tr key={search.created_at} className="border-t border-[var(--color-line)]">
                      <td className="py-2 pr-3 tabular-nums text-[var(--color-muted)]">
                        {new Date(search.created_at).toLocaleTimeString()}
                      </td>
                      <td className="py-2 pr-3">
                        {OUTCOME_LABEL[search.outcome] ?? search.outcome}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {search.results_returned}
                        {search.maybe_returned > 0 ? (
                          <span className="text-[var(--color-muted)]">
                            {" "}
                            + {search.maybe_returned} maybe
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">
                        <ScoreBar
                          score={search.top_score}
                          {...("error" in thresholdState
                            ? {}
                            : { tHigh: thresholdState.tHigh, tLow: thresholdState.tLow })}
                        />
                      </td>
                      <td className="py-2 tabular-nums text-[var(--color-muted)]">
                        {search.duration_ms === null
                          ? "—"
                          : `${(search.duration_ms / 1000).toFixed(1)}s`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}

        {failures.length ? (
          <Card className="p-5">
            <h2 className="font-medium">Photos that could not be indexed</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              These exhausted their retries. They stay in the album but are not
              searchable.
            </p>
            <ul className="mt-3 space-y-1.5 font-mono text-xs">
              {failures.map((photo) => (
                <li key={photo.id} className="flex gap-3">
                  <span className="text-[var(--color-muted)]">{photo.storage_key.split("/").pop()}</span>
                  <span className="text-[var(--color-warn-ink)]">{photo.error}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <Card className="p-5 text-sm">
          <h2 className="font-medium">Retention</h2>
          <p className="mt-1 text-[var(--color-muted)]">
            Every photograph, preview, thumbnail and face vector in this event is
            deleted on{" "}
            <strong className="text-[var(--color-ink)]">
              {new Date(event.delete_after).toLocaleDateString()}
            </strong>
            . A record of the deletion is kept; the data is not.
          </p>
        </Card>
      </main>
    </>
  );
}
