/**
 * app/(app)/game/[appid]/page.tsx
 *
 * One game's page, opened from the global search in the top bar. Verifies the
 * session like every signed-in page, checks the App ID, then hands off to the
 * client view (components/game-view.tsx), which loads everything through our
 * cached API.
 */
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { GameView } from "@/components/game-view";
import { getSessionUser } from "@/lib/auth/session";
import { SESSION_COOKIE, SIGNED_OUT_PATH } from "@/lib/auth/shared";
import { appIdSchema } from "@/lib/validation";

export const metadata: Metadata = { title: "Game · SteamGauge" };

// Depends on a cookie: never prerender or cache this page.
export const dynamic = "force-dynamic";

export default async function GamePage({ params }: { params: Promise<{ appid: string }> }) {
  const cookieStore = await cookies();
  const session = await getSessionUser(cookieStore.get(SESSION_COOKIE)?.value);
  if (!session) redirect(SIGNED_OUT_PATH);

  const appid = appIdSchema.safeParse((await params).appid);
  if (!appid.success) notFound();

  return <GameView appid={appid.data} />;
}
