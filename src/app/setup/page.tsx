import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Card } from "@/components/Chrome";
import { getSession } from "@/lib/auth";
import { type Check, runDiagnostics } from "@/lib/diagnostics";
import { configProblems } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * What is actually wrong with this deployment.
 *
 * Readable while the deployment is unconfigured — you cannot sign in yet, and
 * that is precisely when you need it — and to a signed-in operator afterwards.
 * Once everything is set up and nobody is signed in it 404s, because a working
 * deployment should not publish the state of its own infrastructure.
 */

const TONE: Record<Check["state"], { mark: string; className: string }> = {
  pass: { mark: "✓", className: "text-emerald-600 dark:text-emerald-400" },
  warn: { mark: "!", className: "text-[var(--color-warn-ink)]" },
  fail: { mark: "✕", className: "text-red-600 dark:text-red-400" },
};

export default async function SetupPage(): Promise<ReactNode> {
  const bootstrapping = configProblems().length > 0;
  const session = bootstrapping ? null : await getSession();
  if (!bootstrapping && !session) notFound();

  const checks = await runDiagnostics();
  const failures = checks.filter((c) => c.state === "fail").length;
  const warnings = checks.filter((c) => c.state === "warn").length;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-xl font-semibold tracking-tight">Setup</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        {failures === 0
          ? warnings === 0
            ? "Everything this deployment needs is present and answering."
            : `Working, with ${warnings} thing${warnings === 1 ? "" : "s"} worth knowing about.`
          : `${failures} thing${failures === 1 ? "" : "s"} still to fix.`}
      </p>

      <Card className="mt-6 divide-y divide-[var(--color-line)]">
        {checks.map((check) => {
          const tone = TONE[check.state];
          return (
            <div key={check.name} className="flex gap-3 p-4">
              <span className={`mt-0.5 font-mono font-bold ${tone.className}`}>
                {tone.mark}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-medium">{check.name}</span>
                  <span className="font-mono text-xs break-all text-[var(--color-muted)]">
                    {check.detail}
                  </span>
                </div>
                {check.fix ? (
                  <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-muted)]">
                    {check.fix}
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </Card>

      <p className="mt-6 text-sm text-[var(--color-muted)]">
        Step-by-step instructions are in{" "}
        <code className="rounded bg-[var(--color-canvas)] px-1.5 py-0.5 text-xs">
          docs/DEPLOY_WALKTHROUGH.md
        </code>
        .
      </p>

      {failures === 0 ? (
        <p className="mt-3 text-sm">
          <Link href="/" className="underline underline-offset-2">
            Go to the app
          </Link>
        </p>
      ) : null}
    </main>
  );
}
