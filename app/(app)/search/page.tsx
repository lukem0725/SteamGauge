/**
 * /search?q=<title>  (v1.13)
 *
 * Public: global search results on their own page, for signed-in users and
 * signed-out visitors alike. The query is read here and handed to the
 * client view (components/search-view.tsx), which asks GET /api/search.
 */
import type { Metadata } from "next";

import { pageContainer } from "@/components/layout-width";
import { SearchView } from "@/components/search-view";

export const metadata: Metadata = { title: "Search · SteamGauge" };

// The results depend on the query string.
export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const raw = (await searchParams).q;
  const q = (Array.isArray(raw) ? raw[0] : raw)?.slice(0, 100) ?? "";
  return (
    <main className={pageContainer}>
      <SearchView initialQuery={q} />
    </main>
  );
}
