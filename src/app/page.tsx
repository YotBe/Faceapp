import type { ReactNode } from "react";

/**
 * Placeholder.
 *
 * There is no product UI yet, and that is deliberate: the build order puts the
 * schema, the retention machinery and the evaluation harness ahead of anything
 * anyone can look at. The attendee capture flow lands in Phase 3, once there is
 * a measured threshold for it to use.
 */
export default function Home(): ReactNode {
  return (
    <main className="mx-auto flex max-w-2xl flex-1 flex-col justify-center gap-6 px-6 py-24">
      <h1 className="text-2xl font-semibold tracking-tight">
        Event photo face search
      </h1>
      <p className="text-balance leading-relaxed text-neutral-600 dark:text-neutral-400">
        Foundations only. The database schema, retention enforcement and the
        evaluation harness are in place; the attendee capture flow is not built
        yet.
      </p>
      <ul className="space-y-2 text-sm text-neutral-600 dark:text-neutral-400">
        <li>
          <code className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
            supabase/tests/run.sh
          </code>{" "}
          — schema, row-level security and retention acceptance tests
        </li>
        <li>
          <code className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
            ml/
          </code>{" "}
          — face detection, embedding and the threshold evaluation harness
        </li>
        <li>
          <code className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
            docs/COMPLIANCE.md
          </code>{" "}
          — data flow, retention matrix and deletion jobs
        </li>
      </ul>
    </main>
  );
}
