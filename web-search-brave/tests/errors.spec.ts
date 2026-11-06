/**
 * Error-classification suite (DESIGN §3.7 / §6.2 単体（エラー）): the code and the
 * actionable wording for each failure class, with the guarantees that no message
 * carries a key and no body is dumped.
 * @module @anago-harness/web-search-brave/test/errors.spec
 */
import { WebError } from '@deepseek-ai/dsh-web'
import { describe, expect, it } from 'vitest'
import {
  aborted,
  bodyParseFailure,
  credentialMissing,
  credentialResolutionFailure,
  credentialUnusable,
  dispatchFailure,
  extractErrorCode,
  extractErrorDetail,
  httpFailure,
  isAbortError,
  isHeaderTransmittable,
  isTimeoutError,
  MAX_BODY_SUMMARY_CHARS,
  networkFailure,
  summarizeBody,
  throwIfAborted,
  timeoutFailure,
  WEB_ABORTED,
  WEB_PROVIDER_CREDENTIAL_MISSING,
  WEB_PROVIDER_ERROR,
} from '../src/errors.ts'

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
const SECRET = 'brave-secret-value'

/** One HTTP failure with everything the message may state. */
function failure(status: number, detail?: string): WebError {
  return httpFailure({
    status,
    statusText: 'Status',
    detail,
    endpoint: ENDPOINT,
    apiKeyEnv: 'BRAVE_API_KEY',
    secret: SECRET,
    sentSettings: 'count=8, country=JP, search_lang=jp, ui_lang=ja-JP, safesearch=moderate',
  })
}

describe('summarizeBody', () => {
  it('reduces a body to one line', () => {
    expect(summarizeBody('line one\n\n  line two\t')).toBe('line one line two')
  })

  it('reports a blank body as absent', () => {
    expect(summarizeBody(' \n ')).toBeUndefined()
  })

  it('caps the summary at 200 characters', () => {
    const summary = summarizeBody('x'.repeat(5_000))
    expect(summary).toBeDefined()
    expect(summary?.length).toBe(MAX_BODY_SUMMARY_CHARS)
    expect(summary?.endsWith('…')).toBe(true)
  })
})

describe('extractErrorDetail', () => {
  it('reads the documented Brave error keys', () => {
    expect(extractErrorDetail({ error: { detail: 'Invalid token', code: 'SUBSCRIPTION_TOKEN_INVALID' } })).toBe(
      'Invalid token',
    )
    expect(extractErrorDetail({ error: { message: 'Nested message' } })).toBe('Nested message')
    expect(extractErrorDetail({ message: 'Top message' })).toBe('Top message')
    expect(extractErrorDetail({ detail: 'Top detail' })).toBe('Top detail')
    expect(extractErrorDetail({ error: 'Plain text' })).toBe('Plain text')
  })

  it('returns nothing for a body with no message', () => {
    expect(extractErrorDetail({ unexpected: true })).toBeUndefined()
    expect(extractErrorDetail('text')).toBeUndefined()
    expect(extractErrorDetail(null)).toBeUndefined()
  })

  it('caps a long provider message', () => {
    expect(extractErrorDetail({ message: 'y'.repeat(1_000) })?.length).toBe(MAX_BODY_SUMMARY_CHARS)
  })

  it('skips a blank candidate and reads the next message', () => {
    expect(extractErrorDetail({ error: { detail: '  ', message: 'Useful message' } })).toBe('Useful message')
  })
})

describe('httpFailure', () => {
  it('points at the key for 401 and 403', () => {
    for (const status of [401, 403]) {
      const error = failure(status, 'bad token')
      expect(error.code).toBe(WEB_PROVIDER_ERROR)
      expect(error.message).toContain(`HTTP ${status}`)
      expect(error.message).toContain('bad token')
      expect(error.message).toContain('BRAVE_API_KEY')
      expect(error.message).toContain('credentials service')
      expect(error.message).toContain(ENDPOINT)
    }
  })

  it('points at the settings for 400 and 422', () => {
    for (const status of [400, 422]) {
      const error = failure(status)
      expect(error.code).toBe(WEB_PROVIDER_ERROR)
      expect(error.message).toContain(`HTTP ${status}`)
      expect(error.message).toContain('count=8')
      expect(error.message).toContain('country=JP')
      expect(error.message).toContain('web-search-brave config')
    }
  })

  it('points at the rate limit for 429 without promising a retry', () => {
    const error = failure(429)
    expect(error.code).toBe(WEB_PROVIDER_ERROR)
    expect(error.message).toContain('rate limit')
    expect(error.message).toContain('Wait before retrying')
    expect(error.message).toContain('never retries automatically')
  })

  it('points at Brave for 5xx', () => {
    for (const status of [500, 503]) {
      const error = failure(status)
      expect(error.code).toBe(WEB_PROVIDER_ERROR)
      expect(error.message).toContain('provider side')
      expect(error.message).toContain('Retry later')
      expect(error.message).toContain(ENDPOINT)
    }
  })

  it('names the endpoint for any other status', () => {
    const error = failure(404)
    expect(error.code).toBe(WEB_PROVIDER_ERROR)
    expect(error.message).toContain('HTTP 404')
    expect(error.message).toContain('baseURL')
    expect(error.message).toContain(ENDPOINT)
  })

  it('omits the status text when the response carried none', () => {
    const error = httpFailure({
      status: 404,
      statusText: '',
      endpoint: ENDPOINT,
      apiKeyEnv: 'BRAVE_API_KEY',
      secret: SECRET,
      sentSettings: 'count=8',
    })
    expect(error.message).toContain('HTTP 404')
    expect(error.message).not.toContain('HTTP 404  ')
  })

  it('never echoes the token header or a credential value', () => {
    for (const status of [400, 401, 403, 422, 429, 500, 404]) {
      const message = failure(status).message
      expect(message).not.toContain('X-Subscription-Token')
      expect(message).not.toContain('apiKey=')
    }
  })
})

describe('credential faults', () => {
  it('names every place a key can live without a value', () => {
    const error = credentialMissing('BRAVE_API_KEY')
    expect(error.code).toBe(WEB_PROVIDER_CREDENTIAL_MISSING)
    expect(error.message).toContain('BRAVE_API_KEY')
    expect(error.message).toContain('credentials service')
    expect(error.message).toContain('launching environment')
    expect(error.message).toContain('"apiKey"')
  })

  it('carries a resolver failure as cause', () => {
    const cause = new Error('store unavailable')
    const error = credentialResolutionFailure(cause)
    expect(error.code).toBe(WEB_PROVIDER_ERROR)
    expect(error.message).toContain('store unavailable')
    expect(error.cause).toBe(cause)
  })

  it('caps a long resolver failure instead of embedding it whole', () => {
    const error = credentialResolutionFailure(new Error('x'.repeat(5_000)))
    expect(error.code).toBe(WEB_PROVIDER_ERROR)
    expect(error.message).not.toContain('x'.repeat(300))
    expect(error.message.length).toBeLessThan(MAX_BODY_SUMMARY_CHARS * 2)
  })

  it('keeps the concise wording when the resolver failure has no text', () => {
    const error = credentialResolutionFailure('')
    expect(error.message).toContain('could not resolve its API key reference.')
    expect(error.message).toContain('credentials service')
  })

  it('accepts every character an HTTP header value can carry', () => {
    for (const key of ['plain-key', 'tab\tinside', 'café-key', 'latin-1-ÿ']) {
      expect(isHeaderTransmittable(key)).toBe(true)
    }
  })

  it('refuses a key carrying a character that cannot travel in a header value', () => {
    for (const key of [
      'key\n', // 改行
      'key\r\nX-Evil: 1', // CRLF ヘッダ注入
      'key\u0000', // NUL
      'key\u200B', // ゼロ幅スペース
      'key\uFEFF', // BOM
      'key\u201C', // スマートクオート
      'キー', // Latin-1 の外
    ]) {
      expect(isHeaderTransmittable(key)).toBe(false)
    }
  })

  it('refuses a key that no HTTP header can carry, without naming it', () => {
    expect(isHeaderTransmittable('plain-key')).toBe(true)
    expect(isHeaderTransmittable('key\n')).toBe(false)
    expect(isHeaderTransmittable('key\r\nX-Evil: 1')).toBe(false)
    expect(isHeaderTransmittable('key\u0000')).toBe(false)
    const error = credentialUnusable('BRAVE_API_KEY')
    expect(error.code).toBe(WEB_PROVIDER_ERROR)
    expect(error.message).toContain('BRAVE_API_KEY')
    expect(error.message).toContain('line break')
    expect(error.message).not.toContain('plain-key')
  })
})

describe('transport faults', () => {
  it('carries a transport failure as cause and names the endpoint', () => {
    const cause = new TypeError('fetch failed')
    const error = networkFailure(ENDPOINT, cause, SECRET)
    expect(error.code).toBe(WEB_PROVIDER_ERROR)
    expect(error.message).toContain('fetch failed')
    expect(error.message).toContain(ENDPOINT)
    expect(error.cause).toBe(cause)
  })

  it('caps a long transport failure instead of embedding it whole', () => {
    const error = networkFailure(ENDPOINT, new TypeError('y'.repeat(5_000)), SECRET)
    expect(error.message).not.toContain('y'.repeat(300))
    expect(error.message.length).toBeLessThan(MAX_BODY_SUMMARY_CHARS * 2)
  })

  it('keeps the concise wording when the transport failure has no text', () => {
    const error = networkFailure(ENDPOINT, '', SECRET)
    expect(error.message).toContain('could not reach its endpoint.')
    expect(error.message).toContain(ENDPOINT)
  })

  it('summarizes rather than dumps a non-JSON body', () => {
    const error = bodyParseFailure(ENDPOINT, `<html>${'x'.repeat(5_000)}</html>`, SECRET)
    expect(error.code).toBe(WEB_PROVIDER_ERROR)
    expect(error.message).toContain('not JSON')
    expect(error.message).toContain(ENDPOINT)
    expect(error.message.length).toBeLessThan(MAX_BODY_SUMMARY_CHARS * 2)
  })

  it('reports an empty non-JSON body as empty', () => {
    expect(bodyParseFailure(ENDPOINT, '  ', SECRET).message).toContain('body was empty')
  })

  it('carries the parse failure as cause when one is available', () => {
    const cause = new SyntaxError('bad json')
    expect(bodyParseFailure(ENDPOINT, 'nope', SECRET, cause).cause).toBe(cause)
  })

  it('states the timeout and the endpoint', () => {
    const error = timeoutFailure(10_000, ENDPOINT)
    expect(error.code).toBe(WEB_PROVIDER_ERROR)
    expect(error.message).toContain('10000ms')
    expect(error.message).toContain('timeoutMs')
    expect(error.message).toContain(ENDPOINT)
  })
})

describe('cancellation', () => {
  it('uses WEB_ABORTED and keeps the caller’s reason', () => {
    const controller = new AbortController()
    const reason = new Error('caller cancelled')
    controller.abort(reason)
    const error = aborted(controller.signal)
    expect(error.code).toBe(WEB_ABORTED)
    expect(error.cause).toBe(reason)
  })

  it('reports cancellation without a cause when no signal was passed', () => {
    const error = aborted()
    expect(error.code).toBe(WEB_ABORTED)
    expect(error.cause).toBeUndefined()
  })

  it('reports cancellation without a cause while its signal is not aborted', () => {
    const error = aborted(new AbortController().signal)
    expect(error.code).toBe(WEB_ABORTED)
    expect(error.cause).toBeUndefined()
  })

  it('throws before dispatch when the caller already aborted', () => {
    const controller = new AbortController()
    controller.abort()
    expect(() =>{  throwIfAborted(controller.signal) }).toThrow(WebError)
    expect(() =>{  throwIfAborted(undefined) }).not.toThrow()
  })

  it('recognizes abort and timeout rejections by name', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true)
    expect(isAbortError(new Error('other'))).toBe(false)
    expect(isAbortError({ name: 42 })).toBe(false)
    expect(isTimeoutError(new DOMException('timed out', 'TimeoutError'))).toBe(true)
    expect(isTimeoutError(undefined)).toBe(false)
  })
})

describe('dispatchFailure', () => {
  const timeoutSignal = AbortSignal.timeout(60_000)

  it('reports caller cancellation ahead of a concurrent timeout', () => {
    const controller = new AbortController()
    controller.abort()
    const error = dispatchFailure(new Error('boom'), {
      signal: controller.signal,
      timeoutSignal,
      timeoutMs: 10_000,
      endpoint: ENDPOINT,
      secret: SECRET,
    })
    expect(error.code).toBe(WEB_ABORTED)
  })

  it('reports the timeout when the provider’s own signal fired', () => {
    const error = dispatchFailure(new DOMException('timed out', 'TimeoutError'), {
      timeoutSignal,
      timeoutMs: 10_000,
      endpoint: ENDPOINT,
      secret: SECRET,
    })
    expect(error.code).toBe(WEB_PROVIDER_ERROR)
    expect(error.message).toContain('10000ms')
  })

  it('reports everything else as a network failure', () => {
    const cause = new TypeError('fetch failed')
    const error = dispatchFailure(cause, { timeoutSignal, timeoutMs: 10_000, endpoint: ENDPOINT, secret: SECRET })
    expect(error.code).toBe(WEB_PROVIDER_ERROR)
    expect(error.cause).toBe(cause)
  })

  it('treats an AbortError as cancellation even when the caller passed no signal', () => {
    const cause = new DOMException('aborted', 'AbortError')
    const error = dispatchFailure(cause, { timeoutSignal, timeoutMs: 10_000, endpoint: ENDPOINT, secret: SECRET })
    expect(error.code).toBe(WEB_ABORTED)
    expect(error.cause).toBeUndefined()
  })
})

describe('extractErrorCode', () => {
  it('reads the nested Brave code', () => {
    expect(extractErrorCode({ error: { code: 'SUBSCRIPTION_TOKEN_INVALID' } })).toBe('SUBSCRIPTION_TOKEN_INVALID')
  })

  it('falls back to a top-level code', () => {
    expect(extractErrorCode({ code: 'RATE_LIMITED' })).toBe('RATE_LIMITED')
  })

  it('returns undefined when the body carries no code', () => {
    expect(extractErrorCode({ error: { detail: 'x' } })).toBeUndefined()
    expect(extractErrorCode('text')).toBeUndefined()
    expect(extractErrorCode(null)).toBeUndefined()
  })
})

// 実 API は不正な購読トークンに 422 を返すため、状態コードだけでは分類できない。
describe('httpFailure provider-code precedence', () => {
  const base = {
    statusText: 'Unprocessable Entity',
    endpoint: ENDPOINT,
    apiKeyEnv: 'BRAVE_API_KEY',
    secret: SECRET,
    sentSettings: 'count=8, country=JP',
  }

  it('treats a 422 subscription-token code as a key problem', () => {
    const error = httpFailure({
      ...base,
      status: 422,
      providerCode: 'SUBSCRIPTION_TOKEN_INVALID',
      detail: 'The provided subscription token is invalid.',
    })
    expect(error.code).toBe(WEB_PROVIDER_ERROR)
    expect(error.message).toContain('SUBSCRIPTION_TOKEN_INVALID')
    expect(error.message).toContain('API key')
    expect(error.message).not.toContain('correct the query')
  })

  it('treats a validation code as a parameter problem', () => {
    const error = httpFailure({ ...base, status: 422, providerCode: 'VALIDATION' })
    expect(error.message).toContain('correct the query')
  })

  it('lets a rate code outrank a status that would otherwise read as parameters', () => {
    const error = httpFailure({ ...base, status: 400, providerCode: 'RATE_LIMITED' })
    expect(error.message).toContain('rate limit')
    expect(error.message).not.toContain('correct the query')
  })

  it('keeps the 401 key path when no code is present', () => {
    const error = httpFailure({ ...base, status: 401 })
    expect(error.message).toContain('API key')
  })
})
