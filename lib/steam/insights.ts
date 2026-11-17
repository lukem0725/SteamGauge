/**
 * lib/steam/insights.ts
 *
 * Parsers for the extra per-game facts shown in expanded Deals rows and on
 * Wishlist cards. Pure, no I/O; every value is checked before it is cached.
 *
 *   GetNumberOfCurrentPlayers   live concurrent players for one app
 *   GetItems (one app)          developers, publishers, franchises, tag ids
 *   IStoreService/GetTagList    tag id -> tag name, for every Steam tag
 *
 * Genres and descriptors ("Single-player", "Steam Achievements") come from
 * the Storefront appdetails response already parsed in endpoints.ts.
 */
import { z } from "zod";

// =============================================================================
// Concurrent players
// =============================================================================

export interface CurrentPlayers {
  readonly appid: number;
  readonly count: number;
}

const playersSchema = z.object({
  response: z.object({
    player_count: z.number().int().nonnegative().optional(),
    result: z.number().int(),
  }),
});

/**
 * @returns "not_found" when Steam has no count for the app (result 42, which
 *          it also sends for apps with no player stats).
 */
export function parseCurrentPlayers(
  raw: unknown,
  appid: number,
): { status: "ok"; data: CurrentPlayers } | { status: "not_found" } {
  const { response } = playersSchema.parse(raw);
  if (response.result !== 1 || response.player_count === undefined) return { status: "not_found" };
  return { status: "ok", data: { appid, count: response.player_count } };
}

// =============================================================================
// Store metadata (GetItems basic_info + tags)
// =============================================================================

export interface StoreMeta {
  readonly appid: number;
  readonly developers: readonly string[];
  readonly publishers: readonly string[];
  /** Steam's franchise / series names. Often empty. */
  readonly franchises: readonly string[];
  /** Tag ids, most voted first. Names come from the tag list. */
  readonly tagids: readonly number[];
}

/** Tags kept per game. */
export const MAX_TAGS = 12;
const MAX_NAMES = 8;

const namedList = z
  .array(z.object({ name: z.string().trim().min(1).max(128) }).passthrough())
  .optional()
  .catch(undefined);

const storeMetaItemSchema = z.object({
  appid: z.number().int().positive(),
  success: z.number().optional().catch(undefined),
  basic_info: z
    .object({ developers: namedList, publishers: namedList, franchises: namedList })
    .passthrough()
    .optional()
    .catch(undefined),
  tags: z
    .array(
      z.object({
        tagid: z.number().int().positive(),
        weight: z.number().nonnegative().optional().catch(undefined),
      }),
    )
    .optional()
    .catch(undefined),
  tagids: z.array(z.number().int().positive()).optional().catch(undefined),
});

const getItemsEnvelope = z.object({ response: z.object({ store_items: z.array(z.unknown()).optional() }) });

function names(list: readonly { name: string }[] | undefined): string[] {
  return [...new Set((list ?? []).map((entry) => entry.name))].slice(0, MAX_NAMES);
}

export function parseStoreMeta(
  raw: unknown,
  appid: number,
): { status: "ok"; data: StoreMeta } | { status: "not_found" } {
  const items = getItemsEnvelope.parse(raw).response.store_items ?? [];
  for (const entry of items) {
    const parsed = storeMetaItemSchema.safeParse(entry);
    if (!parsed.success || parsed.data.appid !== appid) continue;
    const item = parsed.data;
    if (item.success !== undefined && item.success !== 1) return { status: "not_found" };
    const weighted = [...(item.tags ?? [])].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    const tagids = weighted.length > 0 ? weighted.map((tag) => tag.tagid) : (item.tagids ?? []);
    return {
      status: "ok",
      data: {
        appid,
        developers: names(item.basic_info?.developers),
        publishers: names(item.basic_info?.publishers),
        franchises: names(item.basic_info?.franchises),
        tagids: [...new Set(tagids)].slice(0, MAX_TAGS),
      },
    };
  }
  return { status: "not_found" };
}

/** The GetItems request for one app's metadata. */
export function storeMetaInput(appid: number, countryCode: string): string {
  return JSON.stringify({
    ids: [{ appid }],
    context: { language: "english", country_code: countryCode.toUpperCase(), steam_realm: 1 },
    data_request: { include_basic_info: true, include_tag_count: MAX_TAGS },
  });
}

// =============================================================================
// Tag names
// =============================================================================

export interface SteamTagList {
  /** Tag id (as a string, for JSON) -> English name. */
  readonly names: Readonly<Record<string, string>>;
}

const tagListSchema = z.object({
  response: z.object({
    tags: z.array(
      z.object({ tagid: z.number().int().positive(), name: z.string().trim().min(1).max(64) }).passthrough(),
    ),
  }),
});

export function parseTagList(raw: unknown): { status: "ok"; data: SteamTagList } {
  const names: Record<string, string> = {};
  for (const tag of tagListSchema.parse(raw).response.tags) names[String(tag.tagid)] = tag.name;
  return { status: "ok", data: { names } };
}
