/**
 * Every failure the provider can report, expressed as a {@link WebError} with one of
 * the seam's shared codes. Messages stay actionable — where the key is stored, which
 * setting to correct, which endpoint was called — and never carry a credential, a raw
 * response body, or an environment value: exception text and response bodies are
 * intermediary-authored, so the resolved key is redacted from each fragment before it
 * enters a message.
 * @module @anago-harness/web-search-brave/errors
 */
import { boundedProviderDetail, redactSecret } from '@anago-harness/web-search-credentials'
import { WebError } from '@deepseek-ai/dsh-web'

/** Provider-side failure of any kind: rejection, rate limit, outage, transport, bad body, or timeout. */
export const WEB_PROVIDER_ERROR = 'WEB_PROVIDER_ERROR'
/** No API key could be resolved from the config, the credential service, or the launch environment. */
export const WEB_PROVIDER_CREDENTIAL_MISSING = 'WEB_PROVIDER_CREDENTIAL_MISSING'
/** The caller cancelled the search. */
export const WEB_ABORTED = 'WEB_ABORTED'

/** Longest response-body excerpt any message may carry. */
export const MAX_BODY_SUMMARY_CHARS = 200

/**
 * Reduce untrusted text to a message-safe excerpt: redact the resolved key and its base64
 * encodings, then strip control characters, collapse whitespace, and cap the result at
 * {@link MAX_BODY_SUMMARY_CHARS}. Redaction runs before the cap, so no prefix of a key
 * survives a truncation.
 * @param text - the untrusted text, such as an exception `String()` or a response body.
 * @param secret - the resolved key for this operation.
 * @returns the excerpt, or `undefined` when nothing printable remains.
 */
function safeExcerpt(text: string, secret: string): string | undefined {
  const bounded = boundedProviderDetail(redactSecret(text, secret), MAX_BODY_SUMMARY_CHARS)
  return bounded.length === 0 ? undefined : bounded
}

/**
 * Brave reports an invalid or missing subscription token as HTTP 422 with
 * `error.code` naming the token, so the status alone cannot classify it.
 */
const CREDENTIAL_CODE_PATTERN = /TOKEN|AUTH|UNAUTHORIZED|FORBIDDEN/iu
/** Codes that mean the request was throttled or the plan's usage cap was reached. */
const RATE_LIMIT_CODE_PATTERN = /RATE|QUOTA/iu
/** Codes that mean Brave rejected a request parameter. */
const VALIDATION_CODE_PATTERN = /VALID|QUERY|PARAM|BAD_REQUEST/iu

/** One non-2xx response, reduced to the facts a message may state. */
export interface HttpFailure {
  /** HTTP status code. */
  readonly status: number
  /** HTTP status text, possibly empty. */
  readonly statusText: string
  /** Provider-supplied detail; {@link httpFailure} redacts and caps it. */
  readonly detail?: string | undefined
  /** Brave's own `error.code`, when the body carried one; it outranks the status. */
  readonly providerCode?: string | undefined
  /** Endpoint that was called, without the query string. */
  readonly endpoint: string
  /** Credential reference name (never its value). */
  readonly apiKeyEnv: string
  /** Resolved key for this operation; every occurrence is redacted from the message. */
  readonly secret: string
  /** Settings-derived parameters actually sent, from `describeSearchSettings`. */
  readonly sentSettings: string
}

/** The signal facts one dispatch failure is classified against. */
export interface DispatchFailure {
  /** The caller's signal, absent when the caller passed none. */
  readonly signal?: AbortSignal | undefined
  /** The provider's own timeout signal. */
  readonly timeoutSignal: AbortSignal
  /** The configured timeout, stated in the timeout message. */
  readonly timeoutMs: number
  /** Endpoint that was called, without the query string. */
  readonly endpoint: string
  /** Resolved key for this operation; every occurrence is redacted from the message. */
  readonly secret: string
}

/**
 * Classify a `fetch` or body-read rejection. Caller cancellation wins over the
 * timeout, because a timeout that fires while the caller is also cancelling should
 * report the cancellation the caller asked for.
 * @param error - the rejection.
 * @param failure - the signals and the endpoint.
 * @returns the mapped error.
 */
export function dispatchFailure(error: unknown, failure: DispatchFailure): WebError {
  if (failure.signal?.aborted === true) return aborted(failure.signal)
  if (failure.timeoutSignal.aborted || isTimeoutError(error)) {
    return timeoutFailure(failure.timeoutMs, failure.endpoint, error)
  }
  if (isAbortError(error)) return aborted(failure.signal)
  return networkFailure(failure.endpoint, error, failure.secret)
}

/**
 * Classify a non-2xx response. Brave's own `error.code` outranks the status,
 * because a rejected subscription token arrives as HTTP 422 — the same status a
 * bad parameter uses. A token code points at the key, a rate or quota code at
 * throttling, a validation code at the settings, 401/403 at the key, 429 at the
 * rate limit (never retried automatically), and 5xx at Brave.
 * @param failure - the status, codes, detail, endpoint, and settings that were sent.
 * @returns the mapped error.
 */
export function httpFailure(failure: HttpFailure): WebError {
  const code = failure.providerCode
  // The status line, the provider code, and the detail are provider-authored, which in a
  // gateway or proxy failure means intermediary-authored; classify on the raw code, then
  // redact and bound every fragment that enters the message.
  const safeCode = code === undefined ? undefined : safeExcerpt(code, failure.secret)
  const safeStatusText = safeExcerpt(failure.statusText, failure.secret)
  const status = `HTTP ${failure.status}${safeCode === undefined ? '' : ` ${safeCode}`}${safeStatusText === undefined ? '' : ` ${safeStatusText}`}`
  const detailText = failure.detail === undefined ? undefined : safeExcerpt(failure.detail, failure.secret)
  const detail = detailText === undefined ? '' : `: ${detailText}`
  const endpoint = `The endpoint was ${JSON.stringify(failure.endpoint)}.`
  const isCredential =
    (code !== undefined && CREDENTIAL_CODE_PATTERN.test(code)) || failure.status === 401 || failure.status === 403
  if (isCredential) {
    return new WebError(
      `Brave search was rejected (${status})${detail}. The API key for "${failure.apiKeyEnv}" may be missing, invalid, or not entitled to the Web Search API; store a usable key through the credentials service, export it in the launching environment, or set "apiKey" in the web-search-brave config, then retry. ${endpoint}`,
      WEB_PROVIDER_ERROR,
    )
  }
  if ((code !== undefined && RATE_LIMIT_CODE_PATTERN.test(code)) || failure.status === 429) {
    return new WebError(
      `Brave search hit its rate limit (${status})${detail}. Wait before retrying; web-search-brave never retries automatically. ${endpoint}`,
      WEB_PROVIDER_ERROR,
    )
  }
  if ((code !== undefined && VALIDATION_CODE_PATTERN.test(code)) || failure.status === 400 || failure.status === 422) {
    return new WebError(
      `Brave search rejected the request parameters (${status})${detail}. The request sent ${failure.sentSettings}; correct the query or the web-search-brave config values, then retry. ${endpoint}`,
      WEB_PROVIDER_ERROR,
    )
  }
  if (failure.status >= 500) {
    return new WebError(
      `Brave search failed on the provider side (${status})${detail}. Retry later. ${endpoint}`,
      WEB_PROVIDER_ERROR,
    )
  }
  return new WebError(
    `Brave search returned an unexpected status (${status})${detail}. Check the baseURL setting in the web-search-brave config. ${endpoint}`,
    WEB_PROVIDER_ERROR,
  )
}

/**
 * No key is reachable from any of the three sources. The message names the reference
 * and every place a key can live, never a value.
 * @param apiKeyEnv - the credential reference name.
 * @returns the mapped error.
 */
export function credentialMissing(apiKeyEnv: string): WebError {
  return new WebError(
    `Brave search has no API key for "${apiKeyEnv}": the credentials service stores no value for it, the launching environment does not define it, and no literal "apiKey" is configured. Store the key through the credentials service (the web search settings page writes it), export it in the launching environment, or set "apiKey" in the web-search-brave config; create a Brave Search API key in the Brave dashboard if none exists yet.`,
    WEB_PROVIDER_CREDENTIAL_MISSING,
  )
}

/**
 * The credential service failed while resolving the reference. No key has been resolved at
 * this point, so there is none to redact; the exception text is still normalized and capped,
 * and the unredacted failure stays available as `cause` for logs.
 * @param cause - the resolver's failure; carried as `cause`.
 * @returns the mapped error.
 */
export function credentialResolutionFailure(cause: unknown): WebError {
  const summary = safeExcerpt(String(cause), '')
  return new WebError(
    `Brave search could not resolve its API key reference${summary === undefined ? '' : `: ${summary}`}. Check the credentials service, or set "apiKey" in the web-search-brave config.`,
    WEB_PROVIDER_ERROR,
    { cause },
  )
}

/**
 * The only characters this provider lets into a header value: horizontal tab,
 * printable ASCII, and the Latin-1 byte range. Anything else is refused before
 * dispatch, so no key can reach `fetch` and come back quoted inside its `TypeError`.
 */
const HEADER_VALUE_PATTERN = /^[\t\x20-\x7E\x80-\xFF]*$/u

/**
 * Whether a resolved key can travel as an HTTP header value at all. Node's `fetch`
 * rejects anything outside this set with its own `TypeError` — for a line break or a
 * NUL it even quotes the value, and for a non-Latin-1 character it names the offending
 * code point — so a key carrying a control character, a zero-width space, a byte-order
 * mark, or a smart quote must be refused before dispatch.
 * @param key - the resolved key.
 * @returns true when every character can travel in a header value.
 */
export function isHeaderTransmittable(key: string): boolean {
  return HEADER_VALUE_PATTERN.test(key)
}

/**
 * A resolved key that cannot be sent as a header. The message states the shape of the
 * problem — line break, control character, or a character outside the header byte
 * range — and never the value.
 * @param apiKeyEnv - the credential reference name.
 * @returns the mapped error.
 */
export function credentialUnusable(apiKeyEnv: string): WebError {
  return new WebError(
    `Brave search resolved an API key for "${apiKeyEnv}" that cannot be sent as an HTTP header: it carries a line break, a control character, or a character outside the header byte range (an invisible formatting character or a smart quote, for example). Re-store the key without surrounding whitespace or hidden characters; the value is never logged.`,
    WEB_PROVIDER_ERROR,
  )
}

/**
 * The request never produced a response. The failure becomes a one-line summary of at
 * most {@link MAX_BODY_SUMMARY_CHARS} characters instead of a dump, with the resolved key
 * redacted: a transport wrapper can quote the request it failed to send.
 * @param endpoint - endpoint that was called, without the query string.
 * @param cause - the transport failure; carried as `cause`.
 * @param secret - the resolved key for this operation.
 * @returns the mapped error.
 */
export function networkFailure(endpoint: string, cause: unknown, secret: string): WebError {
  const summary = safeExcerpt(String(cause), secret)
  return new WebError(
    `Brave search could not reach its endpoint${summary === undefined ? '' : `: ${summary}`}. Check network access and the baseURL setting in the web-search-brave config; the endpoint was ${JSON.stringify(endpoint)}.`,
    WEB_PROVIDER_ERROR,
    { cause },
  )
}

/**
 * A 2xx response whose body is not JSON. The body becomes a one-line summary of at most
 * {@link MAX_BODY_SUMMARY_CHARS} characters instead of a dump, with the resolved key
 * redacted: a proxy can echo the request it forwarded.
 * @param endpoint - endpoint that was called, without the query string.
 * @param body - the raw body text.
 * @param secret - the resolved key for this operation.
 * @param cause - the parse failure, when one is available.
 * @returns the mapped error.
 */
export function bodyParseFailure(endpoint: string, body: string, secret: string, cause?: unknown): WebError {
  const summary = safeExcerpt(body, secret)
  return new WebError(
    `Brave search returned a response that is not JSON${summary === undefined ? ' (the body was empty)' : `: ${summary}`}. The endpoint was ${JSON.stringify(endpoint)}.`,
    WEB_PROVIDER_ERROR,
    cause === undefined ? undefined : { cause },
  )
}

/**
 * The provider's own timeout fired.
 * @param timeoutMs - the configured timeout, stated in the message.
 * @param endpoint - endpoint that was called, without the query string.
 * @param cause - the timeout rejection, when one is available.
 * @returns the mapped error.
 */
export function timeoutFailure(timeoutMs: number, endpoint: string, cause?: unknown): WebError {
  return new WebError(
    `Brave search timed out after ${timeoutMs}ms. Raise timeoutMs in the web-search-brave config or retry later; the endpoint was ${JSON.stringify(endpoint)}.`,
    WEB_PROVIDER_ERROR,
    cause === undefined ? undefined : { cause },
  )
}

/**
 * Build the cancellation error, retaining the caller's reason.
 * @param signal - the caller's signal, when it was passed and aborted.
 * @returns the mapped error.
 */
export function aborted(signal?: AbortSignal): WebError {
  if (signal === undefined || !signal.aborted) return new WebError('Brave search aborted', WEB_ABORTED)
  return new WebError('Brave search aborted', WEB_ABORTED, { cause: signal.reason })
}

/**
 * Throw the cancellation error when the caller already aborted, so no request is
 * dispatched for a cancelled search.
 * @param signal - the caller's signal, when it was passed.
 * @throws {@link WebError} `WEB_ABORTED` when the signal is already aborted.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw aborted(signal)
}

/**
 * Reduce a response body to a single-line excerpt of at most
 * {@link MAX_BODY_SUMMARY_CHARS} characters. This is a structural reduction only; the
 * message builders call {@link safeExcerpt}, which also redacts the resolved key.
 * @param body - the raw body text.
 * @returns the summary, or `undefined` for a blank body.
 */
export function summarizeBody(body: string): string | undefined {
  const summary = boundedProviderDetail(body, MAX_BODY_SUMMARY_CHARS)
  return summary.length === 0 ? undefined : summary
}

/**
 * Pull Brave's own message out of a JSON error body, checking only the keys the API
 * documents, then fall back to a summary of the raw body.
 * @param payload - the parsed error body.
 * @returns the detail, already capped, or `undefined` when none is present.
 */
export function extractErrorDetail(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const nested = record['error']
  if (typeof nested === 'string') return summarizeBody(nested)
  const candidates: unknown[] = []
  if (typeof nested === 'object' && nested !== null) {
    const inner = nested as Record<string, unknown>
    candidates.push(inner['detail'], inner['message'])
  }
  candidates.push(record['detail'], record['message'])
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const summary = summarizeBody(candidate)
    if (summary !== undefined) return summary
  }
  return undefined
}

/**
 * Read Brave's own `error.code` out of an error body. The code distinguishes a
 * rejected subscription token (HTTP 422) from a rejected parameter (also HTTP 422).
 * @param payload - the parsed error body.
 * @returns the code, or `undefined` when the body carries none.
 */
export function extractErrorCode(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const nested = record['error']
  if (typeof nested === 'object' && nested !== null) {
    const code = (nested as Record<string, unknown>)['code']
    if (typeof code === 'string' && code.length > 0) return code
  }
  const top = record['code']
  return typeof top === 'string' && top.length > 0 ? top : undefined
}

/**
 * Whether a rejection is the timeout signal's `TimeoutError`.
 * @param error - the rejected value, which need not be an `Error` instance.
 * @returns true when its `name` is `TimeoutError`.
 */
export function isTimeoutError(error: unknown): boolean {
  return errorName(error) === 'TimeoutError'
}

/**
 * Whether a rejection is an `AbortError` from a signal.
 * @param error - the rejected value, which need not be an `Error` instance.
 * @returns true when its `name` is `AbortError`.
 */
export function isAbortError(error: unknown): boolean {
  return errorName(error) === 'AbortError'
}

/** Read an error-like value's `name` without requiring it to be an `Error` instance. */
function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' ? name : undefined
}
