/**
 * components/layout-width.ts
 *
 * Page width for every signed-in tab and the navigation bar, in one place so
 * Dashboard, Deals, Wishlist and the nav always line up. A plain module (no
 * "use client"), so Server and Client Components can both import it.
 */

/** Up to 1600px wide, with the same side padding as before. */
export const PAGE_WIDTH = "mx-auto w-full max-w-[1600px] px-4 sm:px-6 lg:px-8";

/** PAGE_WIDTH plus the standard top and bottom spacing of a page. */
export const pageContainer = `${PAGE_WIDTH} pb-12 pt-5`;
