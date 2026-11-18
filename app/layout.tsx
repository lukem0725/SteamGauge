/**
 * app/layout.tsx
 *
 * Root layout: the <html> and <body> for every page, and the one place the
 * global stylesheet is imported. <Providers> wraps everything in <body>, so
 * the TanStack Query client is available to every client component,
 * including the global search in the top bar. The dark background is set here as well as
 * in the page shells so that overscroll, and the instant before a page
 * paints, are dark too.
 */
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { Providers } from "@/components/providers";

import "./globals.css";

export const metadata: Metadata = {
  title: "SteamGauge",
  description: "See your Steam library, backlog, deals and price drops at a glance.",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0b0e14",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="bg-page">
      <body className="bg-page text-slate-100 antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
