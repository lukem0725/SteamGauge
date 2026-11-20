/**
 * /app/[appid]  (v1.13)
 *
 * Steam-style address for a game page (store.steampowered.com/app/<id>/),
 * so a Steam link with the host swapped just works. Permanently redirects to
 * /game/[appid], the page of record; anything that is not an App ID is a 404.
 */
import { notFound, permanentRedirect } from "next/navigation";

import { appIdSchema } from "@/lib/validation";

export default async function SteamStyleGamePath({ params }: { params: Promise<{ appid: string }> }) {
  const appid = appIdSchema.safeParse((await params).appid);
  if (!appid.success) notFound();
  permanentRedirect(`/game/${appid.data}`);
}
