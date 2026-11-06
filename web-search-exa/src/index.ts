/**
 * Exa-backed search provider for `ctx.web`. The fork carries the provider implementation
 * itself because upstream 0.2.2 no longer ships `@deepseek-ai/dsh-web-search-exa`. Unlike
 * that removed upstream plugin, which read only the settings value and the launch
 * environment, this plugin resolves its key per search through the credentials service as
 * well, so a key saved from the settings surface is usable without a restart.
 *
 * @module @anago-harness/web-search-exa
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
} from './provider.ts'
import {
  EXA_DEFAULT_API_KEY_ENV,
  ExaCredentialSearchProvider,
  exaProviderOptions,
  type ExaSearchType,
} from './provider.ts'

export {
  EXA_DEFAULT_API_KEY_ENV,
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
  EXA_PROVIDER_ID,
  ExaCredentialSearchProvider,
} from './provider.ts'
export type { ExaCredentialProviderOptions, ExaSearchType } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-exa'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config; every field is volatile, so a settings change reaches the next search. */
export interface Config {
  /** Literal Exa API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey: Volatile<string | undefined>
  /** Credential reference resolved for each search; defaults to `EXA_API_KEY`. */
  apiKeyEnv: Volatile<string>
  /** Endpoint base; `/search` is appended. Defaults to the public Exa API. */
  baseURL: Volatile<string>
  /** Retrieval mode sent as Exa's `type`; defaults to `auto`. */
  searchType: Volatile<ExaSearchType>
  /** Highlight sentences requested per result; defaults to one. */
  highlightsPerResult: Volatile<number>
}

/** Plugin config schema. */
export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(EXA_DEFAULT_API_KEY_ENV).volatile(),
  baseURL: z.string().default(EXA_DEFAULT_BASE_URL).volatile(),
  searchType: z.union(['auto', 'keyword', 'neural'] as const).default(EXA_DEFAULT_SEARCH_TYPE).volatile(),
  highlightsPerResult: z.number().step(1).min(1).default(EXA_DEFAULT_HIGHLIGHTS_PER_RESULT).volatile(),
})

/**
 * Register the Exa search provider with `ctx.web`, scoped to the plugin's own fiber so
 * unloading the plugin unregisters it.
 * @param ctx - plugin context supplying the web, credential, and environment planes.
 * @param config - the currently authoritative settings section.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() =>
    ctx.web.registerSearchProvider(
      new ExaCredentialSearchProvider({
        options: () => exaProviderOptions(ctx, config.apiKeyEnv.get(), config.apiKey.get(), {
          baseURL: config.baseURL.get(),
          searchType: config.searchType.get(),
          highlightsPerResult: config.highlightsPerResult.get(),
        }),
      }),
    ),
  )
}
