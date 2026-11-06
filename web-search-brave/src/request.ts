/**
 * Pure request planning for the Brave Web Search API: query validation, result-count
 * clamping, and the exact query parameters sent to `/res/v1/web/search`. Nothing here
 * touches the network, so the mapping is unit-testable against a recorded vocabulary.
 * @module @anago-harness/web-search-brave/request
 */
import { WebError, type WebSearchRequest } from '@deepseek-ai/dsh-web'

/** Path of the Brave Web Search endpoint, appended to the configured `baseURL`. */
export const BRAVE_WEB_SEARCH_PATH = '/res/v1/web/search'
/** Brave rejects queries longer than 400 characters. */
export const BRAVE_QUERY_MAX_CHARS = 400
/** Brave rejects queries longer than 50 words. */
export const BRAVE_QUERY_MAX_WORDS = 50
/** Smallest `count` Brave accepts. */
export const BRAVE_COUNT_MIN = 1
/** Largest `count` Brave accepts. */
export const BRAVE_COUNT_MAX = 20
/** `count` used when the caller sets no `maxResults`. */
export const BRAVE_DEFAULT_COUNT = 8

/** Safe-search modes Brave accepts for `safesearch`. */
export type BraveSafeSearch = 'off' | 'moderate' | 'strict'

/**
 * Non-secret settings that shape one request. `maxResults` is the configured upper
 * bound, already separated from the caller's own bound in {@link WebSearchRequest}.
 */
export interface BraveSearchSettings {
  /** `country` parameter; omitted from the request when empty. */
  readonly country: string
  /** `search_lang` parameter; omitted from the request when empty. */
  readonly searchLang: string
  /** `ui_lang` parameter; omitted from the request when empty. */
  readonly uiLang: string
  /** `safesearch` parameter; omitted from the request when empty. */
  readonly safesearch: BraveSafeSearch | ''
  /** `freshness` parameter; omitted from the request when absent or empty. */
  readonly freshness?: string | undefined
  /** Upper bound on `count`, clamped into Brave's 1..20 range. */
  readonly maxResults: number
}

/** One planned request: what to send, and the non-secret facts a failure may name. */
export interface BraveSearchPlan {
  /** `baseURL` plus path without the query string; safe to print in diagnostics. */
  readonly endpoint: string
  /** Full request URL, query string included. */
  readonly url: string
  /** The `count` actually requested, after clamping. */
  readonly count: number
  /** Every query parameter sent, in send order. */
  readonly params: Readonly<Record<string, string>>
}

/** Parameters derived from settings, in Brave's documented order; `q` and the fixed values are excluded. */
const SETTINGS_PARAM_KEYS = ['count', 'country', 'search_lang', 'ui_lang', 'safesearch', 'freshness'] as const

/**
 * Clamp one result count into Brave's accepted range. A non-finite value falls back
 * to {@link BRAVE_DEFAULT_COUNT} rather than producing `NaN` in the query string.
 * @param value - the candidate count.
 * @returns an integer within 1..20.
 */
export function clampCount(value: number): number {
  if (!Number.isFinite(value)) return BRAVE_DEFAULT_COUNT
  return Math.min(Math.max(Math.trunc(value), BRAVE_COUNT_MIN), BRAVE_COUNT_MAX)
}

/**
 * The `count` for one request: the caller's bound or {@link BRAVE_DEFAULT_COUNT},
 * the configured bound, then Brave's range — in that order.
 * @param requested - `request.maxResults`, absent when the caller sets no bound.
 * @param configuredMax - `config.maxResults`.
 * @returns the clamped count.
 */
export function resolveCount(requested: number | undefined, configuredMax: number): number {
  return clampCount(Math.min(requested ?? BRAVE_DEFAULT_COUNT, configuredMax))
}

/**
 * Reject a query Brave cannot accept, before any request is dispatched. The message
 * names the limit and the offending size, never the query text.
 * @param query - the caller's query.
 * @throws {@link WebError} `WEB_PROVIDER_ERROR` when the query exceeds 400 characters or 50 words.
 */
export function assertSearchableQuery(query: string): void {
  if (query.length > BRAVE_QUERY_MAX_CHARS) {
    throw new WebError(
      `Brave search query is ${query.length} characters long; the Brave Web Search API accepts at most ${BRAVE_QUERY_MAX_CHARS} characters. Shorten the query and search again.`,
      'WEB_PROVIDER_ERROR',
    )
  }
  const words = countWords(query)
  if (words > BRAVE_QUERY_MAX_WORDS) {
    throw new WebError(
      `Brave search query has ${words} words; the Brave Web Search API accepts at most ${BRAVE_QUERY_MAX_WORDS} words. Shorten the query and search again.`,
      'WEB_PROVIDER_ERROR',
    )
  }
}

/**
 * Build every query parameter for one request. Fixed values keep snippets free of
 * decoration markers, spellcheck the query, and restrict the response to `web`
 * results; `offset`, `extra_snippets`, and `summary` are deliberately never sent.
 * @param request - the caller's query and optional bound.
 * @param settings - the non-secret settings section.
 * @returns the parameters, in send order.
 * @throws {@link WebError} `WEB_PROVIDER_ERROR` when the query is too long.
 */
export function buildSearchParams(request: WebSearchRequest, settings: BraveSearchSettings): Record<string, string> {
  assertSearchableQuery(request.query)
  const params: Record<string, string> = {
    q: request.query,
    count: String(resolveCount(request.maxResults, settings.maxResults)),
  }
  setIfPresent(params, 'country', settings.country)
  setIfPresent(params, 'search_lang', settings.searchLang)
  setIfPresent(params, 'ui_lang', settings.uiLang)
  setIfPresent(params, 'safesearch', settings.safesearch)
  setIfPresent(params, 'freshness', settings.freshness)
  params['text_decorations'] = 'false'
  params['spellcheck'] = 'true'
  params['result_filter'] = 'web'
  return params
}

/**
 * Join the configured base with the Web Search path, tolerating trailing slashes.
 * @param baseURL - the configured base URL.
 * @returns the endpoint without a query string.
 */
export function buildSearchEndpoint(baseURL: string): string {
  return `${baseURL.replace(/\/+$/u, '')}${BRAVE_WEB_SEARCH_PATH}`
}

/**
 * Plan one request end to end: validate the query, clamp the count, and render the URL.
 * @param baseURL - the configured base URL.
 * @param settings - the non-secret settings section.
 * @param request - the caller's query and optional bound.
 * @returns the endpoint, URL, count, and parameters.
 * @throws {@link WebError} `WEB_PROVIDER_ERROR` when the query is too long.
 */
export function buildSearchPlan(
  baseURL: string,
  settings: BraveSearchSettings,
  request: WebSearchRequest,
): BraveSearchPlan {
  const params = buildSearchParams(request, settings)
  const endpoint = buildSearchEndpoint(baseURL)
  return {
    endpoint,
    url: `${endpoint}?${new URLSearchParams(params).toString()}`,
    count: Number(params['count']),
    params,
  }
}

/**
 * Headers for one authenticated request. The token is sent only on the wire and
 * never enters a message, a log, or a diagnostic.
 * @param apiKey - the resolved API key.
 * @returns the request headers.
 */
export function buildSearchHeaders(apiKey: string): Record<string, string> {
  return {
    'Accept': 'application/json',
    'X-Subscription-Token': apiKey,
  }
}

/**
 * Describe the settings-derived parameters actually sent, for a parameter-rejection
 * message. The query (`q`) and the fixed parameters are excluded because the caller
 * can only correct the settings.
 * @param params - the parameters sent.
 * @returns `key=value` pairs joined with `, `.
 */
export function describeSearchSettings(params: Readonly<Record<string, string>>): string {
  return SETTINGS_PARAM_KEYS
    .filter(key => params[key] !== undefined)
    .map(key => `${key}=${params[key] ?? ''}`)
    .join(', ')
}

/** Set one parameter unless the configured value is empty. */
function setIfPresent(params: Record<string, string>, key: string, value: string | undefined): void {
  if (value !== undefined && value.length > 0) params[key] = value
}

/** Count whitespace-separated words the way Brave's own schema does, ignoring surrounding blanks. */
function countWords(query: string): number {
  return query.trim().split(/\s+/u).length
}
