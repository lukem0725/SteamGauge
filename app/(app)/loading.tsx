/**
 * Shown under the navigation while a signed-in page's Server Component is
 * verifying the session. Same dark surface and card shapes as the pages, so
 * there is no flash of an unstyled or light screen between navigations.
 */
import { pageContainer } from "@/components/layout-width";

export default function AppLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading"
      className={`${pageContainer} space-y-4`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="h-7 w-40 animate-pulse rounded bg-slate-800" />
        <div className="h-6 w-28 animate-pulse rounded-full bg-slate-900" />
      </div>
      <div className="h-40 animate-pulse rounded-3xl border border-slate-800 bg-surface" />
      <div className="h-32 animate-pulse rounded-2xl border border-slate-800 bg-surface-raised" />
      <div className="h-32 animate-pulse rounded-2xl border border-slate-800 bg-surface-raised" />
    </div>
  );
}
