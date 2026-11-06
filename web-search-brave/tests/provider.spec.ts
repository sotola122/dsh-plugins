/**
 * Provider suite (DESIGN §3.3–§3.7 / §6.2): `available()` without I/O, the credential
 * resolution order, the dispatched request, every error class, and the composed
 * cancellation signal. Every case runs against a fake `fetch`; no socket is opened.
 * @module @anago-harness/web-search-brave/test/provider.spec
 */
import { WebError } from '@deepseek-ai/dsh-web'
import { describe, expect, it } from 'vitest'
import { BraveSearchProvider, MAX_TIMEOUT_MS } from '../src/provider.ts'
import {
  bravePayload,
  braveResult,
  hangingFetch,
  headerOf,
  jsonResponse,
  providerOptions,
  providerWith,
  recordingFetch,
  textResponse,
} from './support.ts'

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
const SECRET = 'brave-secret-value'

/** Capture a rejection for inspection. */
async function rejectionOf(operation: Promise<unknown>): Promise<WebError> {
  try {
    await operation
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(WebError)
    return error as WebError
  }
  throw new Error('expected the operation to reject')
}

describe('available', () => {
  it('needs no network call', () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(bravePayload([])))
    const provider = providerWith(providerOptions({ apiKey: SECRET }), fetch)
    expect(provider.available()).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('is true regardless of which credential source holds the key', () => {
    // credentials サービスは非同期なので available() からは見えない。選抜で弾かれない
    // よう、キーの有無は検索時に判定する（参考実装と同じ）。
    expect(providerWith(providerOptions({ apiKey: SECRET }), recordingFetch(() => jsonResponse({})).fetch).available())
      .toBe(true)
    expect(
      providerWith(providerOptions({ readEnvironment: () => SECRET }), recordingFetch(() => jsonResponse({})).fetch)
        .available(),
    ).toBe(true)
    expect(providerWith(providerOptions(), recordingFetch(() => jsonResponse({})).fetch).available()).toBe(true)
  })

  it('is true when only the credentials service could hold the key, so selection is not refused', () => {
    const provider = providerWith(
      providerOptions({ resolveCredential: async () => SECRET }),
      recordingFetch(() => jsonResponse({})).fetch,
    )
    expect(provider.available()).toBe(true)
  })

  it('is false when baseURL does not parse', () => {
    const fetch = recordingFetch(() => jsonResponse({})).fetch
    expect(providerWith(providerOptions({ apiKey: SECRET, baseURL: 'api.search.brave.com' }), fetch).available()).toBe(
      false,
    )
  })
})

describe('credential resolution', () => {
  it('prefers the literal config key over every other source', async () => {
    let resolved = 0
    const { fetch, calls } = recordingFetch(() => jsonResponse(bravePayload([])))
    const provider = providerWith(
      providerOptions({
        apiKey: SECRET,
        resolveCredential: async () => {
          resolved += 1
          return 'credential-value'
        },
        readEnvironment: () => 'environment-value',
      }),
      fetch,
    )
    await provider.search({ query: 'q' })
    expect(headerOf(calls[0]?.init ?? {}, 'X-Subscription-Token')).toBe(SECRET)
    expect(resolved).toBe(0)
  })

  it('resolves the credential reference when no literal key is set', async () => {
    const refs: string[] = []
    const { fetch, calls } = recordingFetch(() => jsonResponse(bravePayload([])))
    const provider = providerWith(
      providerOptions({
        apiKeyEnv: 'MY_BRAVE_KEY',
        resolveCredential: async () => {
          refs.push('called')
          return 'credential-value'
        },
        readEnvironment: () => 'environment-value',
      }),
      fetch,
    )
    await provider.search({ query: 'q' })
    expect(refs).toHaveLength(1)
    expect(headerOf(calls[0]?.init ?? {}, 'X-Subscription-Token')).toBe('credential-value')
  })

  it('falls back to the launch environment when the credentials service has nothing', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(bravePayload([])))
    const provider = providerWith(
      providerOptions({ resolveCredential: async () => undefined, readEnvironment: () => 'environment-value' }),
      fetch,
    )
    await provider.search({ query: 'q' })
    expect(headerOf(calls[0]?.init ?? {}, 'X-Subscription-Token')).toBe('environment-value')
  })

  it('treats an empty stored value as absent', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(bravePayload([])))
    const provider = providerWith(
      providerOptions({ resolveCredential: async () => '', readEnvironment: () => 'environment-value' }),
      fetch,
    )
    await provider.search({ query: 'q' })
    expect(headerOf(calls[0]?.init ?? {}, 'X-Subscription-Token')).toBe('environment-value')
  })

  it('reports WEB_PROVIDER_CREDENTIAL_MISSING without leaking a value when no source has one', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(bravePayload([])))
    const provider = providerWith(providerOptions({ apiKey: '', apiKeyEnv: 'BRAVE_API_KEY' }), fetch)
    const error = await rejectionOf(provider.search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_CREDENTIAL_MISSING')
    expect(error.message).toContain('BRAVE_API_KEY')
    expect(error.message).toContain('credentials service')
    expect(calls).toHaveLength(0)
  })

  it('maps a credentials-service failure to WEB_PROVIDER_ERROR with cause', async () => {
    const cause = new Error('credential store offline')
    const { fetch } = recordingFetch(() => jsonResponse(bravePayload([])))
    const provider = providerWith(
      providerOptions({
        resolveCredential: async () => {
          throw cause
        },
      }),
      fetch,
    )
    const error = await rejectionOf(provider.search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.cause).toBe(cause)
  })

  it('refuses a key that no HTTP header can carry, before dispatch and without naming it', async () => {
    // 改行・NUL は fetch の TypeError が値を引用し、U+200B / U+FEFF / スマートクオートは
    // ByteString 変換で拒まれる。制御文字だけを拒む従来の検査では、これらが fetch まで
    // 届く経路が残っていた。
    for (const malformed of ['pasted-key\n', 'pasted\u200Bkey', 'pasted\uFEFFkey', 'pasted\u201Ckey']) {
      const { fetch, calls } = recordingFetch(() => jsonResponse(bravePayload([])))
      const provider = providerWith(providerOptions({ apiKey: malformed }), fetch)
      const error = await rejectionOf(provider.search({ query: 'q' }))
      expect(error.code).toBe('WEB_PROVIDER_ERROR')
      expect(error.message).toContain('line break')
      expect(error.message).not.toContain('pasted-key')
      expect(error.message).not.toContain('pasted')
      expect(calls).toHaveLength(0)
    }
  })

  it('keeps the literal key out of every failure message', async () => {
    const cases: Array<() => Promise<unknown>> = []
    const unauthorized = providerWith(
      providerOptions({ apiKey: SECRET }),
      recordingFetch(() => textResponse('denied', 401, 'Unauthorized')).fetch,
    )
    cases.push(() => unauthorized.search({ query: 'q' }))
    const limited = providerWith(
      providerOptions({ apiKey: SECRET }),
      recordingFetch(() => jsonResponse({ error: { detail: 'slow down' } }, 429, 'Too Many Requests')).fetch,
    )
    cases.push(() => limited.search({ query: 'q' }))
    const timedOut = providerWith(providerOptions({ apiKey: SECRET, timeoutMs: 5 }), hangingFetch().fetch)
    cases.push(() => timedOut.search({ query: 'q' }))
    const broken = providerWith(
      providerOptions({ apiKey: SECRET }),
      recordingFetch(() => textResponse('not json', 200)).fetch,
    )
    cases.push(() => broken.search({ query: 'q' }))
    for (const run of cases) {
      const error = await rejectionOf(run())
      expect(error.message).not.toContain(SECRET)
      expect(error.message).not.toContain('X-Subscription-Token')
    }
  })
})

describe('request dispatch', () => {
  it('sends one authenticated GET to the Web Search endpoint', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(bravePayload([braveResult('https://example.com/a', 'A', 'Snippet')])),
    )
    const provider = providerWith(providerOptions({ apiKey: SECRET }), fetch)
    const result = await provider.search({ query: 'deepseek harness', maxResults: 3 })

    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.init.method).toBe('GET')
    expect(headerOf(call?.init ?? {}, 'Accept')).toBe('application/json')
    expect(headerOf(call?.init ?? {}, 'X-Subscription-Token')).toBe(SECRET)
    expect(call?.init.signal).toBeInstanceOf(AbortSignal)

    const url = new URL(call?.url ?? '')
    expect(url.origin + url.pathname).toBe(ENDPOINT)
    expect(url.searchParams.get('q')).toBe('deepseek harness')
    expect(url.searchParams.get('count')).toBe('3')
    expect(url.searchParams.get('result_filter')).toBe('web')
    expect(url.searchParams.has('offset')).toBe(false)

    expect(result.sources).toEqual([{ url: 'https://example.com/a', title: 'A', snippet: 'Snippet' }])
    expect(result.truncated).toBe(false)
  })

  it('rejects an over-long query before dispatch', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(bravePayload([])))
    const provider = providerWith(providerOptions({ apiKey: SECRET }), fetch)
    const error = await rejectionOf(provider.search({ query: 'x'.repeat(401) }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(calls).toHaveLength(0)
  })

  it('reports an over-long query before a missing key, because the query is actionable on its own', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(bravePayload([])))
    const provider = providerWith(providerOptions(), fetch)
    const error = await rejectionOf(provider.search({ query: 'x'.repeat(401) }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('400 characters')
    expect(error.message).not.toContain('BRAVE_API_KEY')
    expect(calls).toHaveLength(0)
  })

  it('returns an empty successful result when Brave has no matches', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(bravePayload([])))
    const provider = providerWith(providerOptions({ apiKey: SECRET }), fetch)
    await expect(provider.search({ query: 'q' })).resolves.toEqual({ sources: [], truncated: false })
  })

  it('reports a full page as not truncated, because the seam owns truncation', async () => {
    const results = [braveResult('https://example.com/a'), braveResult('https://example.com/b')]
    const { fetch } = recordingFetch(() => jsonResponse(bravePayload(results)))
    const provider = providerWith(providerOptions({ apiKey: SECRET, maxResults: 2 }), fetch)
    const result = await provider.search({ query: 'q', maxResults: 2 })
    expect(result.sources).toHaveLength(2)
    expect(result.truncated).toBe(false)
  })
})

describe('HTTP classification', () => {
  const statuses: ReadonlyArray<readonly [number, string]> = [
    [401, 'key'],
    [403, 'key'],
    [400, 'parameters'],
    [422, 'parameters'],
    [429, 'rate limit'],
    [500, 'provider side'],
    [503, 'provider side'],
    [418, 'unexpected status'],
  ]
  for (const [status, marker] of statuses) {
    it(`maps HTTP ${status} to WEB_PROVIDER_ERROR naming the ${marker}`, async () => {
      const { fetch } = recordingFetch(() => jsonResponse({ error: { detail: 'provider detail' } }, status, 'Status'))
      const provider = providerWith(providerOptions({ apiKey: SECRET }), fetch)
      const error = await rejectionOf(provider.search({ query: 'q' }))
      expect(error.code).toBe('WEB_PROVIDER_ERROR')
      expect(error.message).toContain(`HTTP ${status}`)
      expect(error.message).toContain(marker)
      expect(error.message).toContain('provider detail')
      expect(error.message).toContain(ENDPOINT)
    })
  }

  it('keeps the settings that were sent in a 422 message', async () => {
    const { fetch } = recordingFetch(() => textResponse('bad country', 422, 'Unprocessable Entity'))
    const provider = providerWith(providerOptions({ apiKey: SECRET, country: 'ZZ' }), fetch)
    const error = await rejectionOf(provider.search({ query: 'q' }))
    expect(error.message).toContain('country=ZZ')
    expect(error.message).toContain('count=8')
    expect(error.message).toContain('bad country')
  })

  // 実 API の挙動（2026-10-18 実測）: 不正な購読トークンは 422 + SUBSCRIPTION_TOKEN_INVALID。
  it('routes a 422 subscription-token code to the key, not the parameters', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(
        {
          error: {
            code: 'SUBSCRIPTION_TOKEN_INVALID',
            detail: 'The provided subscription token is invalid.',
            status: 422,
          },
        },
        422,
        'Unprocessable Entity',
      ),
    )
    const provider = providerWith(providerOptions({ apiKey: SECRET }), fetch)
    const error = await rejectionOf(provider.search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('SUBSCRIPTION_TOKEN_INVALID')
    expect(error.message).toContain('API key')
    expect(error.message).toContain('The provided subscription token is invalid.')
    expect(error.message).not.toContain('correct the query')
    expect(error.message).not.toContain(SECRET)
  })

  it('maps a transport failure with cause', async () => {
    const cause = new TypeError('fetch failed')
    const { fetch } = recordingFetch(() => {
      throw cause
    })
    const provider = providerWith(providerOptions({ apiKey: SECRET }), fetch)
    const error = await rejectionOf(provider.search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.cause).toBe(cause)
    expect(error.message).toContain(ENDPOINT)
  })

  it('maps a body-read failure as a transport failure', async () => {
    const cause = new TypeError('body stream lost')
    const response = jsonResponse(bravePayload([]))
    Object.defineProperty(response, 'text', {
      value: async () => {
        throw cause
      },
    })
    const provider = providerWith(providerOptions({ apiKey: SECRET }), recordingFetch(() => response).fetch)
    const error = await rejectionOf(provider.search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.cause).toBe(cause)
  })

  it('maps a non-JSON success body without dumping it', async () => {
    const { fetch } = recordingFetch(() => textResponse(`<html>${'x'.repeat(5_000)}</html>`, 200))
    const provider = providerWith(providerOptions({ apiKey: SECRET }), fetch)
    const error = await rejectionOf(provider.search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('not JSON')
    expect(error.message).not.toContain('x'.repeat(300))
  })
})

describe('cancellation and timeout', () => {
  it('reports the provider timeout with timeoutMs and the endpoint', async () => {
    const provider = providerWith(providerOptions({ apiKey: SECRET, timeoutMs: 10 }), hangingFetch().fetch)
    const error = await rejectionOf(provider.search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('10ms')
    expect(error.message).toContain(ENDPOINT)
  })

  it('revalidates timeoutMs for every search, so a volatile change cannot leak a RangeError', async () => {
    let options = providerOptions({ apiKey: SECRET, timeoutMs: 1_000 })
    const { fetch, calls } = recordingFetch(() => jsonResponse(bravePayload([])))
    const provider = new BraveSearchProvider({ options: () => options, fetch })
    await provider.search({ query: 'q' })

    for (const timeoutMs of [0, -1, Number.NaN, MAX_TIMEOUT_MS + 1]) {
      options = providerOptions({ apiKey: SECRET, timeoutMs })
      const error = await rejectionOf(provider.search({ query: 'q' }))
      expect(error.code).toBe('WEB_PROVIDER_ERROR')
      expect(error.message).toContain('timeoutMs')
      expect(error.message).toContain(`greater than 0 and at most ${MAX_TIMEOUT_MS}ms`)
      expect(error.message).not.toContain('RangeError')
    }
    expect(calls).toHaveLength(1)
  })

  it('reports caller cancellation as WEB_ABORTED', async () => {
    const hanging = hangingFetch()
    const provider = providerWith(providerOptions({ apiKey: SECRET, timeoutMs: 10_000 }), hanging.fetch)
    const controller = new AbortController()
    const pending = provider.search({ query: 'q' }, controller.signal)
    await hanging.started
    controller.abort()
    const error = await rejectionOf(pending)
    expect(error.code).toBe('WEB_ABORTED')
  })

  it('prefers the caller’s cancellation over a concurrent timeout', async () => {
    const hanging = hangingFetch()
    const provider = providerWith(providerOptions({ apiKey: SECRET, timeoutMs: 10_000 }), hanging.fetch)
    const controller = new AbortController()
    const pending = provider.search({ query: 'q' }, controller.signal)
    await hanging.started
    controller.abort()
    const error = await rejectionOf(pending)
    expect(error.code).toBe('WEB_ABORTED')
    expect(error.message).not.toContain('timed out')
  })

  it('does not dispatch when the caller already aborted', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(bravePayload([])))
    const provider = providerWith(providerOptions({ apiKey: SECRET }), fetch)
    const controller = new AbortController()
    controller.abort()
    const error = await rejectionOf(provider.search({ query: 'q' }, controller.signal))
    expect(error.code).toBe('WEB_ABORTED')
    expect(calls).toHaveLength(0)
  })

  it('composes the caller’s signal and the provider timeout for fetch', async () => {
    const hanging = hangingFetch()
    const provider = providerWith(providerOptions({ apiKey: SECRET, timeoutMs: 10_000 }), hanging.fetch)
    const controller = new AbortController()
    const pending = provider.search({ query: 'q' }, controller.signal)
    await hanging.started
    const composed = hanging.signals[0]
    expect(composed).toBeInstanceOf(AbortSignal)
    expect(composed).not.toBe(controller.signal)
    controller.abort()
    await rejectionOf(pending)
    expect(composed?.aborted).toBe(true)
  })
})

describe('message sanitization', () => {
  it('redacts a key echoed in a 401 JSON body', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: { detail: `invalid token ${SECRET}` } }, 401, 'Unauthorized'),
    )
    const provider = providerWith(providerOptions({ apiKey: SECRET }), fetch)
    const error = await rejectionOf(provider.search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('[REDACTED]')
    expect(error.message).not.toContain(SECRET)
    expect(error.message).toContain('HTTP 401')
    expect(error.message).toContain('API key')
  })

  it('redacts a base64 encoding of the key echoed by an intermediary', async () => {
    const encoded = Buffer.from(SECRET, 'utf8').toString('base64')
    const { fetch } = recordingFetch(() => textResponse(`proxy echo: ${encoded}`, 500, 'Server Error'))
    const provider = providerWith(providerOptions({ apiKey: SECRET }), fetch)
    const error = await rejectionOf(provider.search({ query: 'q' }))
    expect(error.message).toContain('[REDACTED]')
    expect(error.message).not.toContain(encoded)
    expect(error.message).toContain('provider side')
  })

  it('redacts a key quoted by a transport exception', async () => {
    const cause = new TypeError(`connect failed for token ${SECRET}`)
    const { fetch } = recordingFetch(() => {
      throw cause
    })
    const provider = providerWith(providerOptions({ apiKey: SECRET }), fetch)
    const error = await rejectionOf(provider.search({ query: 'q' }))
    expect(error.message).toContain('[REDACTED]')
    expect(error.message).not.toContain(SECRET)
    expect(error.message).toContain('connect failed')
    expect(error.cause).toBe(cause)
  })

  it('bounds an HTML error body larger than 2000 bytes', async () => {
    const { fetch } = recordingFetch(() => textResponse(`<html>${'x'.repeat(3_000)}</html>`, 502, 'Bad Gateway'))
    const provider = providerWith(providerOptions({ apiKey: SECRET }), fetch)
    const error = await rejectionOf(provider.search({ query: 'q' }))
    expect(error.message).toContain('HTTP 502')
    expect(error.message).not.toContain('x'.repeat(300))
    expect(error.message.length).toBeLessThan(400)
  })

  it('bounds and redacts a non-JSON success body', async () => {
    const { fetch } = recordingFetch(() => textResponse(`${SECRET}${'y'.repeat(3_000)}`, 200))
    const provider = providerWith(providerOptions({ apiKey: SECRET }), fetch)
    const error = await rejectionOf(provider.search({ query: 'q' }))
    expect(error.message).toContain('not JSON')
    expect(error.message).toContain('[REDACTED]')
    expect(error.message).not.toContain(SECRET)
    expect(error.message.length).toBeLessThan(400)
  })

  it('keeps the rate-limit classification for a normal 429', async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ error: { detail: 'slow down' } }, 429, 'Too Many Requests'))
    const provider = providerWith(providerOptions({ apiKey: SECRET }), fetch)
    const error = await rejectionOf(provider.search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('rate limit')
    expect(error.message).toContain('HTTP 429')
    expect(error.message).toContain('slow down')
    expect(error.message).toContain('never retries automatically')
  })

  it('keeps the provider-side classification for a normal 5xx', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ error: { message: 'upstream unavailable' } }, 503, 'Service Unavailable'),
    )
    const provider = providerWith(providerOptions({ apiKey: SECRET }), fetch)
    const error = await rejectionOf(provider.search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('provider side')
    expect(error.message).toContain('HTTP 503')
    expect(error.message).toContain('upstream unavailable')
    expect(error.message).toContain('Retry later')
  })
})

describe('provider identity', () => {
  it('registers under the stable id brave', () => {
    expect(new BraveSearchProvider({ options: providerOptions }).id).toBe('brave')
  })
})
