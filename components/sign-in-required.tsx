/**
 * components/sign-in-required.tsx
 *
 * What /dashboard and /wishlist show a signed-out visitor (v1.13), instead of
 * redirecting them away: a card that says what the page needs and one
 * prominent "Sign in with Steam" button. Signing in brings them back to the
 * same page (lib/auth/sign-in-link.ts). Public pages are linked below, so the
 * card is never a dead end.
 *
 * A Server Component: no JavaScript is needed to read it or to sign in.
 */
import Link from "next/link";

import { pageContainer } from "@/components/layout-width";
import { signInHref } from "@/lib/auth/sign-in-link";

export function SteamSignInButton({ returnTo, size = "lg" }: { returnTo?: string | null; size?: "sm" | "lg" }) {
  return (
    // A plain <a>, never next/link: a prefetch must not start the OpenID flow (doc 6.2).
    <a
      href={signInHref(returnTo)}
      className={`inline-flex items-center justify-center gap-2 rounded-xl bg-steam-400 font-semibold text-slate-950 shadow-sm transition-colors hover:bg-steam-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-200 focus-visible:ring-offset-2 focus-visible:ring-offset-chrome ${
        size === "lg" ? "min-h-12 px-6 text-base" : "min-h-10 px-3.5 text-sm"
      }`}
    >
      <SteamMark className={size === "lg" ? "h-5 w-5" : "h-4 w-4"} />
      Sign in with Steam
    </a>
  );
}

/** A plain disc-and-piston glyph for the button. Not Valve's logo. */
function SteamMark({ className }: { className: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <circle cx="16" cy="8" r="3.5" />
      <circle cx="8.5" cy="15.5" r="2.5" />
      <path d="M13.2 10.3 10.4 13.6" strokeLinecap="round" />
    </svg>
  );
}

export function SignInRequired({ returnTo, title }: { returnTo: string; title: string }) {
  return (
    <div className={pageContainer}>
      <h1 className="sr-only">{title}</h1>
      <section
        aria-labelledby="sign-in-required-heading"
        className="mx-auto mt-6 max-w-xl rounded-3xl border border-slate-800 bg-chrome px-6 py-10 text-center shadow-lg shadow-black/20 sm:mt-12 sm:px-10"
      >
        <div aria-hidden="true" className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-steam-400/10 text-steam-300 ring-1 ring-steam-400/30">
          <SteamMark className="h-7 w-7" />
        </div>
        <h2 id="sign-in-required-heading" className="mt-5 text-2xl font-semibold tracking-tight text-white">
          Steam Account Required
        </h2>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-slate-300">
          Connect your Steam account to view your personalized dashboard, track your wishlist deals, and sync your
          game collection.
        </p>
        <div className="mt-7">
          <SteamSignInButton returnTo={returnTo} />
        </div>
        <p className="mt-4 text-xs leading-relaxed text-slate-500">
          You sign in on Steam&rsquo;s own site. SteamGauge never sees your password, and only reads what your Steam
          privacy settings allow.
        </p>
        <p className="mt-6 border-t border-slate-800 pt-5 text-sm text-slate-400">
          Or keep browsing without an account:{" "}
          <Link href="/deals" className="font-medium text-steam-300 underline-offset-2 hover:underline">
            today&rsquo;s deals
          </Link>
        </p>
      </section>
    </div>
  );
}
