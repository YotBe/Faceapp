import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Event photo face search",
  description:
    "Attendees find the photos they appear in. Photos and face data are deleted automatically after the event.",
};

// Props are written out rather than using Next's generated `LayoutProps` helper:
// that type only exists after `next typegen` has run, so a fresh clone fails
// `tsc --noEmit` before it has ever built. CI should not need a build to
// typecheck.
export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
