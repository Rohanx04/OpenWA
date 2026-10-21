import { resolveNonNegativeIntEnv } from '../../config/configuration';

/**
 * Host-side /search pagination bounds. Applied in SearchService BEFORE delegating to any provider,
 * so every backend (built-in DB full-text + plugin-backed) receives bounded pagination — a plugin
 * cannot be coaxed into returning an unbounded result set that pressures host heap. The built-in
 * provider re-asserts SEARCH_LIMIT_MAX inside its own SQL (defense-in-depth) by importing the same
 * constant, keeping a single source for the cap.
 *
 * SEARCH_LIMIT_MAX is env-driven (default 100, matching the historical built-in default).
 * SEARCH_OFFSET_MAX is a fixed deep-pagination guard (an offset this large is almost always a scan
 * or abuse pattern), intentionally not env-driven to avoid expanding the config surface.
 */
export const SEARCH_LIMIT_MAX = resolveNonNegativeIntEnv(process.env.SEARCH_LIMIT_MAX, 100) || 100;

/** Generous upper bound on offset across every provider. */
export const SEARCH_OFFSET_MAX = 100_000;

/** Default page size when a caller omits `limit` (matches the built-in provider's historical default). */
export const SEARCH_DEFAULT_LIMIT = 50;

/** Longest `q`, in characters. A generous bound: it exists so the request cannot be a megabyte of terms. */
export const SEARCH_QUERY_MAX_LENGTH = 1000;

/**
 * Most words in `q`, counted as the index counts them (see search-terms.ts). Each one costs a pass over
 * every message that matches, and the built-in provider runs on the event loop, so a query of hundreds
 * of words froze every session for seconds. A whitespace-separated word repeated is one word: the
 * provider collapses repeats.
 */
export const SEARCH_TERMS_MAX = 32;
