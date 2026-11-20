/**
 * components/footer.tsx
 *
 * The site footer, on every app page (rendered once by the app shell).
 *
 *   Made for MIS325.
 *   SteamGauge is not affiliated with Valve. Powered by Steam.
 *
 * The second line is required by Steam's branding terms (doc 6.6), so it must
 * stay on every page. Colours: the `footer` token (#101822, Steam navy, a
 * shade darker than the page) with slate-400 text (7.0:1 contrast) and a
 * steam-300 accent line (10.5:1), both above the 4.5:1 needed for small text.
 *
 * A Server Component: no state, no browser code.
 */
import { PAGE_WIDTH } from "@/components/layout-width";

export function SiteFooter({ className = "" }: { className?: string }) {
  return (
    <footer className={`border-t border-slate-800/80 bg-footer ${className}`}>
      <div className={`${PAGE_WIDTH} flex flex-col items-center gap-1.5 py-6 text-center`}>
        <p className="text-sm font-medium text-steam-300">Made for MIS325.</p>
        <p className="text-xs leading-relaxed text-slate-400">
          SteamGauge is not affiliated with Valve.{" "}
          <a
            href="https://store.steampowered.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-slate-600 underline-offset-2 hover:text-slate-200 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400"
          >
            Powered by Steam
          </a>
          .
        </p>
      </div>
    </footer>
  );
}
