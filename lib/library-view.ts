/**
 * lib/library-view.ts
 *
 * The Dashboard library's filters and sort orders (v1.10). Pure functions,
 * shared by the browser and tests; no server imports.
 *
 * The three stat cards choose a SECTION (which games):
 *   all       every owned game
 *   playtime  every owned game, ranked by playtime ("Lifetime hours")
 *   backlog   games with exactly 0 minutes played
 *
 * On top of the section, the same controls apply in all three:
 *   - text: every word must appear in the title or in one of the game's tags
 *   - status: unplayed / played / played in the last 2 weeks
 *   - tag: one Steam tag (Steam's genre labels are tags too)
 *   - sort: see LIBRARY_SORTS
 *
 * Store-based fields (price, release date, tags) come from the library store
 * data, which loads after the library. Until it arrives, or for games it does
 * not cover, those values are unknown and sort last in both directions.
 */
import type { OwnedGame } from "@/lib/steam/endpoints";
import { matchesTitle } from "@/lib/title-search";

// =============================================================================
// Store data as sent to the browser (GET /api/library/store)
// =============================================================================

export interface LibraryGameStore {
  readonly headerImage: string;
  /** "YYYY-MM-DD" (UTC), or null. */
  readonly releaseDate: string | null;
  readonly comingSoon: boolean;
  readonly isFree: boolean;
  /** Current US price in cents (after any discount); 0 when free; null when not sold. */
  readonly priceFinal: number | null;
  readonly priceInitial: number | null;
  readonly discountPercent: number;
  /** Tag names, most-voted first. */
  readonly tags: readonly string[];
}

export interface LibraryStorePayload {
  /** Keyed by appid (as a string). */
  readonly items: Readonly<Record<string, LibraryGameStore>>;
  /** Games store data was requested for (at most 2,000, most played first). */
  readonly covered: number;
  /** Games in the library. */
  readonly total: number;
  /** False when tag names could not be loaded (tags are then empty). */
  readonly tagsAvailable: boolean;
}

// =============================================================================
// Sections, status, sort
// =============================================================================

export type LibrarySection = "all" | "playtime" | "backlog";

export type PlayStatus = "any" | "unplayed" | "played" | "recent";

export const PLAY_STATUSES: readonly { readonly value: PlayStatus; readonly label: string }[] = [
  { value: "any", label: "Any status" },
  { value: "unplayed", label: "Unplayed" },
  { value: "played", label: "Played" },
  { value: "recent", label: "Played in the last 2 weeks" },
];

export type LibrarySort =
  | "section"
  | "title-asc"
  | "title-desc"
  | "hours-desc"
  | "hours-asc"
  | "price-desc"
  | "price-asc"
  | "release-desc"
  | "release-asc"
  | "played-desc";

export const DEFAULT_LIBRARY_SORT: LibrarySort = "section";

export const LIBRARY_SORTS: readonly { readonly value: LibrarySort; readonly label: string }[] = [
  { value: "section", label: "Section default" },
  { value: "title-asc", label: "Title: A to Z" },
  { value: "title-desc", label: "Title: Z to A" },
  { value: "hours-desc", label: "Hours played: most first" },
  { value: "hours-asc", label: "Hours played: least first" },
  { value: "price-desc", label: "Price: highest first" },
  { value: "price-asc", label: "Price: lowest first" },
  { value: "release-desc", label: "Release date: newest first" },
  { value: "release-asc", label: "Release date: oldest first" },
  { value: "played-desc", label: "Last played: most recent first" },
];

/** Sorts that need store data (disabled until it loads). */
export const STORE_SORTS: ReadonlySet<LibrarySort> = new Set(["price-desc", "price-asc", "release-desc", "release-asc"]);

export function isLibrarySort(value: unknown): value is LibrarySort {
  return LIBRARY_SORTS.some((option) => option.value === value);
}

export function isPlayStatus(value: unknown): value is PlayStatus {
  return PLAY_STATUSES.some((option) => option.value === value);
}

export type LibraryView = "detailed" | "compact";

export function isLibraryView(value: unknown): value is LibraryView {
  return value === "detailed" || value === "compact";
}

// =============================================================================
// Filtering and sorting
// =============================================================================

/** One game in a section, with its place in the playtime ranking (1 = most played). */
export interface LibraryEntry {
  readonly game: OwnedGame;
  readonly rank: number;
  readonly store: LibraryGameStore | null;
}

export interface LibraryControls {
  readonly text: string;
  readonly status: PlayStatus;
  /** A tag name, or "" for any. */
  readonly tag: string;
  readonly sort: LibrarySort;
}

export const DEFAULT_CONTROLS: LibraryControls = { text: "", status: "any", tag: "", sort: DEFAULT_LIBRARY_SORT };

export function playStatusOf(game: OwnedGame): Exclude<PlayStatus, "any"> {
  if (game.playtimeMinutes === 0) return "unplayed";
  return game.playtimeTwoWeeksMinutes > 0 ? "recent" : "played";
}

function matchesStatus(game: OwnedGame, status: PlayStatus): boolean {
  switch (status) {
    case "any":
      return true;
    case "unplayed":
      return game.playtimeMinutes === 0;
    case "played":
      return game.playtimeMinutes > 0;
    case "recent":
      return game.playtimeTwoWeeksMinutes > 0;
  }
}

const byName = (a: OwnedGame, b: OwnedGame) => a.name.localeCompare(b.name, "en", { sensitivity: "base" });
const byPlaytime = (a: OwnedGame, b: OwnedGame) => b.playtimeMinutes - a.playtimeMinutes || byName(a, b);

/**
 * The games of a section, each with its playtime rank (its place among ALL
 * owned games by playtime, so the number stays the same under any filter).
 */
export function sectionEntries(
  games: readonly OwnedGame[],
  section: LibrarySection,
  store: LibraryStorePayload | null,
): LibraryEntry[] {
  const ranked = [...games].sort(byPlaytime).map((game, index) => ({
    game,
    rank: index + 1,
    store: store?.items[String(game.appid)] ?? null,
  }));
  return section === "backlog" ? ranked.filter((entry) => entry.game.playtimeMinutes === 0) : ranked;
}

/** The section's own order, used by the "Section default" sort. */
function sectionOrder(section: LibrarySection) {
  return section === "playtime"
    ? (a: LibraryEntry, b: LibraryEntry) => a.rank - b.rank
    : (a: LibraryEntry, b: LibraryEntry) => byName(a.game, b.game);
}

/** Compares possibly-missing values; missing always sorts last. */
function nullsLast<T>(a: T | null, b: T | null, compare: (x: T, y: T) => number): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compare(a, b);
}

const priceOf = (entry: LibraryEntry) => entry.store?.priceFinal ?? null;
const releaseOf = (entry: LibraryEntry) =>
  entry.store && !entry.store.comingSoon ? entry.store.releaseDate : null;
const lastPlayedOf = (entry: LibraryEntry) => entry.game.lastPlayedAt;

export function compareEntries(sort: LibrarySort, section: LibrarySection) {
  const tie = (a: LibraryEntry, b: LibraryEntry) => byName(a.game, b.game);
  switch (sort) {
    case "section":
      return sectionOrder(section);
    case "title-asc":
      return tie;
    case "title-desc":
      return (a: LibraryEntry, b: LibraryEntry) => -tie(a, b);
    case "hours-desc":
      return (a: LibraryEntry, b: LibraryEntry) => a.rank - b.rank;
    case "hours-asc":
      return (a: LibraryEntry, b: LibraryEntry) =>
        a.game.playtimeMinutes - b.game.playtimeMinutes || tie(a, b);
    case "price-desc":
      return (a: LibraryEntry, b: LibraryEntry) => nullsLast(priceOf(a), priceOf(b), (x, y) => y - x) || tie(a, b);
    case "price-asc":
      return (a: LibraryEntry, b: LibraryEntry) => nullsLast(priceOf(a), priceOf(b), (x, y) => x - y) || tie(a, b);
    case "release-desc":
      return (a: LibraryEntry, b: LibraryEntry) =>
        nullsLast(releaseOf(a), releaseOf(b), (x, y) => y.localeCompare(x)) || tie(a, b);
    case "release-asc":
      return (a: LibraryEntry, b: LibraryEntry) =>
        nullsLast(releaseOf(a), releaseOf(b), (x, y) => x.localeCompare(y)) || tie(a, b);
    case "played-desc":
      return (a: LibraryEntry, b: LibraryEntry) =>
        nullsLast(lastPlayedOf(a), lastPlayedOf(b), (x, y) => y.localeCompare(x)) || tie(a, b);
  }
}

/** The section's games after the controls, in order. */
export function applyControls(
  entries: readonly LibraryEntry[],
  controls: LibraryControls,
  section: LibrarySection,
): LibraryEntry[] {
  const text = controls.text.trim();
  // The backlog is unplayed games by definition; the status control is off there.
  const status = section === "backlog" ? "any" : controls.status;
  const tag = controls.tag;
  const tagKey = tag.toLowerCase();
  return entries
    .filter((entry) => matchesStatus(entry.game, status))
    .filter((entry) => !tag || (entry.store?.tags ?? []).some((name) => name.toLowerCase() === tagKey))
    .filter(
      (entry) => !text || matchesTitle(text, `${entry.game.name} ${(entry.store?.tags ?? []).join(" ")}`),
    )
    .sort(compareEntries(controls.sort, section));
}

/** Tags in these entries with how many games carry each, most common first. */
export function tagCounts(entries: readonly LibraryEntry[], limit = 60): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of entries) for (const name of entry.store?.tags ?? []) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export function activeFilterCount(controls: LibraryControls, section: LibrarySection): number {
  return (
    (controls.text.trim() ? 1 : 0) +
    (section !== "backlog" && controls.status !== "any" ? 1 : 0) +
    (controls.tag ? 1 : 0)
  );
}
