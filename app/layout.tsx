/**
 * app/layout.tsx
 *
 * Root layout: the <html> and <body> for every page, and the one place the
 * global stylesheet is imported. The dark background is set here as well as
 * in the page shells so that overscroll, and the instant before a page
 * paints, are dark too.
 */
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "SteamGauge",
  description: "See your Steam library, backlog, deals and price drops at a glance.",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#09090b",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="bg-zinc-950">
      <body className="bg-zinc-950 text-zinc-100 antialiased">{children}</body>
    </html>
  );
}
