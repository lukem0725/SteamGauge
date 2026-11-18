/**
 * lib/prefetch-header.ts
 *
 * The request header that marks a hover prefetch (v1.9). Shared by the
 * browser (components/game-queries.ts) and the server (lib/api/game-cache.ts),
 * so it lives in a module with no server-only imports. Lowercase, as
 * Headers.get expects.
 */
export const PREFETCH_HEADER = "x-steamgauge-prefetch";
