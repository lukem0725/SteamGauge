"use client";

/**
 * components/app-nav.tsx
 *
 * Navigation for every app page, rendered once by app/(app)/layout.tsx.
 *
 *   Phones (below 640px)  A slim top bar (brand, search, account) and a fixed
 *                         bottom tab bar, where thumbs reach.
 *   640px and wider       One sticky top bar: brand, page links, search, account.
 *
 * Account area, top right (v1.13):
 *   Signed in   The Steam avatar and persona name, and "Sign out" (a form
 *               POST). On phones the name is hidden to leave room for search.
 *   Signed out  "Sign in with Steam", which returns to the current page
 *               after signing in. Dashboard and Wishlist stay in the menu;
 *               they explain that they need a Steam account.
 *
 * The brand links to Deals, the home view for everyone since v1.14 ("/"
 * redirects there too), so the Deals tab is the one highlighted on arrival.
 *
 * The search box (components/global-search.tsx) is in the top bar on every
 * page, so it persists across Dashboard, Deals and Wishlist.
 *
 * The current page is marked with `aria-current="page"` as well as colour,
 * so it is announced by screen readers and never conveyed by colour alone.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { GlobalSearch } from "@/components/global-search";
import { PAGE_WIDTH } from "@/components/layout-width";
import { signInHref } from "@/lib/auth/sign-in-link";

/** What the navigation shows about the signed-in user. Never a token. */
export interface NavUser {
  readonly personaName: string | null;
  readonly avatarUrl: string | null;
}

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: ReactNode;
}

const icon = (path: ReactNode) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
  >
    {path}
  </svg>
);

const NAV_ITEMS: readonly NavItem[] = [
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: icon(
      <>
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
      </>,
    ),
  },
  {
    href: "/deals",
    label: "Deals",
    icon: icon(
      <>
        <path d="M3.5 12.6V5a1.5 1.5 0 0 1 1.5-1.5h7.6a1.5 1.5 0 0 1 1 .4l6.5 6.5a1.5 1.5 0 0 1 0 2.2l-7.5 7.5a1.5 1.5 0 0 1-2.2 0L4 13.6a1.5 1.5 0 0 1-.5-1Z" />
        <circle cx="8" cy="8" r="1.2" />
      </>,
    ),
  },
  {
    href: "/wishlist",
    label: "Wishlist",
    icon: icon(
      <path d="M12 20s-7.5-4.4-7.5-10.1A4.4 4.4 0 0 1 12 7a4.4 4.4 0 0 1 7.5 2.9C19.5 15.6 12 20 12 20Z" />,
    ),
  },
];

/** True on the page itself and on anything nested under it. */
function isActive(pathname: string | null, href: string): boolean {
  return pathname === href || (pathname?.startsWith(`${href}/`) ?? false);
}

export function AppNav({ user = null }: { user?: NavUser | null }) {
  const pathname = usePathname();

  return (
    <>
      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-chrome/95 backdrop-blur">
        <div className={`${PAGE_WIDTH} flex h-14 items-center gap-4`}>
          <Link
            href="/deals"
            className="rounded-md text-base font-semibold tracking-tight text-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400"
          >
            Steam<span className="text-steam-400">Gauge</span>
          </Link>

          <nav aria-label="Main" className="hidden shrink-0 sm:block">
            <ul className="flex items-center gap-1">
              {NAV_ITEMS.map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400 ${
                        active
                          ? "bg-slate-800 text-slate-50"
                          : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"
                      }`}
                    >
                      {item.icon}
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* Global search: right-aligned on wide screens, fills the bar on phones. */}
          <div role="search" className="flex min-w-0 flex-1 justify-end">
            <GlobalSearch />
          </div>

          {user ? <AccountMenu user={user} /> : <SignInLink returnTo={pathname} />}
        </div>
      </header>

      {/* Bottom tab bar, phones only */}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-800/80 bg-chrome/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
      >
        <ul className="mx-auto grid max-w-md grid-cols-3">
          {NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-steam-400 ${
                    active ? "text-steam-300" : "text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {active ? (
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-6 top-0 h-0.5 rounded-full bg-steam-400"
                    />
                  ) : null}
                  {item.icon}
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}

/** Avatar, persona name and "Sign out" (v1.13). */
function AccountMenu({ user }: { user: NavUser }) {
  const name = user.personaName?.trim() || "Steam user";
  return (
    <div className="flex shrink-0 items-center gap-1 sm:gap-2">
      <span className="flex min-w-0 items-center gap-2" title={`Signed in as ${name}`}>
        {user.avatarUrl ? (
          // Steam CDN avatar (allowed by img-src *.steamstatic.com); a plain <img> avoids next/image config.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.avatarUrl}
            alt=""
            width={32}
            height={32}
            decoding="async"
            className="h-8 w-8 shrink-0 rounded-md bg-slate-800 ring-1 ring-slate-700"
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-800 text-sm font-semibold text-slate-300 ring-1 ring-slate-700"
          >
            {name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="sr-only sm:hidden">Signed in as {name}</span>
        <span className="hidden max-w-[10rem] truncate text-sm font-medium text-slate-200 sm:inline lg:max-w-[14rem]">
          <span className="sr-only">Signed in as </span>
          {name}
        </span>
      </span>
      {/* A real form POST: signing out changes state, and works without JavaScript. */}
      <form action="/api/auth/logout" method="post" className="shrink-0">
        <button
          type="submit"
          className="inline-flex min-h-11 items-center rounded-xl px-2 text-sm font-medium text-slate-400 transition-colors hover:bg-slate-900 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400 sm:px-3"
        >
          Sign Out
        </button>
      </form>
    </div>
  );
}

/** "Sign in with Steam", back to this page afterwards (v1.13). Short label on phones. */
function SignInLink({ returnTo }: { returnTo: string | null }) {
  return (
    // A plain <a>, never next/link: a prefetch must not start the OpenID flow (doc 6.2).
    <a
      href={signInHref(returnTo)}
      className="inline-flex min-h-10 shrink-0 items-center rounded-xl bg-steam-400 px-3 text-sm font-semibold text-slate-950 transition-colors hover:bg-steam-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-200 focus-visible:ring-offset-2 focus-visible:ring-offset-chrome"
    >
      <span className="sm:hidden" aria-hidden="true">
        Sign in
      </span>
      <span className="sr-only sm:not-sr-only">Sign in with Steam</span>
    </a>
  );
}
