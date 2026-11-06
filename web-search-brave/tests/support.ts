/**
 * Shared fixtures for the Brave provider suites: an injected `fetch` that records its
 * calls, response builders, and one operation's options. No test in this package opens
 * a socket.
 * @module @anago-harness/web-search-brave/test/support
 */
import { BraveSearchProvider, type BraveSearchProviderOptions } from '../src/provider.ts'

/** The input type `globalThis.fetch` accepts, avoiding a global `RequestInfo` name that Node types do not export. */
export type FetchInput = Parameters<typeof globalThis.fetch>[0]
/** The init type `globalThis.fetch` accepts. */
export type FetchInit = NonNullable<Parameters<typeof globalThis.fetch>[1]>

/** One recorded `fetch` call. */
export interface FetchCall {
  readonly url: string
  readonly init: RequestInit
}

/** A `fetch` replacement plus the calls it recorded. */
export interface RecordingFetch {
  readonly fetch: typeof globalThis.fetch
  readonly calls: FetchCall[]
}

/**
 * The URL a `fetch` call requested, as text. The input may also be a `Request`,
 * whose stringification is not its URL.
 * @param input - the first argument the provider passed to `fetch`.
 * @returns the absolute URL.
 */
function requestUrl(input: FetchInput): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

/**
 * Build a `fetch` replacement that records every call and answers from `respond`.
 * @param respond - the response for one call; may throw to simulate a transport failure.
 * @returns the implementation and its call log.
 */
export function recordingFetch(respond: (call: FetchCall) => Response | Promise<Response>): RecordingFetch {
  const calls: FetchCall[] = []
  const impl = async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const call: FetchCall = { url: requestUrl(input), init: init ?? {} }
    calls.push(call)
    return await respond(call)
  }
  return { fetch: impl, calls }
}

/** A JSON response. */
export function jsonResponse(body: unknown, status = 200, statusText = ''): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  })
}

/** A non-JSON response. */
export function textResponse(body: string, status = 200, statusText = ''): Response {
  return new Response(body, { status, statusText, headers: { 'content-type': 'text/plain' } })
}

/** A Brave-shaped success body around the given `web.results` entries. */
export function bravePayload(results: readonly unknown[]): unknown {
  return { type: 'search', web: { type: 'search', results } }
}

/** One result entry with every field Brave documents. */
export function braveResult(url: string, title = 'Title', description = 'Description'): Record<string, unknown> {
  return { url, title, description }
}

/** Options for one operation, with every credential source empty unless overridden. */
export function providerOptions(overrides: Partial<BraveSearchProviderOptions> = {}): BraveSearchProviderOptions {
  return {
    apiKeyEnv: 'BRAVE_API_KEY',
    resolveCredential: async () => undefined,
    readEnvironment: () => undefined,
    baseURL: 'https://api.search.brave.com',
    country: 'JP',
    searchLang: 'jp',
    uiLang: 'ja-JP',
    safesearch: 'moderate',
    maxResults: 8,
    timeoutMs: 1_000,
    ...overrides,
  }
}

/** Build a provider over one fixed options snapshot. */
export function providerWith(
  options: BraveSearchProviderOptions,
  fetchImpl: typeof globalThis.fetch,
): BraveSearchProvider {
  return new BraveSearchProvider({ options: () => options, fetch: fetchImpl })
}

/** The reason a signal aborted, as an `Error`; `AbortSignal.reason` is typed `any`. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error('the request was aborted')
}

/** A `fetch` that never answers on its own and rejects with the abort reason it is given. */
export interface HangingFetch {
  readonly fetch: typeof globalThis.fetch
  /** Settles once the implementation has been entered. */
  readonly started: Promise<void>
  /** The signals handed to `fetch`, in call order. */
  readonly signals: AbortSignal[]
}

/** Build a `fetch` that hangs until its signal aborts. */
export function hangingFetch(): HangingFetch {
  let notify: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    notify = resolve
  })
  const signals: AbortSignal[] = []
  const impl = (_input: FetchInput, init?: FetchInit): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      notify?.()
      const signal = init?.signal
      if (signal === undefined || signal === null) return
      signals.push(signal)
      signal.addEventListener('abort', () => {
        reject(abortReason(signal))
      }, { once: true })
    })
  return { fetch: impl, started, signals }
}

/** Header lookup that tolerates the casing a test happens to write. */
export function headerOf(init: RequestInit, name: string): string | undefined {
  const headers = new Headers(init.headers)
  return headers.get(name) ?? undefined
}
