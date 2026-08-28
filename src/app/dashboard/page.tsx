import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { Card, Nav, buttonClass } from "@/components/Chrome";
import { getSession } from "@/lib/auth";
import { listEvents } from "@/lib/events";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  indexing: "Indexing",
  ready: "Open for search",
  expired: "Expired",
};

function daysLeft(deleteAfter: string): number {
  return Math.ceil((new Date(deleteAfter).getTime() - Date.now()) / 86_400_000);
}

export default async function DashboardPage(): Promise<ReactNode> {
  const session = await getSession();
  if (!session) redirect("/login");

  const events = await listEvents(session.operatorId);

  return (
    <>
      <Nav email={session.email} />
      <main className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Your events</h1>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Each album deletes itself on its retention date. That is enforced by
              a scheduled job, not by a reminder.
            </p>
          </div>
          <Link href="/events/new" className={buttonClass}>
            New event
          </Link>
        </div>

        {events.length === 0 ? (
          <Card className="p-10 text-center">
            <p className="text-sm text-[var(--color-muted)]">
              No events yet. Create one, upload an album, and share the link.
            </p>
          </Card>
        ) : (
          <div className="space-y-3">
            {events.map((event) => {
              const remaining = daysLeft(event.delete_after);
              return (
                <Link key={event.id} href={`/events/${event.id}`} className="block">
                  <Card className="p-5 transition hover:border-[var(--color-accent)]">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h2 className="truncate font-medium">{event.name}</h2>
                          {event.is_demo ? (
                            <span className="rounded bg-[var(--color-warn-bg)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-warn-ink)]">
                              Demo — results not trustworthy
                            </span>
                          ) : null}
                          {event.is_youth_event ? (
                            <span className="rounded bg-[var(--color-warn-bg)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-warn-ink)]">
                              Youth event
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 font-mono text-xs text-[var(--color-muted)]">
                          /e/{event.slug}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-6 text-sm">
                        <div className="text-right">
                          <div className="text-[var(--color-muted)]">Photos</div>
                          <div className="font-medium">{event.photo_count.toLocaleString()}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-[var(--color-muted)]">Faces</div>
                          <div className="font-medium">{event.face_count.toLocaleString()}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-[var(--color-muted)]">Deletes in</div>
                          <div className={remaining <= 7 ? "font-medium text-[var(--color-warn-ink)]" : "font-medium"}>
                            {remaining} {remaining === 1 ? "day" : "days"}
                          </div>
                        </div>
                        <div className="w-32 text-right">
                          <div className="text-[var(--color-muted)]">Status</div>
                          <div className="font-medium">{STATUS_LABEL[event.status] ?? event.status}</div>
                        </div>
                      </div>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}
