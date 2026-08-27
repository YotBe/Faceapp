import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

import { BUCKET, storage, verifySignature } from "@/lib/storage";

/**
 * Serves a stored object, but only to someone holding a valid, unexpired
 * signature.
 *
 * This is the local-storage stand-in for an R2 or Supabase Storage signed URL,
 * and it has the property that matters: a link an attendee is given stops
 * working. Without an expiry, one shared URL turns into permanent public access
 * to a photograph of somebody, which is the failure mode behind most "the whole
 * album leaked" stories in this product category.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

export async function GET(
  request: Request,
  context: { params: Promise<{ bucket: string; key: string[] }> },
) {
  const { bucket, key: segments } = await context.params;
  const key = segments.join("/");

  const url = new URL(request.url);
  const expires = Number(url.searchParams.get("exp"));
  const signature = url.searchParams.get("sig") ?? "";

  if (bucket !== BUCKET || !verifySignature(bucket, key, expires, signature)) {
    // One status for a bad signature, an expired one and a missing file. Telling
    // them apart would let someone probe which storage keys exist.
    return new NextResponse("not found", { status: 404 });
  }

  let path: string;
  try {
    path = storage.path(bucket, key);
    await stat(path);
  } catch {
    return new NextResponse("not found", { status: 404 });
  }

  const extension = key.split(".").pop()?.toLowerCase() ?? "";
  const stream = Readable.toWeb(
    createReadStream(path),
  ) as unknown as ReadableStream;

  return new NextResponse(stream, {
    headers: {
      "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      // Private: a shared cache must never hold a photograph of somebody keyed
      // by a URL whose signature has since expired.
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}
