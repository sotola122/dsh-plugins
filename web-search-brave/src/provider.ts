/**
 * The Brave-backed search provider: one `GET /res/v1/web/search` per search, with the
 * caller's cancellation and the provider's own timeout composed into a single signal.
 * The provider holds no mutable state, so concurrent searches from `web_search`'s
 * parallel queries cannot interfere; every operation re-reads its options and
 * re-resolves its credential.
 * @module @anago-harness/web-search-brave/provider
 */
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import { resolveCredentialValue } from '@anago-harness/web-search-credentials'
import {
  aborted,
  bodyParseFailure,
  credentialMissing,
  credentialResolutionFailure,
  credentialUnusable,
  dispatchFailure,
  extractErrorDetail,
  extractErrorCode,
  httpFailure,
  isHeaderTransmittable,
  summarizeBody,
  throwIfAborted,
  WEB_PROVIDER_ERROR,
} from './errors.ts'
import { mapSearchResponse } from './map.ts'
import { buildSearchHeaders, buildSearchPlan, describeSearchSettings, type BraveSearchSettings } from './request.ts'

/** Stable id this provider registers under; `searchProvider: brave` selects it. */
export const BRAVE_PROVIDER_ID = 'brave'
/** Endpoint used when the config sets no `baseURL`. */
export const BRAVE_DEFAULT_BASE_URL = 'https://api.search.brave.com'
/** Provider timeout used when the config sets none. */
export const BRAVE_DEFAULT_TIMEOUT_MS = 10_000
/** Largest accepted `timeoutMs`; the `web_search` tool's own 30s deadline is the outer bound. */
export const MAX_TIMEOUT_MS = 30_000

/**
 * Everything one search needs, already resolved for that operation. The credential
 * itself is not a field: it is resolved per search through
 * {@link BraveSearchProviderOptions.resolveCredential} and never retained.
 */
export interface BraveSearchProviderOptions extends BraveSearchSettings {
  /** Literal key from the config; takes precedence when non-empty. */
  readonly apiKey?: string | undefined
  /** Credential reference name, used in messages and for both fallback reads. */
  readonly apiKeyEnv: string
  /** Read the reference through the credentials service; `undefined` while unconfigured or absent. */
  readonly resolveCredential: () => Promise<string | undefined>
  /** Read the reference from the launch environment; `undefined` while absent or empty. */
  readonly readEnvironment: () => string | undefined
  /** Base URL the Web Search path is appended to. */
  readonly baseURL: string
  /** Provider-side timeout in milliseconds. */
  readonly timeoutMs: number
}

/** Construction inputs; `fetch` is injectable so tests never open a socket. */
export interface BraveSearchProviderInit {
  /** Snapshot the options for one operation, so one search never mixes two config sections. */
  readonly options: () => BraveSearchProviderOptions
  /** `fetch` implementation; defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch | undefined
}

/**
 * Reject an unusable `timeoutMs` at plugin startup. The value is validated, never
 * clamped, because a silent clamp would hide a broken configuration.
 * @param value - the configured timeout.
 * @throws {Error} when the value is not a positive finite number, or exceeds {@link MAX_TIMEOUT_MS}.
 */
export function assertTimeoutMs(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `web-search-brave timeoutMs must be a positive finite number of milliseconds; received ${String(value)}`,
    )
  }
  if (value > MAX_TIMEOUT_MS) {
    throw new Error(
      `web-search-brave timeoutMs must not exceed ${MAX_TIMEOUT_MS}ms, the web_search tool's own deadline; received ${String(value)}`,
    )
  }
}

/**
 * Re-validate `timeoutMs` for one search, against the same bound as startup. The
 * setting is volatile, so a value accepted at startup can be replaced before the next
 * search; `AbortSignal.timeout` would then throw a `RangeError` that names no setting.
 * @param value - this operation's timeout.
 * @throws {WebError} `WEB_PROVIDER_ERROR` when the value is not a positive finite number, or exceeds {@link MAX_TIMEOUT_MS}.
 */
function assertSearchTimeoutMs(value: number): void {
  if (Number.isFinite(value) && value > 0 && value <= MAX_TIMEOUT_MS) return
  throw new WebError(
    `web-search-brave timeoutMs must be greater than 0 and at most ${MAX_TIMEOUT_MS}ms; received ${String(value)}. Correct the "timeoutMs" setting in the web-search-brave config, then retry.`,
    WEB_PROVIDER_ERROR,
  )
}

/** The Brave Search provider registered with `ctx.web`. */
export class BraveSearchProvider implements WebSearchProvider {
  /** Registry key; fixed at `brave` so provider selection cannot drift with config. */
  readonly id = BRAVE_PROVIDER_ID
  private readonly options: () => BraveSearchProviderOptions
  private readonly fetchImpl: typeof globalThis.fetch

  /**
   * @param init - the options thunk and an optional `fetch` override.
   */
  constructor(init: BraveSearchProviderInit) {
    this.options = init.options
    this.fetchImpl = init.fetch ?? globalThis.fetch
  }

  /**
   * Whether a search could plausibly run: a literal key or a launch-environment value
   * exists, and the base URL parses. This never touches the network and never asks the
   * credential service, which is asynchronous; an unconfigured reference surfaces at
   * search time as `WEB_PROVIDER_CREDENTIAL_MISSING`.
   * @returns true when the provider is locally usable.
   */
  available(): boolean {
    // キーの有無は検索時に解決する（credentials サービスは非同期で、同期の available()
    // からは引けない）。ここでローカルに見えるキーだけを条件にすると、credentials に
    // 保存したキーが選抜段階で WEB_PROVIDER_CONFIGURED_UNAVAILABLE になり、保存経路が
    // 事実上使えなくなる。参考実装（dsh-web-search-deepseek）も同じ理由でここを素通しにする。
    return URL.canParse(this.options().baseURL)
  }

  /**
   * Run one search.
   * @param request - the query and the caller's result bound.
   * @param signal - the caller's cancellation signal, when one was passed.
   * @returns the mapped sources; `truncated` is always false because the seam owns it.
   * @throws {WebError} `WEB_ABORTED` on cancellation, `WEB_PROVIDER_CREDENTIAL_MISSING` without a key,
   *   `WEB_PROVIDER_ERROR` on every provider failure.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    throwIfAborted(signal)
    const options = this.options()
    // クエリ検証は資格情報の解決より先に行う。鍵が未設定でも、呼び出し側が直せるクエリの
    // 誤りを鍵のエラーより先に返すため（どちらも副作用はない）。
    const plan = buildSearchPlan(options.baseURL, options, request)
    assertSearchTimeoutMs(options.timeoutMs)
    const apiKey = await this.resolveApiKey(options, signal)
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs)
    const composed = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
    const fetchImpl = this.fetchImpl
    const failure = { signal, timeoutSignal, timeoutMs: options.timeoutMs, endpoint: plan.endpoint, secret: apiKey }

    let response: Response
    try {
      response = await fetchImpl(plan.url, {
        method: 'GET',
        headers: buildSearchHeaders(apiKey),
        redirect: 'error',
        signal: composed,
      })
    } catch (error) {
      throw dispatchFailure(error, failure)
    }

    let body: string
    try {
      body = await response.text()
    } catch (error) {
      throw dispatchFailure(error, failure)
    }

    const parsed = parseJson(body)
    if (!response.ok) {
      const detail = (parsed === undefined ? undefined : extractErrorDetail(parsed.value)) ?? summarizeBody(body)
      throw httpFailure({
        status: response.status,
        statusText: response.statusText,
        detail,
        providerCode: parsed === undefined ? undefined : extractErrorCode(parsed.value),
        endpoint: plan.endpoint,
        apiKeyEnv: options.apiKeyEnv,
        secret: apiKey,
        sentSettings: describeSearchSettings(plan.params),
      })
    }
    if (parsed === undefined) throw bodyParseFailure(plan.endpoint, body, apiKey)
    return mapSearchResponse(parsed.value)
  }

  /**
   * Resolve the key for one operation without retaining it: the literal config value
   * first, then the credentials service, then the launch environment.
   * @param options - this operation's snapshot.
   * @param signal - the caller's signal, checked across the asynchronous read.
   * @returns the resolved key.
   * @throws {WebError} `WEB_PROVIDER_CREDENTIAL_MISSING` when no source supplies one,
   *   `WEB_PROVIDER_ERROR` when the resolved key cannot be sent.
   */
  private async resolveApiKey(options: BraveSearchProviderOptions, signal?: AbortSignal): Promise<string> {
    const key = await this.lookupApiKey(options, signal)
    if (!isHeaderTransmittable(key)) throw credentialUnusable(options.apiKeyEnv)
    return key
  }

  /**
   * Read the key from the first source that supplies one, in the documented order.
   * @param options - this operation's snapshot.
   * @param signal - the caller's signal, checked across the asynchronous read.
   * @returns the resolved key.
   * @throws {WebError} `WEB_PROVIDER_CREDENTIAL_MISSING` when no source supplies one.
   */
  private async lookupApiKey(options: BraveSearchProviderOptions, signal?: AbortSignal): Promise<string> {
    return resolveCredentialValue(options, signal, {
      aborted,
      resolutionFailure: credentialResolutionFailure,
      missing: credentialMissing,
    })
  }
}

/** One parsed JSON body, wrapped so a literal `null` stays distinguishable from a parse failure. */
interface ParsedBody {
  readonly value: unknown
}

/** Parse a body without throwing, so the caller can classify the failure itself. */
function parseJson(body: string): ParsedBody | undefined {
  try {
    return { value: JSON.parse(body) }
  } catch {
    return undefined
  }
}
