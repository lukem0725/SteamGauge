/**
 * components/auth-error-notice.tsx
 *
 * Why the last sign-in failed (v1.14), shown at the top of Deals, where the
 * auth routes now send a failed sign-in. It replaces the old landing page's
 * alert. A Server Component: the message is chosen on the server from our
 * own list, never echoed from the URL.
 *
 * "Try again" is a plain <a>, never next/link, because prefetching the
 * login route would replace the sign-in state cookie mid-flow (doc 6.2).
 * "Dismiss" reloads /deals without the query string.
 */
import Link from "next/link";

import { signInHref } from "@/lib/auth/sign-in-link";

export function AuthErrorNotice({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mt-4 flex flex-col gap-3 rounded-2xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm leading-relaxed text-rose-200 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="min-w-0">{message}</p>
      <div className="flex shrink-0 items-center gap-4">
        <a
          href={signInHref("/deals")}
          className="inline-flex min-h-10 items-center rounded-lg bg-steam-400 px-3 font-semibold text-slate-950 transition-colors hover:bg-steam-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-200"
        >
          Try again
        </a>
        <Link
          href="/deals"
          replace
          scroll={false}
          className="inline-flex min-h-10 items-center font-medium text-rose-100 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-200"
        >
          Dismiss
        </Link>
      </div>
    </div>
  );
}
