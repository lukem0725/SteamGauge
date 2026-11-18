"use client";

/**
 * Error boundary for the signed-in pages. Catches anything a page throws
 * while rendering on the server (for example the database being unreachable
 * during the session check) and shows it in our own design instead of the
 * framework's default screen.
 *
 * The error's message is never shown: it can contain internal detail. Next.js
 * logs the full error on the server, tagged with `digest`.
 */
import { pageContainer } from "@/components/layout-width";
import { StatePanel, primaryButton, secondaryButton } from "@/components/ui-kit";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className={pageContainer}>
      <StatePanel
        tone="rose"
        title="This page could not be loaded"
        actions={
          <>
            <button type="button" onClick={reset} className={primaryButton}>
              Try again
            </button>
            {/* A full page load on purpose: it starts from a clean state. */}
            <a href="/dashboard" className={secondaryButton}>
              Go to dashboard
            </a>
          </>
        }
      >
        <p>Something went wrong on our side. Trying again usually fixes it.</p>
        {error.digest ? (
          <p className="mt-2 text-xs text-slate-500">Reference: {error.digest}</p>
        ) : null}
      </StatePanel>
    </div>
  );
}
