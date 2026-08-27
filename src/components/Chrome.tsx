import Link from "next/link";
import type { ReactNode } from "react";

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] ${className}`}
    >
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-medium">{label}</span>
      {children}
      {hint ? (
        <span className="block text-xs text-[var(--color-muted)]">{hint}</span>
      ) : null}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]";

export const buttonClass =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50";

export const secondaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--color-line)] px-4 py-2 text-sm font-medium transition hover:bg-[var(--color-canvas)]";

/**
 * The banner that appears wherever untrusted thresholds are in play.
 *
 * Loud on purpose. The whole threshold-provenance apparatus is worth nothing if
 * a demo built with placeholder numbers can be mistaken for a working product.
 */
export function UntrustedThresholdBanner({ source }: { source?: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-warn-line)] bg-[var(--color-warn-bg)] px-4 py-3 text-sm text-[var(--color-warn-ink)]">
      <p className="font-semibold">
        Development mode — these match results are not trustworthy
      </p>
      <p className="mt-1 leading-relaxed">
        The matching thresholds have not been measured on a labeled album, so this
        search is running on placeholder numbers. It may return photographs of
        other people and miss photographs of you. Do not use this for a real event.
      </p>
      {source ? <p className="mt-1 font-mono text-xs opacity-80">{source}</p> : null}
    </div>
  );
}

export function Nav({ email }: { email?: string }) {
  return (
    <header className="border-b border-[var(--color-line)] bg-[var(--color-surface)]">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
        <Link href="/dashboard" className="text-sm font-semibold tracking-tight">
          Event photo search
        </Link>
        {email ? (
          <div className="flex items-center gap-3 text-sm text-[var(--color-muted)]">
            <span className="hidden sm:inline">{email}</span>
            <form action="/api/auth/logout" method="post">
              <button type="submit" className="underline underline-offset-2">
                Sign out
              </button>
            </form>
          </div>
        ) : null}
      </div>
    </header>
  );
}
