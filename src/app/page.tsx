import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { buttonClass, secondaryButtonClass } from "@/components/Chrome";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home(): Promise<ReactNode> {
  if (await getSession()) redirect("/dashboard");

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-balance">
          Attendees find the photos they are in. Nothing else.
        </h1>
        <p className="mt-3 leading-relaxed text-[var(--color-muted)]">
          Upload the album, share one link. Guests take a selfie and get their
          photographs back — no app, no signup, no account. Everything deletes
          itself on a date you set.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Link href="/signup" className={buttonClass}>
          Create an operator account
        </Link>
        <Link href="/login" className={secondaryButtonClass}>
          Sign in
        </Link>
      </div>

      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5 text-sm leading-relaxed text-[var(--color-muted)]">
        <p className="font-medium text-[var(--color-ink)]">
          Face data is handled as biometric data, because it is.
        </p>
        <p className="mt-2">
          Selfies are deleted within a minute of the search that used them and are
          never stored. Face measurements are scoped to a single event and never
          linked across albums or to a name. Anyone can remove themselves from an
          album without an account. Events in Illinois, Texas and Washington are
          refused.
        </p>
      </div>
    </main>
  );
}
