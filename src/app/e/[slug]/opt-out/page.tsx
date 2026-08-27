import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { OptOut } from "@/components/OptOut";
import { asService } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function OptOutPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<ReactNode> {
  const { slug } = await params;

  const event = await asService(async (db) => {
    const { rows } = await db.query<{ name: string }>(
      "select name from events where slug = $1 and delete_after > now()",
      [slug],
    );
    return rows[0] ?? null;
  });
  if (!event) notFound();

  return (
    <main className="mx-auto min-h-screen max-w-xl px-5 py-8">
      <Link href={`/e/${slug}`} className="text-sm text-[var(--color-muted)] underline underline-offset-2">
        ← Back
      </Link>
      <h1 className="mt-3 mb-1 text-2xl font-semibold tracking-tight">
        Remove yourself
      </h1>
      <p className="mb-6 text-sm text-[var(--color-muted)]">from {event.name}</p>
      <OptOut slug={slug} />
    </main>
  );
}
