/**
 * lib/validation.ts
 *
 * Input schemas for everything that arrives from a request: route params,
 * query strings, JSON bodies. Rules are the ones in architecture doc 6.4.
 * Invalid input must be rejected with HTTP 400 before any cache, database, or
 * Steam access.
 *
 * Usage in a Route Handler:
 *
 *     const parsed = steamIdSchema.safeParse(params.steamid);
 *     if (!parsed.success) return NextResponse.json({ error: "invalid_steamid" }, { status: 400 });
 *
 * Written against the zod API shared by zod 3 and zod 4.
 */
import "server-only";

import { z } from "zod";

// -----------------------------------------------------------------------------
// SteamID64
// -----------------------------------------------------------------------------

/**
 * A 17-digit SteamID64 for an individual account, kept as a string.
 *
 * Never convert it to a number: it is larger than Number.MAX_SAFE_INTEGER and
 * would be silently corrupted. The pattern matches the CHECK constraint on
 * users.steamid.
 */
export const steamIdSchema = z
  .string()
  .regex(/^7656119\d{10}$/, "Must be a 17-digit SteamID64.");

export type SteamId = z.infer<typeof steamIdSchema>;

// -----------------------------------------------------------------------------
// AppID
// -----------------------------------------------------------------------------

export const APP_ID_MIN = 1;
export const APP_ID_MAX = 9_999_999;

/**
 * A Steam AppID: an integer from 1 to 9,999,999.
 *
 * Accepts a number (JSON body) or a string of 1 to 7 digits (route param).
 * The string form is matched digit-for-digit, so "12abc", "1e3", "0x10",
 * " 12", "-5", and "" are all rejected rather than coerced.
 */
export const appIdSchema = z
  .union([z.number(), z.string().regex(/^\d{1,7}$/).transform(Number)])
  .pipe(
    z
      .number()
      .int("AppID must be a whole number.")
      .min(APP_ID_MIN, "AppID is out of range.")
      .max(APP_ID_MAX, "AppID is out of range."),
  );

export type AppId = z.infer<typeof appIdSchema>;

// -----------------------------------------------------------------------------
// Vanity URL name
// -----------------------------------------------------------------------------

/**
 * The custom part of a profile URL (steamcommunity.com/id/<name>): 2 to 32
 * letters, digits, underscores, or hyphens. Surrounding whitespace is removed.
 * Case is preserved here; the cache key lowercases it.
 */
export const vanityUrlSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{2,32}$/, "Must be 2-32 letters, digits, underscores, or hyphens.");

export type VanityUrl = z.infer<typeof vanityUrlSchema>;

// -----------------------------------------------------------------------------
// App name search
// -----------------------------------------------------------------------------

export const SEARCH_QUERY_MIN_LENGTH = 3;
export const SEARCH_QUERY_MAX_LENGTH = 64;

/**
 * A search term for GET /api/apps/search.
 *
 * - Trimmed, with runs of whitespace collapsed to one space.
 * - 3 to 64 characters. Three is the minimum the trigram index can use.
 * - Letters, digits, punctuation, symbols, and spaces in any script, so
 *   titles like "Pokémon", "NieR:Automata™" and "原神" all work. Control and
 *   other invisible characters are rejected.
 *
 * The result is NOT safe to place in a LIKE pattern as-is. Pass it through
 * `escapeLikePattern` first.
 */
export const searchQuerySchema = z
  .string()
  .transform((value) => value.trim().replace(/\s+/gu, " "))
  .pipe(
    z
      .string()
      .min(SEARCH_QUERY_MIN_LENGTH, `Enter at least ${SEARCH_QUERY_MIN_LENGTH} characters.`)
      .max(SEARCH_QUERY_MAX_LENGTH, `Enter at most ${SEARCH_QUERY_MAX_LENGTH} characters.`)
      .regex(/^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u, "Search contains unsupported characters."),
  );

export type SearchQuery = z.infer<typeof searchQuerySchema>;

/**
 * Escapes the three characters that are special inside a Postgres LIKE/ILIKE
 * pattern, so user input only ever matches literally:
 *
 *     .ilike("name", `%${escapeLikePattern(query)}%`)
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// -----------------------------------------------------------------------------
// Storefront country code
// -----------------------------------------------------------------------------

/**
 * Countries we request store prices for. Each one added multiplies the number
 * of Storefront cache entries and calls (architecture doc 9, open question 2),
 * so this is a fixed list, never free-form input.
 */
export const SUPPORTED_COUNTRY_CODES = ["us"] as const;
export const DEFAULT_COUNTRY_CODE = "us" satisfies (typeof SUPPORTED_COUNTRY_CODES)[number];

/** A supported two-letter country code. Case-insensitive in, lowercase out. */
export const countryCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(SUPPORTED_COUNTRY_CODES));

export type CountryCode = z.infer<typeof countryCodeSchema>;

// -----------------------------------------------------------------------------
// Wishlist
// -----------------------------------------------------------------------------

export const TRACKED_NOTE_MAX_LENGTH = 500;

/**
 * An optional personal note on a tracked app. Trimmed; an empty note becomes
 * null. The 500-character cap matches the CHECK constraint on
 * tracked_apps.note.
 */
export const trackedNoteSchema = z
  .string()
  .trim()
  .max(TRACKED_NOTE_MAX_LENGTH, `Note must be at most ${TRACKED_NOTE_MAX_LENGTH} characters.`)
  .transform((value) => (value === "" ? null : value))
  .nullable()
  .optional();

/** Body of POST /api/wishlist. */
export const addToWishlistSchema = z.object({
  appid: appIdSchema,
  note: trackedNoteSchema,
});

export type AddToWishlistInput = z.infer<typeof addToWishlistSchema>;
