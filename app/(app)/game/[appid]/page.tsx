/**
 * app/(app)/game/[appid]/page.tsx
 *
 * One game's page, opened from the global search in the top bar or from
 * /search. Public since v1.13: it checks the App ID and hands off to the
 * client view (components/game-view.tsx), which loads everything through our
 * cached API. A session only turns "Sign in to watch" into "Watch".
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { GameView } from "@/components/game-view";
import { getCurrentSession } from "@/lib/auth/current-user";
import { appIdSchema } from "@/lib/validation";

export const metadata: Metadata = { title: "Game · SteamGauge" };

// Depends on a cookie: never prerender or cache this page.
export const dynamic = "force-dynamic";

export default async function GamePage({ params }: { params: Promise<{ appid: string }> }) {
  const appid = appIdSchema.safeParse((await params).appid);
  if (!appid.success) notFound();

  const session = await getCurrentSession().catch(() => null);
  return <GameView appid={appid.data} signedIn={session !== null} />;
}
