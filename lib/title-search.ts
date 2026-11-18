/**
 * lib/title-search.ts
 *
 * Forgiving game-title matching, shared by the server (ranking global search
 * results) and the browser (the Deals, Dashboard and Wishlist filters).
 * Pure, no dependencies.
 *
 * Normalisation makes these equal: "Baldur's Gate 3" / "baldurs gate 3",
 * "Kingdom Come: Deliverance II" / "kingdom come deliverance 2",
 * "Pokémon" / "pokemon", "Half-Life" / "half life".
 */

const ROMAN: Readonly<Record<string, string>> = {
  ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10",
};

/** Lowercase, no accents, no ™®©, apostrophes dropped, other punctuation as spaces. */
export function normalizeTitle(text: string): string {
  return text
    // Before NFKD, which would turn "™" into the letters "TM".
    .replace(/[™®©℠]/g, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    // Roman numerals become digits ("ii" -> "2"), except a lone "i"/"v"/"x" word.
    .map((token, index, all) => (all.length > 1 && token.length > 1 && ROMAN[token] ? ROMAN[token] : token))
    .join(" ");
}

export function titleTokens(text: string): string[] {
  const normalized = normalizeTitle(text);
  return normalized ? normalized.split(" ") : [];
}

/**
 * The inline filters' rule: every word typed appears somewhere in the title
 * (as part of a word), in any order. "dead red" matches "Red Dead Redemption 2";
 * "kingdom deliv" matches "Kingdom Come: Deliverance II". An empty query
 * matches everything.
 */
export function matchesTitle(query: string, title: string): boolean {
  const wanted = titleTokens(query);
  if (wanted.length === 0) return true;
  const haystack = ` ${normalizeTitle(title)} `;
  const compact = haystack.replace(/ /g, "");
  return wanted.every((token) => haystack.includes(token) || compact.includes(token));
}

function bigrams(text: string): Map<string, number> {
  const padded = ` ${text} `;
  const out = new Map<string, number>();
  for (let i = 0; i < padded.length - 1; i++) {
    const gram = padded.slice(i, i + 2);
    out.set(gram, (out.get(gram) ?? 0) + 1);
  }
  return out;
}

/** Dice coefficient of character bigrams, 0..1. Tolerates typos. */
function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  let total = 0;
  for (const count of left.values()) total += count;
  for (const count of right.values()) total += count;
  for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0);
  return (2 * shared) / total;
}

/**
 * How well a title answers a search, 0..1 (higher is better).
 *
 *   1.00  exact title          0.95  title starts with the query
 *   0.85  query inside title   0.80  every word found (matchesTitle)
 *   below that: typo-tolerant similarity, word by word ("witchr" ~ "witcher")
 */
export function fuzzyScore(query: string, title: string): number {
  const q = normalizeTitle(query);
  const t = normalizeTitle(title);
  if (!q || !t) return 0;
  if (q === t) return 1;
  if (t.startsWith(q)) return 0.95;
  if (t.includes(q)) return 0.85;
  if (matchesTitle(q, t)) return 0.8;

  // Each query word against its best title word, averaged; plus the whole
  // strings, for queries typed without spaces.
  const titleWords = t.split(" ");
  const queryWords = q.split(" ");
  const perWord =
    queryWords.reduce((sum, word) => {
      let best = 0;
      for (const candidate of titleWords) {
        const prefix = candidate.slice(0, Math.max(word.length + 1, 3));
        best = Math.max(best, dice(word, candidate), dice(word, prefix));
      }
      return sum + best;
    }, 0) / queryWords.length;
  const whole = dice(q.replace(/ /g, ""), t.replace(/ /g, "").slice(0, q.length + 3));
  return 0.75 * Math.max(perWord, whole);
}
