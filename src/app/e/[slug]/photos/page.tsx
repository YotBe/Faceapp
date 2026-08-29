import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { KeepDownload } from "@/components/KeepDownload";
import { asService, serviceTransaction } from "@/lib/db";
import { BadResultLink, verifyResultLink } from "@/lib/resultlink";
import { photosForFaces } from "@/lib/search";

export const dynamic = "force-dynamic";

/**
 * A search result, re-opened.
 *
 * The photographs are not stored anywhere against the person who found them —
 * the link carries the ids of the faces that matched, signed, and this page
 * resolves them against the live album. So there is no record joining anyone to
 * their photographs, nothing to delete when the event is deleted, and no way
 * for the link to keep working after the album is gone.
 *
 * It is also why the opt-out is re-applied here rather than trusted from when
 * the link was made: `photosForFaces` runs the same exclusion predicate the
 * search does, so a face purged by an opt-out stops resolving and the
 * photograph quietly leaves the page.
 */

function Explain({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto min-h-screen max-w-xl px-5 py-12">
      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
        {children}
      </div>
    </main>
  );
}

export default async function KeptPhotosPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ k?: string }>;
}): Promise<ReactNode> {
  const { slug } = await params;
  const { k } = await searchParams;

  if (!k) notFound();

  let link;
  try {
    link = verifyResultLink(k);
  } catch (error) {
    if (!(error instanceof BadResultLink)) throw error;
    return (
      <Explain>
        <h1 className="font-medium">This link no longer works</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">{error.message}.</p>
        <p className="mt-4 text-sm">
          <Link href={`/e/${slug}`} className="underline underline-offset-2">
            Search the album again
          </Link>{" "}
          to get a new one.
        </p>
      </Explain>
    );
  }

  const event = await asService(async (db) => {
    const { rows } = await db.query<{ id: string; name: string; delete_after: string }>(
      `select id, name, delete_after
         from events where slug = $1 and delete_after > now()`,
      [slug],
    );
    return rows[0] ?? null;
  });

  // The album is gone, or its retention date has passed. Either way the
  // photographs this link names no longer exist.
  if (!event) {
    return (
      <Explain>
        <h1 className="font-medium">This album has been deleted</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Every photograph and every face in it was erased on the date fixed when
          it was created. Nothing is kept beyond a record that the deletion
          happened.
        </p>
      </Explain>
    );
  }

  // A token minted for one album, opened under another album's slug. The
  // signature is intact — it is the wrong door, not a forgery — so this has to
  // be checked separately from verifying the link.
  if (event.id !== link.eventId) notFound();

  const photos = await serviceTransaction((db) =>
    photosForFaces(db, event.id, link.faceIds),
  );

  const expires = new Date(link.expiresAt * 1000);
  const deleteAfter = new Date(event.delete_after);

  return (
    <main className="mx-auto min-h-screen max-w-xl px-5 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{event.name}</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          {photos.length === 0
            ? "Nothing here any more."
            : `${photos.length} photo${photos.length === 1 ? "" : "s"} of you.`}
        </p>
      </header>

      {photos.length === 0 ? (
        <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 text-sm">
          <p>
            These photographs are not available any more. That happens when
            somebody in them asked to be removed from the album, or when the
            photographs themselves were deleted.
          </p>
          <p className="mt-3">
            <Link href={`/e/${slug}`} className="underline underline-offset-2">
              Search again
            </Link>{" "}
            to see what is still there.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            {photos.map((photo) => {
              const src = photo.thumbUrl ?? photo.previewUrl;
              if (!src) return null;
              return (
                <a
                  key={photo.photoId}
                  href={photo.previewUrl ?? src}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden rounded-lg border border-[var(--color-line)]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={src}
                    alt=""
                    className="aspect-square w-full object-cover"
                    loading="lazy"
                  />
                </a>
              );
            })}
          </div>

          <div className="mt-5">
            <KeepDownload slug={slug} photoIds={photos.map((photo) => photo.photoId)} />
          </div>
        </>
      )}

      <div className="mt-8 space-y-2 text-xs text-[var(--color-muted)]">
        <p>
          These are the confident matches from one search. Anything the search
          was unsure about was never put in a link — a borderline match is for a
          person to look at, not to forward.
        </p>
        <p>
          This link stops working on{" "}
          <strong className="text-[var(--color-ink)]">
            {expires.toLocaleDateString()}
          </strong>
          , and the album itself is deleted on{" "}
          <strong className="text-[var(--color-ink)]">
            {deleteAfter.toLocaleDateString()}
          </strong>
          . Anyone you send it to can see these photographs until then.
        </p>
        <p>
          <Link href={`/e/${slug}/opt-out`} className="underline underline-offset-2">
            Remove yourself from this album
          </Link>
        </p>
      </div>
    </main>
  );
}
