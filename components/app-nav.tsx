"use client";

/**
 * components/app-nav.tsx
 *
 * Navigation for every signed-in page, rendered once by app/(app)/layout.tsx.
 *
 *   Phones (below 640px)  A slim top bar (brand, search, sign out) and a fixed
 *                         bottom tab bar, where thumbs reach.
 *   640px and wider       One sticky top bar: brand, page links, search, sign out.
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

export function AppNav() {
  const pathname = usePathname();

  return (
    <>
      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-chrome/95 backdrop-blur">
        <div className={`${PAGE_WIDTH} flex h-14 items-center gap-4`}>
          <Link
            href="/dashboard"
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

          {/* A real form POST: signing out changes state, and works without JavaScript. */}
          <form action="/api/auth/logout" method="post" className="shrink-0">
            <button
              type="submit"
              className="inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-medium text-slate-400 transition-colors hover:bg-slate-900 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400"
            >
              Sign out
            </button>
          </form>
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
