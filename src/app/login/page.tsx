import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { Card, Field, buttonClass, inputClass } from "@/components/Chrome";
import { getSession } from "@/lib/auth";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}): Promise<ReactNode> {
  if (await getSession()) redirect("/dashboard");
  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-12">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Operator sign in</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Attendees do not sign in. They open the event link and take a selfie.
        </p>
      </div>

      {error ? (
        <p className="rounded-lg border border-[var(--color-warn-line)] bg-[var(--color-warn-bg)] px-3 py-2 text-sm text-[var(--color-warn-ink)]">
          {error}
        </p>
      ) : null}

      <Card className="p-5">
        <form action="/api/auth/login" method="post" className="space-y-4">
          <Field label="Email">
            <input className={inputClass} type="email" name="email" required autoComplete="email" />
          </Field>
          <Field label="Password">
            <input
              className={inputClass}
              type="password"
              name="password"
              required
              autoComplete="current-password"
            />
          </Field>
          <button className={`${buttonClass} w-full`} type="submit">
            Sign in
          </button>
        </form>
      </Card>

      <p className="text-center text-sm text-[var(--color-muted)]">
        No account? <Link href="/signup" className="underline underline-offset-2">Create one</Link>
      </p>
    </main>
  );
}
