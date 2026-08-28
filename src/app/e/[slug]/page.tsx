import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { UntrustedThresholdBanner } from "@/components/Chrome";
import { SelfieCapture } from "@/components/SelfieCapture";
import { asService } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * The attendee page.
 *
 * No account, no app, no signup. The slug in the URL is the whole credential,
 * which is why slugs are random rather than derived from the event name.
 */

async function loadEvent(slug: string) {
  return asService(async (db) => {
    const { rows } = await db.query<{
      name: string;
      status: string;
      is_demo: boolean;
      welcome_message: string | null;
      delete_after: string;
    }>(
      `select name, status, is_demo, welcome_message, delete_after
         from events where slug = $1 and delete_after > now()`,
      [slug],
    );
    return rows[0] ?? null;
  });
}

export default async function AttendeePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<ReactNode> {
  const { slug } = await params;
  const event = await loadEvent(slug);
  if (!event) notFound();

  return (
    <main className="mx-auto min-h-screen max-w-xl px-5 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{event.name}</h1>
        {event.welcome_message ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">{event.welcome_message}</p>
        ) : null}
      </header>

      {event.is_demo ? (
        <div className="mb-6">
          <UntrustedThresholdBanner />
        </div>
      ) : null}

      {event.status !== "ready" ? (
        <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
          <h2 className="font-medium">Not ready yet</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            The photographer is still uploading this album. Check back shortly.
          </p>
        </div>
      ) : (
        <SelfieCapture slug={slug} eventName={event.name} />
      )}

      <footer className="mt-10 space-y-2 border-t border-[var(--color-line)] pt-5 text-xs leading-relaxed text-[var(--color-muted)]">
        <p>
          Your selfie is used once, to match against this album only, and is
          deleted within a minute. It is never linked to your name and never used
          for any other event.
        </p>
        <p>
          This whole album, including every face measurement taken from it, is
          deleted on {new Date(event.delete_after).toLocaleDateString()}.
        </p>
        <p>
          <a href={`/e/${slug}/opt-out`} className="underline underline-offset-2">
            Do not want to be findable here?
          </a>
        </p>
      </footer>
    </main>
  );
}
