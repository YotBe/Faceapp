import { NextResponse } from "next/server";

/**
 * Redirect to a path on the same origin.
 *
 * `NextResponse.redirect(new URL(path, request.url))` is the obvious way to do
 * this and it is subtly wrong: `request.url` reflects the server's own notion of
 * its host, not the host the browser actually used. Behind a proxy, on a
 * different interface, or simply visiting 127.0.0.1 when the server thinks it is
 * localhost, that produces a cross-origin redirect — and the session cookie,
 * scoped to the original origin, is not sent to the new one. The symptom is a
 * login that succeeds and lands back on the login page.
 *
 * A relative Location header (RFC 7231 §7.1.2) sidesteps all of it: the browser
 * resolves it against whatever origin it is already on.
 */
export function redirectTo(path: string, status: 303 | 302 = 303): NextResponse {
  if (!path.startsWith("/")) {
    throw new Error(`refusing to redirect off-origin: ${path}`);
  }
  return new NextResponse(null, { status, headers: { location: path } });
}
