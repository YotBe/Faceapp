import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { Card, Field, buttonClass, inputClass } from "@/components/Chrome";
import { getSession } from "@/lib/auth";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}): Promise<ReactNode> {
  if (await getSession()) redirect("/dashboard");
  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-12">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Create an operator account</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          For photographers and event organizers.
        </p>
      </div>

      {error ? (
        <p className="rounded-lg border border-[var(--color-warn-line)] bg-[var(--color-warn-bg)] px-3 py-2 text-sm text-[var(--color-warn-ink)]">
          {error}
        </p>
      ) : null}

      <Card className="p-5">
        <form action="/api/auth/signup" method="post" className="space-y-4">
          <Field label="Email">
            <input className={inputClass} type="email" name="email" required autoComplete="email" />
          </Field>
          <Field label="Password" hint="At least 10 characters.">
            <input
              className={inputClass}
              type="password"
              name="password"
              required
              minLength={10}
              autoComplete="new-password"
            />
          </Field>
          <button className={`${buttonClass} w-full`} type="submit">
            Create account
          </button>
        </form>
      </Card>

      <p className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3 text-xs leading-relaxed text-[var(--color-muted)]">
        By creating events you act as the data controller for the photographs you
        upload. You are responsible for posting a photography and biometric
        processing notice at the venue, and for parental consent at events
        involving children. See <code>docs/DPA-template.md</code>.
      </p>

      <p className="text-center text-sm text-[var(--color-muted)]">
        Already registered? <Link href="/login" className="underline underline-offset-2">Sign in</Link>
      </p>
    </main>
  );
}
