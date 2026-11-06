/**
 * Cordis plugin registering a Brave-backed search provider with `ctx.web`. The
 * provider re-reads its settings and re-resolves its credential for every search, so a
 * settings change reaches the next search without re-registering (which the seam would
 * expose to the user as a provider flicker).
 * @module @anago-harness/web-search-brave
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createCredentialReaders } from '@anago-harness/web-search-credentials'
import {
  assertTimeoutMs,
  BraveSearchProvider,
  BRAVE_DEFAULT_BASE_URL,
  BRAVE_DEFAULT_TIMEOUT_MS,
  type BraveSearchProviderOptions,
} from './provider.ts'
import { BRAVE_DEFAULT_COUNT, type BraveSafeSearch } from './request.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-brave'
/** The web seam this provider registers into. */
export const inject = ['web']

/** Default credential reference; the credentials service and the launch environment both answer to it. */
export const BRAVE_DEFAULT_API_KEY_ENV = 'BRAVE_API_KEY'
/** Default `country`: Japanese results. */
export const BRAVE_DEFAULT_COUNTRY = 'JP'
/** Default `search_lang`: Brave spells Japanese `jp`. */
export const BRAVE_DEFAULT_SEARCH_LANG = 'jp'
/** Default `ui_lang`. */
export const BRAVE_DEFAULT_UI_LANG = 'ja-JP'
/** Default `safesearch`. */
export const BRAVE_DEFAULT_SAFESEARCH: BraveSafeSearch = 'moderate'

/** Plugin config; every field is volatile, so a settings change reaches the next search. */
export interface Config {
  /** Literal Brave Search API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey: Volatile<string | undefined>
  /** Credential reference resolved for each search; defaults to `BRAVE_API_KEY`. */
  apiKeyEnv: Volatile<string>
  /** Base URL the Web Search path is appended to. */
  baseURL: Volatile<string>
  /** `country` parameter; the empty string sends no country. */
  country: Volatile<string>
  /** `search_lang` parameter. */
  searchLang: Volatile<string>
  /** `ui_lang` parameter. */
  uiLang: Volatile<string>
  /** `safesearch` parameter. */
  safesearch: Volatile<BraveSafeSearch>
  /** `freshness` parameter (`pd`/`pw`/`pm`/`py` or `YYYY-MM-DDtoYYYY-MM-DD`); unset sends none. */
  freshness: Volatile<string | undefined>
  /** Provider-side timeout in milliseconds, validated at startup and again for every search, and never clamped. */
  timeoutMs: Volatile<number>
  /** Upper bound on `count`, clamped into Brave's 1..20 range. */
  maxResults: Volatile<number>
}

/** Plugin config schema. */
export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(BRAVE_DEFAULT_API_KEY_ENV).volatile(),
  baseURL: z.string().default(BRAVE_DEFAULT_BASE_URL).volatile(),
  country: z.string().default(BRAVE_DEFAULT_COUNTRY).volatile(),
  searchLang: z.string().default(BRAVE_DEFAULT_SEARCH_LANG).volatile(),
  uiLang: z.string().default(BRAVE_DEFAULT_UI_LANG).volatile(),
  safesearch: z.union([z.const('off'), z.const('moderate'), z.const('strict')]).default(BRAVE_DEFAULT_SAFESEARCH).volatile(),
  freshness: z.string().volatile(),
  timeoutMs: z.number().default(BRAVE_DEFAULT_TIMEOUT_MS).volatile(),
  maxResults: z.number().default(BRAVE_DEFAULT_COUNT).volatile(),
})

/**
 * Register the Brave search provider with `ctx.web`, scoped to the plugin's own fiber
 * so unloading the plugin unregisters it.
 * @param ctx - plugin context supplying the web, credential, and environment planes.
 * @param config - the currently authoritative settings section.
 * @throws {Error} when `timeoutMs` is not a positive finite value within the accepted bound.
 */
export function apply(ctx: Context, config: Config): void {
  assertTimeoutMs(config.timeoutMs.get())
  ctx.effect(() =>
    ctx.web.registerSearchProvider(
      new BraveSearchProvider({
        options: () => resolveOptions(ctx, config),
        fetch: globalThis.fetch,
      }),
    ),
  )
}

/**
 * Project one settings section into the options the provider serves its next search
 * with. Credential reads stay lazy: the service is asynchronous and may change between
 * searches, so each search resolves through the thunk instead of a snapshot.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative settings section.
 * @returns options for one search.
 */
function resolveOptions(ctx: Context, config: Config): BraveSearchProviderOptions {
  const apiKeyEnv = config.apiKeyEnv.get()
  const literal = config.apiKey.get()
  const readers = createCredentialReaders(ctx, apiKeyEnv)
  return {
    ...literal === undefined || literal.length === 0 ? {} : { apiKey: literal },
    apiKeyEnv,
    resolveCredential: readers.resolveCredential,
    readEnvironment: readers.readEnvironment,
    baseURL: config.baseURL.get(),
    country: config.country.get(),
    searchLang: config.searchLang.get(),
    uiLang: config.uiLang.get(),
    safesearch: config.safesearch.get(),
    freshness: config.freshness.get(),
    maxResults: config.maxResults.get(),
    timeoutMs: config.timeoutMs.get(),
  }
}
