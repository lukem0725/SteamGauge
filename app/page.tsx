/**
 * /  (landing page)
 *
 * Signed-in visitors are sent straight to the dashboard. Everyone else sees
 * the sign-in screen, including the reason if a sign-in just failed
 * (?auth_error=<code>, set by the auth routes).
 *
 * Requires Next.js 15 or later (async `cookies` and `searchParams`).
 */
import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/auth/session";
import { POST_LOGIN_PATH, SESSION_COOKIE } from "@/lib/auth/shared";

export const metadata: Metadata = {
  title: "SteamGauge",
  description: "See your Steam library, backlog, deals and price drops at a glance.",
};

export const viewport: Viewport = { colorScheme: "dark", themeColor: "#09090b" };

// Depends on a cookie: never prerender or cache this page.
export const dynamic = "force-dynamic";

/** Codes the auth routes send. Anything else gets the generic message. */
const AUTH_ERRORS: Readonly<Record<string, string>> = {
  cancelled: "Sign-in was cancelled. You can try again whenever you are ready.",
  invalid_state: "That sign-in attempt expired or was started in another tab. Please try again.",
  verification_failed: "Steam could not confirm that sign-in. Please try again.",
  rate_limited: "Too many sign-in attempts. Wait a minute, then try again.",
  server_error: "We could not finish signing you in. Please try again in a moment.",
};

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ auth_error?: string | string[] }>;
}) {
  if (await isSignedIn()) {
    redirect(POST_LOGIN_PATH);
  }

  const { auth_error: raw } = await searchParams;
  const code = Array.isArray(raw) ? raw[0] : raw;
  // The code comes from the URL, so it only ever selects one of our own messages.
  const authError = code
    ? (Object.prototype.hasOwnProperty.call(AUTH_ERRORS, code)
        ? AUTH_ERRORS[code]
        : AUTH_ERRORS.server_error)
    : null;

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-950 text-zinc-100 antialiased">
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12">
        <p className="text-2xl font-semibold tracking-tight text-zinc-50">
          Steam<span className="text-emerald-400">Gauge</span>
        </p>
        <h1 className="mt-6 text-3xl font-semibold leading-tight tracking-tight text-zinc-50">
          Your Steam library, at a glance.
        </h1>
        <p className="mt-3 text-base leading-relaxed text-zinc-400">
          See what you own and what you have never played, find deals worth the money, and
          watch games for a price drop.
        </p>

        {authError ? (
          <p
            role="alert"
            className="mt-6 rounded-2xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm leading-relaxed text-rose-200"
          >
            {authError}
          </p>
        ) : null}

        {/* A plain link on purpose: next/link would prefetch the login route
            and replace the sign-in state cookie mid-flow. */}
        <a
          href="/api/auth/steam/login"
          className="mt-6 inline-flex min-h-12 items-center justify-center rounded-xl bg-emerald-400 px-5 text-base font-semibold text-zinc-950 transition-colors hover:bg-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200"
        >
          Sign in through Steam
        </a>
        <p className="mt-3 text-sm leading-relaxed text-zinc-500">
          You sign in on Steam&rsquo;s own site. SteamGauge never sees your password.
        </p>
      </main>

      <footer className="px-4 pb-6 text-center text-xs leading-relaxed text-zinc-600">
        SteamGauge is not affiliated with Valve.{" "}
        <a
          href="https://steampowered.com"
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-zinc-700 underline-offset-2 hover:text-zinc-400"
        >
          Powered by Steam
        </a>
        .
      </footer>
    </div>
  );
}

/**
 * A database outage must not turn the landing page into an error screen, so
 * a failed lookup is treated as signed out here. The dashboard's own check
 * still applies after sign-in.
 */
async function isSignedIn(): Promise<boolean> {
  try {
    const cookieStore = await cookies();
    return (await getSessionUser(cookieStore.get(SESSION_COOKIE)?.value)) !== null;
  } catch {
    return false;
  }
}
