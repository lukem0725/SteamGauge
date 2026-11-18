"use client";

/**
 * components/title-filter.tsx
 *
 * The "filter by title" box used above the Deals table, the Dashboard
 * library list and the Wishlist. It only narrows what is already on the page
 * (matching rules: lib/title-search.ts); it never searches Steam or leaves
 * the page. That is the job of the global search in the top bar.
 *
 * Escape or the clear button empties it.
 */
import { useId, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";

export function TitleFilter({
  value,
  onChange,
  label,
  placeholder = "Filter by title",
  className = "",
  describedBy,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Visible to screen readers; the placeholder is not a label. */
  label: string;
  placeholder?: string;
  className?: string;
  describedBy?: string;
  /** Extra content inside the box's right edge, before the clear button. */
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={`relative min-w-0 ${className}`}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
      >
        <path d="M3 5h14M6 10h8M8.5 15h3" />
      </svg>
      <input
        id={id}
        type="search"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        value={value}
        placeholder={placeholder}
        aria-describedby={describedBy}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            onChange("");
          }
        }}
        className="min-h-10 w-full rounded-xl border border-slate-700 bg-surface pl-9 pr-9 text-sm text-slate-100 placeholder:text-slate-500 focus-visible:border-steam-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400/40 [&::-webkit-search-cancel-button]:hidden"
      />
      <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {children}
        {value ? (
          <button
            type="button"
            onClick={() => onChange("")}
            className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400"
          >
            <span aria-hidden="true">×</span>
            <span className="sr-only">Clear filter</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
