/**
 * The Exa-backed search provider registered with `ctx.web`: it resolves the API key for
 * every search and delegates the HTTP request and response mapping to the
 * `ExaSearchProvider` this package carries. A fresh provider instance is built for each
 * search, so concurrent searches never share a key, an option snapshot, or a transcript of
 * state. A provider failure is rewritten before it leaves the provider, so its message
 * carries the provider, the credential reference, and a redacted bounded detail instead of
 * the raw text.
 *
 * @module @anago-harness/web-search-exa/provider
 */
import type { Context } from '@deepseek-ai/cordis'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import {
  EXA_PROVIDER_ID,
  ExaSearchProvider,
} from './exa.ts'
import {
  boundedProviderDetail,
  createCredentialReaders,
  redactSecret,
  resolveCredentialValue,
} from '@anago-harness/web-search-credentials'

/** Default credential reference shared by the credentials service and the launch environment. */
export const EXA_DEFAULT_API_KEY_ENV = 'EXA_API_KEY'

/** Longest query the Exa search endpoint accepts; longer queries are refused before dispatch. */
export const EXA_QUERY_MAX_CHARS = 2_000

/** Longest upstream detail a rewritten failure message carries, matching the Brave provider's bound. */
const MAX_UPSTREAM_DETAIL_CHARS = 200

/** Retrieval modes Exa accepts for its `type` field. */
export type ExaSearchType = 'auto' | 'keyword' | 'neural'

/**
 * Everything one search needs, already resolved for that operation. The credential itself is
 * not a field: it is resolved per search through {@link ExaCredentialProviderOptions.resolveCredential}
 * or the launch environment and never retained.
 */
export interface ExaCredentialProviderOptions {
  /** Literal key from the config; takes precedence when non-empty. */
  readonly apiKey?: string | undefined
  /** Credential reference name, used in messages and for both fallback reads. */
  readonly apiKeyEnv: string
  /** Read the reference through the credentials service; `undefined` while unconfigured or absent. */
  readonly resolveCredential: () => Promise<string | undefined>
  /** Read the reference from the launch environment; `undefined` while absent or empty. */
  readonly readEnvironment: () => string | undefined
  /** Base URL the `/search` path is appended to. */
  readonly baseURL: string
  /** Retrieval mode sent as Exa's `type`. */
  readonly searchType: ExaSearchType
  /** Highlight sentences requested per result (Exa's `highlightsPerUrl`). */
  readonly highlightsPerResult: number
}

/**
 * Build the credentials-service failure, naming the reference but never a value.
 * @param cause - what the service threw.
 * @param apiKeyEnv - the credential reference name.
 * @returns the mapped error.
 */
function credentialResolutionFailure(cause: unknown, apiKeyEnv: string): WebError {
  return new WebError(
    `Exa search could not resolve its API key reference for "${apiKeyEnv}". Check the credentials service, or set "apiKey" in the web-search-exa config.`,
    'WEB_PROVIDER_ERROR',
    { cause },
  )
}

/**
 * Resolve the key for one operation without retaining it: the literal config value first,
 * then the credentials service, then the launch environment.
 * @param options - this operation's snapshot.
 * @param signal - the caller's signal, checked across the asynchronous read.
 * @returns the resolved key.
 * @throws {WebError} `WEB_PROVIDER_CREDENTIAL_MISSING` when no source supplies one, or
 *   `WEB_PROVIDER_ERROR` when the credentials service fails.
 */
async function resolveApiKey(
  options: ExaCredentialProviderOptions,
  signal?: AbortSignal,
): Promise<string> {
  return resolveCredentialValue(options, signal, {
    aborted,
    resolutionFailure: credentialResolutionFailure,
    missing: credentialMissing,
  })
}

/**
 * Reject a query the Exa endpoint cannot accept, before any key is resolved or request is
 * dispatched. The message names the limit and the offending size, never the query text.
 * @param query - the caller's query.
 * @throws {WebError} `WEB_PROVIDER_ERROR` when the query is blank or longer than
 *   {@link EXA_QUERY_MAX_CHARS} characters.
 */
function assertSearchableQuery(query: string): void {
  if (query.trim().length === 0) {
    throw new WebError(
      'Exa search query must not be empty. Provide a non-empty query and search again.',
      'WEB_PROVIDER_ERROR',
    )
  }
  if (query.length > EXA_QUERY_MAX_CHARS) {
    throw new WebError(
      `Exa search query is ${query.length} characters long; the Exa search API accepts at most ${EXA_QUERY_MAX_CHARS} characters. Shorten the query and search again.`,
      'WEB_PROVIDER_ERROR',
    )
  }
}

/**
 * No key is reachable from any of the three sources. The message names the reference and
 * every place a key can live, never a value.
 * @param apiKeyEnv - the credential reference name.
 * @returns the mapped error.
 */
function credentialMissing(apiKeyEnv: string): WebError {
  return new WebError(
    `Exa search has no API key for "${apiKeyEnv}": the credentials service stores no value for it, the launching environment does not define it, and no literal "apiKey" is configured. Store the key through the credentials service, export it in the launching environment, or set "apiKey" in the web-search-exa config; create an Exa API key in the Exa dashboard if none exists yet.`,
    'WEB_PROVIDER_CREDENTIAL_MISSING',
  )
}

/**
 * Build the cancellation error, retaining the caller's reason. Only the
 * provider's abort checks call this, and each one runs after `aborted` is true.
 * @param signal - the caller's aborted signal.
 * @returns the mapped error.
 */
function aborted(signal: AbortSignal): WebError {
  return new WebError('Exa search aborted', 'WEB_ABORTED', { cause: signal.reason })
}

/**
 * Throw the cancellation error when the caller already aborted, so no credential read or
 * request is started for a cancelled search.
 * @param signal - the caller's signal, when one was passed.
 * @throws {WebError} `WEB_ABORTED` when the signal is already aborted.
 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw aborted(signal)
}

/**
 * Read a machine-routable code from a thrown value without requiring the harness class.
 * @param error - what the upstream provider threw.
 * @returns the code, or `undefined` when the value carries none.
 */
function failureCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

/**
 * Whether a rejection is a cancellation, including one that arrives without the harness class.
 * @param error - what the upstream provider threw.
 * @returns true when the value is named `AbortError`.
 */
function isAbortFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { name?: unknown }).name === 'AbortError'
}

/**
 * Render a thrown value's message for redaction.
 * @param error - what the upstream provider threw.
 * @returns its `message` when that is a string, otherwise `String(error)`.
 */
function failureText(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

/**
 * Rewrite an upstream failure as a `WebError` whose message names the provider and the
 * credential reference and carries only a redacted, bounded upstream detail — never the key
 * or the raw body. Cancellation stays `WEB_ABORTED`; every other failure keeps the upstream
 * code, and the upstream failure stays available as `cause`.
 * @param error - what the upstream provider threw.
 * @param apiKey - the key this search resolved; every occurrence is redacted from the message.
 * @param apiKeyEnv - the credential reference name stated in the message.
 * @returns the replacement error.
 */
function upstreamFailure(error: unknown, apiKey: string, apiKeyEnv: string): WebError {
  if (failureCode(error) === 'WEB_ABORTED' || isAbortFailure(error)) {
    return new WebError('Exa search aborted', 'WEB_ABORTED', { cause: error })
  }
  const code = failureCode(error) ?? 'WEB_PROVIDER_ERROR'
  const detail = boundedProviderDetail(redactSecret(failureText(error), apiKey), MAX_UPSTREAM_DETAIL_CHARS)
  const guidance = `Check the Exa service status, the "baseURL" setting in the web-search-exa config, and the key for "${apiKeyEnv}", then retry.`
  const message = detail.length === 0
    ? `Exa search failed for "${apiKeyEnv}" (${code}) with no upstream detail. ${guidance}`
    : `Exa search failed for "${apiKeyEnv}" (${code}): ${detail}. ${guidance}`
  return new WebError(message, code, { cause: error })
}

/** Construction inputs; the options thunk is the only collaborator. */
export interface ExaCredentialSearchProviderInit {
  /** Snapshot the settings for one operation, so one search never mixes two config sections. */
  readonly options: () => ExaCredentialProviderOptions
}

/** The Exa provider registered with `ctx.web`, with per-search credential resolution. */
export class ExaCredentialSearchProvider implements WebSearchProvider {
  /** Registry key; fixed at `exa` so provider selection cannot drift with config. */
  readonly id = EXA_PROVIDER_ID
  private readonly options: () => ExaCredentialProviderOptions

  /**
   * @param init - a thunk that snapshots the settings for one operation, so one search
   *   never mixes two config sections and no credential is retained between searches.
   */
  constructor(init: ExaCredentialSearchProviderInit) {
    this.options = init.options
  }

  /**
   * Whether a search could plausibly run. This never asks the credential service, which is
   * asynchronous, and never requires a key: a key stored in credentials must still make the
   * provider selectable, and an unconfigured reference surfaces at search time as
   * `WEB_PROVIDER_CREDENTIAL_MISSING`.
   * @returns true when the configured base URL parses.
   */
  available(): boolean {
    return URL.canParse(this.options().baseURL)
  }

  /**
   * Run one search through a fresh `ExaSearchProvider`.
   * @param request - the query and the caller's result bound.
   * @param signal - the caller's cancellation signal, when one was passed.
   * @returns the mapped sources; `truncated` is always false because the seam owns the bound.
   * @throws {WebError} `WEB_ABORTED` on cancellation, `WEB_PROVIDER_CREDENTIAL_MISSING` without
   *   a key, `WEB_PROVIDER_ERROR` on an unusable query or any carried provider failure. A
   *   provider failure is rewritten with the provider, the reference, and a redacted bounded
   *   detail, so no key or raw body reaches the message.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    throwIfAborted(signal)
    const options = this.options()
    // The query is actionable on its own, so report it before touching credentials.
    assertSearchableQuery(request.query)
    const apiKey = await resolveApiKey(options, signal)
    // Build the adapter from this operation's snapshot only. It validates the values it
    // receives and maps its own failures; retaining it would leak state across concurrent
    // searches.
    const provider = new ExaSearchProvider({
      apiKey,
      baseURL: options.baseURL,
      searchType: options.searchType,
      highlightsPerResult: options.highlightsPerResult,
    })
    try {
      return await provider.search(request, signal)
    } catch (error) {
      // Provider messages are built from intermediary-authored text; rewrite every failure so
      // the model sees the provider, the reference, and a redacted bounded detail only.
      throw upstreamFailure(error, apiKey, options.apiKeyEnv)
    }
  }
}

/**
 * Project one settings section into the options one search is served with. Credential reads
 * stay lazy: the credentials service is asynchronous and may change between searches.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param apiKeyEnv - the credential reference name for this operation.
 * @param literal - the literal key from the settings section, when configured.
 * @param settings - the non-secret settings for this operation.
 * @returns options for one search.
 */
export function exaProviderOptions(
  ctx: Context,
  apiKeyEnv: string,
  literal: string | undefined,
  settings: {
    readonly baseURL: string
    readonly searchType: ExaSearchType
    readonly highlightsPerResult: number
  },
): ExaCredentialProviderOptions {
  const readers = createCredentialReaders(ctx, apiKeyEnv)
  return {
    ...literal === undefined || literal.length === 0 ? {} : { apiKey: literal },
    apiKeyEnv,
    resolveCredential: readers.resolveCredential,
    readEnvironment: readers.readEnvironment,
    baseURL: settings.baseURL,
    searchType: settings.searchType,
    highlightsPerResult: settings.highlightsPerResult,
  }
}

/** Re-exported defaults so the plugin entry and its callers share one source. */
export { EXA_DEFAULT_BASE_URL, EXA_DEFAULT_HIGHLIGHTS_PER_RESULT, EXA_DEFAULT_SEARCH_TYPE, EXA_PROVIDER_ID } from './exa.ts'
