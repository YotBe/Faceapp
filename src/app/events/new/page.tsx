import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { Card, Field, Nav, buttonClass, inputClass } from "@/components/Chrome";
import { getSession } from "@/lib/auth";
import { listJurisdictions } from "@/lib/events";

export const dynamic = "force-dynamic";

export default async function NewEventPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}): Promise<ReactNode> {
  const session = await getSession();
  if (!session) redirect("/login");

  const { error } = await searchParams;
  const jurisdictions = await listJurisdictions();
  const allowed = jurisdictions.filter((j) => j.allowed);
  const blocked = jurisdictions.filter((j) => !j.allowed);

  return (
    <>
      <Nav email={session.email} />
      <main className="mx-auto max-w-2xl px-6 py-8">
        <h1 className="text-xl font-semibold tracking-tight">New event</h1>

        {error ? (
          <p className="mt-4 rounded-lg border border-[var(--color-warn-line)] bg-[var(--color-warn-bg)] px-3 py-2 text-sm text-[var(--color-warn-ink)]">
            {error}
          </p>
        ) : null}

        <Card className="mt-5 p-5">
          <form action="/api/events" method="post" className="space-y-5">
            <Field label="Event name">
              <input className={inputClass} name="name" required maxLength={200} />
            </Field>

            <Field
              label="Where is the event"
              hint="Blocked jurisdictions are refused by the database, not by this form."
            >
              <select className={inputClass} name="jurisdiction" defaultValue="IL">
                {allowed.map((j) => (
                  <option key={j.code} value={j.code}>
                    {j.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Delete everything after"
              hint="Days from now. Capped at 180 — an event album is not permanent storage."
            >
              <input
                className={inputClass}
                type="number"
                name="retentionDays"
                defaultValue={60}
                min={1}
                max={180}
                required
              />
            </Field>

            <Field
              label="Link to your photography notice"
              hint="Optional but recorded. As controller you owe attendees notice that photographs are taken and face matching is offered."
            >
              <input className={inputClass} type="url" name="consentNoticeUrl" placeholder="https://" />
            </Field>

            <label className="flex items-start gap-3 rounded-lg border border-[var(--color-line)] p-3">
              <input type="checkbox" name="isYouthEvent" className="mt-1" />
              <span className="text-sm">
                <span className="font-medium">This is a school or youth event</span>
                <span className="mt-0.5 block text-[var(--color-muted)]">
                  The album cannot be opened for search until you record a separate
                  attestation that parental consent has been handled.
                </span>
              </span>
            </label>

            <button className={buttonClass} type="submit">
              Create event
            </button>
          </form>
        </Card>

        <Card className="mt-5 p-5">
          <h2 className="text-sm font-medium">Not currently accepted</h2>
          <ul className="mt-2 space-y-1.5 text-xs text-[var(--color-muted)]">
            {blocked.map((j) => (
              <li key={j.code}>
                <span className="font-medium text-[var(--color-ink)]">{j.name}</span> — {j.reason}
              </li>
            ))}
          </ul>
        </Card>
      </main>
    </>
  );
}
