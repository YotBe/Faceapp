import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { buttonClass, secondaryButtonClass } from "@/components/Chrome";
import { getSession } from "@/lib/auth";
import { configProblems, storageProblems } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function Home(): Promise<ReactNode> {
  // Deliberately before the session check: reading a session needs APP_SECRET,
  // and an unconfigured deployment should explain itself rather than throw.
  const problems = [...configProblems(), ...storageProblems()];

  if (problems.length === 0 && (await getSession())) redirect("/dashboard");

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

      {problems.length > 0 ? (
        <div className="rounded-xl border border-[var(--color-warn-line)] bg-[var(--color-warn-bg)] p-5 text-sm text-[var(--color-warn-ink)]">
          <p className="font-semibold">This deployment is not finished being set up</p>
          <p className="mt-2 leading-relaxed">
            The application is here, but {problems.length}{" "}
            {problems.length === 1 ? "thing is" : "things are"} still missing.
            Until they are supplied there is nothing to sign in to.
          </p>
          <ul className="mt-4 space-y-3">
            {problems.map((problem) => (
              <li key={problem.variable}>
                <code className="font-mono text-xs font-semibold">
                  {problem.variable}
                </code>
                <span className="opacity-90"> — {problem.what}</span>
                <span className="mt-0.5 block text-xs opacity-80">{problem.how}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs leading-relaxed opacity-80">
            This product needs a database, an always-on Python service for the
            face model, a background worker, and durable object storage. A
            serverless host runs the web app; it does not run the other three.
            See the README.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <Link href="/signup" className={buttonClass}>
            Create an operator account
          </Link>
          <Link href="/login" className={secondaryButtonClass}>
            Sign in
          </Link>
        </div>
      )}

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
