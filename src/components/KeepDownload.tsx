"use client";

import { useState } from "react";

import { buttonClass } from "./Chrome";

/**
 * The zip button on a re-opened result link.
 *
 * Goes through the same `/api/download` the search results use. That route
 * refuses to hand over an album — the caller has to name every photograph and
 * each id is checked against the event — so pointing this page at it adds no
 * new way to reach anything.
 */
export function KeepDownload({ slug, photoIds }: { slug: string; photoIds: string[] }) {
  const [downloading, setDownloading] = useState(false);

  if (photoIds.length === 0) return null;

  return (
    <button
      type="button"
      className={`${buttonClass} w-full py-3 text-base`}
      disabled={downloading}
      onClick={async () => {
        setDownloading(true);
        try {
          const response = await fetch("/api/download", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ slug, photoIds }),
          });
          if (!response.ok) return;
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = "my-photos.zip";
          link.click();
          URL.revokeObjectURL(url);
        } finally {
          setDownloading(false);
        }
      }}
    >
      {downloading ? "Preparing…" : `Download ${photoIds.length}`}
    </button>
  );
}
