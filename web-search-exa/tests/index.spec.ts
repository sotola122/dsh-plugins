/**
 * Plugin and provider suite: config defaults, registration and disposal, the credential
 * resolution order, request mapping through the carried `ExaSearchProvider`, cancellation,
 * and the no-key `available()` contract.
 * @module @anago-harness/web-search-exa/test/index.spec
 */
import type { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type { WebSearchProvider } from '@deepseek-ai/dsh-web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'
import { EXA_DEFAULT_API_KEY_ENV, EXA_QUERY_MAX_CHARS } from '../src/provider.ts'

const SECRET = 'exa-secret-value'
const CREDENTIAL = 'credential-key'
const ENV_KEY = 'environment-key'

interface CredentialState {
  resolveCalls: number
  refs: string[]
}

interface StubOptions {
  readonly environment?: Record<string, string> | undefined
  readonly credential?: string | (() => Promise<string | undefined>) | undefined
  readonly withCredentials?: boolean | undefined
}

interface Stub {
  readonly ctx: Context
  readonly registered: WebSearchProvider[]
  readonly credentials: CredentialState
  unload(): void
}

/**
 * Build a plugin context with a registration sink, an optional credentials service, and a
 * launch-environment snapshot. Only the seams this plugin reads are implemented.
 */
function stubContext(options: StubOptions = {}): Stub {
  const registered: WebSearchProvider[] = []
  const credentials: CredentialState = { resolveCalls: 0, refs: [] }
  const launchEnvironment = createLaunchEnvironmentSnapshot([
    { source: 'process', values: options.environment ?? {} },
  ])
  let unload = (): void => {}
  const ctx = {
    web: {
      registerSearchProvider: (provider: WebSearchProvider) => {
        registered.push(provider)
        return () => {
          const index = registered.indexOf(provider)
          if (index !== -1) registered.splice(index, 1)
        }
      },
    },
    effect: (execute: () => unknown) => {
      const disposer = execute()
      unload = () => {
        if (typeof disposer === 'function') (disposer as () => void)()
      }
      return unload
    },
    get: (key: string) => {
      if (key === 'launchEnvironment') return launchEnvironment
      if (key === 'credentials' && options.withCredentials !== false) {
        return {
          resolve: async (ref: unknown) => {
            credentials.resolveCalls += 1
            credentials.refs.push(String(ref))
            if (typeof options.credential === 'function') {
              const value = await options.credential()
              return value === undefined ? undefined : { value, source: 'file' }
            }
            if (options.credential === undefined) return undefined
            return { value: options.credential, source: 'file' }
          },
        }
      }
      return undefined
    },
  } as Context
  return { ctx, registered, credentials, unload: () =>{  unload() } }
}

/** Register the plugin and return the provider it registered. */
function register(
  config: Record<string, unknown> = {},
  options: StubOptions = {},
): Stub & { readonly provider: WebSearchProvider } {
  const stub = stubContext(options)
  apply(stub.ctx, Config(config))
  const provider = stub.registered[0]
  if (provider === undefined) throw new Error('apply registered no provider')
  return { ...stub, provider }
}

interface FetchCall {
  readonly url: string
  readonly init: RequestInit
}

/** Replace `globalThis.fetch` (the carried class uses it directly) and record its calls. */
function stubFetch(
  respond: (call: FetchCall) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> & { readonly calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init: init ?? {} }
    calls.push(call)
    return await respond(call)
  })
  vi.stubGlobal('fetch', mock)
  return Object.assign(mock, { calls })
}

function jsonResponse(body: unknown, status = 200, statusText = ''): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  })
}

function headerOf(init: RequestInit, name: string): string | undefined {
  return new Headers(init.headers).get(name) ?? undefined
}

/** The JSON body the provider sent; a non-string body is a defect here, not `[object Object]`. */
function requestBody(init: RequestInit): unknown {
  const body = init.body
  if (typeof body !== 'string') throw new Error('the provider sent a non-string request body')
  return JSON.parse(body)
}

function source(url: string, snippet = 'snippet'): unknown {
  return { url, highlights: [snippet] }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('plugin metadata', () => {
  it('declares its loader name and required service', () => {
    expect(name).toBe('web-search-exa')
    expect(inject).toEqual(['web'])
  })
})

describe('Config schema', () => {
  it('defaults every field to the documented value', () => {
    const config = Config({})
    expect(config.apiKey.get()).toBeUndefined()
    expect(config.apiKeyEnv.get()).toBe(EXA_DEFAULT_API_KEY_ENV)
    expect(config.baseURL.get()).toBe('https://api.exa.ai')
    expect(config.searchType.get()).toBe('auto')
    expect(config.highlightsPerResult.get()).toBe(1)
  })

  it('rejects an unsupported search type and non-positive counts', () => {
    expect(() => Config({ searchType: 'semantic' } as never)).toThrow(/expected/u)
    expect(() => Config({ highlightsPerResult: 0 })).toThrow(/>= 1/u)
    expect(() => Config({ highlightsPerResult: 1.5 })).toThrow(/multiple of 1/u)
  })
})

describe('registration', () => {
  it('registers one provider under the id exa and removes it when the effect is disposed', () => {
    const stub = register()
    expect(stub.registered).toHaveLength(1)
    expect(stub.provider.id).toBe('exa')
    stub.unload()
    expect(stub.registered).toHaveLength(0)
  })
})

describe('available', () => {
  it('is true with no key at all, so a credentials-only key stays selectable', () => {
    const stub = register({}, { withCredentials: true })
    expect(stub.provider.available()).toBe(true)
    expect(stub.credentials.resolveCalls).toBe(0)
  })

  it('is true when a launch-environment key exists and false when baseURL cannot parse', () => {
    expect(register({}, { environment: { EXA_API_KEY: ENV_KEY } }).provider.available()).toBe(true)
    expect(register({ baseURL: 'api.exa.ai' }).provider.available()).toBe(false)
  })
})

describe('credential resolution', () => {
  it('prefers a literal config key over the credentials service and the environment', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ results: [] }))
    const stub = register(
      { apiKey: SECRET },
      { credential: CREDENTIAL, environment: { EXA_API_KEY: ENV_KEY } },
    )
    await stub.provider.search({ query: 'q' })
    expect(headerOf(fetchMock.calls[0]!.init, 'authorization')).toBe(`Bearer ${SECRET}`)
    expect(stub.credentials.resolveCalls).toBe(0)
  })

  it('resolves the configured reference through the credentials service', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ results: [] }))
    const stub = register(
      { apiKeyEnv: 'MY_EXA_KEY' },
      { credential: CREDENTIAL, environment: { MY_EXA_KEY: ENV_KEY } },
    )
    await stub.provider.search({ query: 'q' })
    expect(headerOf(fetchMock.calls[0]!.init, 'authorization')).toBe(`Bearer ${CREDENTIAL}`)
    expect(stub.credentials.refs).toEqual(['MY_EXA_KEY'])
  })

  it('falls back to the launch environment when the credentials service has nothing', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ results: [] }))
    const stub = register(
      { apiKeyEnv: 'MY_EXA_KEY' },
      { environment: { MY_EXA_KEY: ENV_KEY } },
    )
    await stub.provider.search({ query: 'q' })
    expect(headerOf(fetchMock.calls[0]!.init, 'authorization')).toBe(`Bearer ${ENV_KEY}`)
  })

  it('falls back to the launch environment when the credentials service is not installed', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ results: [] }))
    const stub = register(
      { apiKeyEnv: 'MY_EXA_KEY' },
      { withCredentials: false, environment: { MY_EXA_KEY: ENV_KEY } },
    )
    await stub.provider.search({ query: 'q' })
    expect(headerOf(fetchMock.calls[0]!.init, 'authorization')).toBe(`Bearer ${ENV_KEY}`)
  })

  it('reports a missing key with the reference name only and never leaks a value', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ results: [] }))
    const stub = register({ apiKey: '', apiKeyEnv: 'EXA_MISSING_KEY' })
    const failure = await stub.provider.search({ query: 'q' }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    expect((failure as Error).message).toContain('EXA_MISSING_KEY')
    expect((failure as Error).message).toContain('credentials service')
    expect(fetchMock.calls).toHaveLength(0)
  })

  it('maps a credentials-service failure to WEB_PROVIDER_ERROR with cause', async () => {
    const cause = new Error('credential store offline')
    const stub = register(
      {},
      {
        credential: async () => {
          throw cause
        },
      },
    )
    const failure = await stub.provider.search({ query: 'q' }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'WEB_PROVIDER_ERROR', cause })
  })
})

describe('request mapping', () => {
  it('sends the query, mode, highlights and request bound, then maps the upstream result', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({
        results: [
          { url: 'https://a.test', title: 'A', publishedDate: '2026-01-01', highlights: ['one', 'two'] },
          { url: 'https://b.test', highlights: ['  spaced  '] },
          { url: 'https://c.test', highlights: ['   '] },
        ],
      }),
    )
    const stub = register(
      { searchType: 'neural', highlightsPerResult: 3 },
      { credential: CREDENTIAL },
    )
    const result = await stub.provider.search({ query: 'hello', maxResults: 5 })

    expect(fetchMock.calls).toHaveLength(1)
    const call = fetchMock.calls[0]!
    expect(call.url).toBe('https://api.exa.ai/search')
    expect(call.init.method).toBe('POST')
    expect(call.init.redirect).toBe('error')
    expect(headerOf(call.init, 'authorization')).toBe(`Bearer ${CREDENTIAL}`)
    expect(requestBody(call.init)).toEqual({
      query: 'hello',
      type: 'neural',
      contents: { highlights: { highlightsPerUrl: 3 } },
      numResults: 5,
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'one', publishedAt: '2026-01-01' },
        { url: 'https://b.test', snippet: '  spaced  ' },
      ],
      truncated: false,
    })
  })

  it('sends no result bound and leaves the default to Exa when the request carries none', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ results: [] }))
    const stub = register({}, { credential: CREDENTIAL })
    await stub.provider.search({ query: 'q' })
    expect(requestBody(fetchMock.calls[0]!.init)).not.toHaveProperty('numResults')
  })

  it('keeps concurrent searches independent by resolving a key for each one', async () => {
    let resolved = 0
    const keys = ['key-a', 'key-b']
    const fetchMock = stubFetch(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      return jsonResponse({ results: [source('https://a.test')] })
    })
    const stub = register(
      {},
      {
        credential: async () => {
          const key = keys[resolved] ?? `key-${resolved}`
          resolved += 1
          return key
        },
      },
    )
    await Promise.all([
      stub.provider.search({ query: 'first' }),
      stub.provider.search({ query: 'second' }),
    ])
    const authorization = fetchMock.calls.map(call => headerOf(call.init, 'authorization')).sort()
    expect(authorization).toEqual(['Bearer key-a', 'Bearer key-b'])
  })
})

describe('upstream failure sanitization', () => {
  it('redacts a key echoed in a 401 JSON body', async () => {
    stubFetch(() => jsonResponse({ error: `invalid key ${SECRET}` }, 401, 'Unauthorized'))
    const stub = register({ apiKey: SECRET })
    const failure = await stub.provider.search({ query: 'q' }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    const message = (failure as Error).message
    expect(message).toContain('Exa search')
    expect(message).toContain('EXA_API_KEY')
    expect(message).toContain('[REDACTED]')
    expect(message).not.toContain(SECRET)
  })

  it('redacts a base64 encoding of the key echoed by an intermediary', async () => {
    const encoded = Buffer.from(SECRET, 'utf8').toString('base64')
    stubFetch(() => jsonResponse({ message: `proxy saw ${encoded}` }, 500, 'Server Error'))
    const stub = register({ apiKey: SECRET })
    const failure = await stub.provider.search({ query: 'q' }).catch((error: unknown) => error)
    expect((failure as Error).message).toContain('[REDACTED]')
    expect((failure as Error).message).not.toContain(encoded)
  })

  it('redacts a key quoted by a transport exception', async () => {
    stubFetch(() => Promise.reject(new TypeError(`fetch failed for token ${SECRET}`)))
    const stub = register({ apiKey: SECRET })
    const failure = await stub.provider.search({ query: 'q' }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    const message = (failure as Error).message
    expect(message).toContain('fetch failed')
    expect(message).toContain('[REDACTED]')
    expect(message).not.toContain(SECRET)
  })

  it('bounds an HTML response body larger than 2000 bytes', async () => {
    stubFetch(
      () =>
        new Response(`<html>${'z'.repeat(3_000)}</html>`, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    )
    const stub = register({ apiKey: SECRET })
    const failure = await stub.provider.search({ query: 'q' }).catch((error: unknown) => error)
    const message = (failure as Error).message
    expect(message).toContain('Exa search')
    expect(message).not.toContain('z'.repeat(300))
    expect(message.length).toBeLessThan(400)
  })

  it('keeps the HTTP classification for a 429 without a JSON detail', async () => {
    stubFetch(() => new Response('slow down', { status: 429, statusText: 'Too Many Requests' }))
    const stub = register({ apiKey: SECRET })
    const failure = await stub.provider.search({ query: 'q' }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect((failure as Error).message).toContain('HTTP 429')
  })

  it('keeps the HTTP classification for a 5xx without a JSON detail', async () => {
    stubFetch(() => new Response('gateway down', { status: 503, statusText: 'Service Unavailable' }))
    const stub = register({ apiKey: SECRET })
    const failure = await stub.provider.search({ query: 'q' }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect((failure as Error).message).toContain('HTTP 503')
  })
})

describe('cancellation and query bounds', () => {
  it('does not dispatch when the caller already aborted', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ results: [] }))
    const stub = register({}, { credential: CREDENTIAL })
    const controller = new AbortController()
    controller.abort()
    const failure = await stub.provider.search({ query: 'q' }, controller.signal).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'WEB_ABORTED' })
    expect(fetchMock.calls).toHaveLength(0)
  })

  it('maps an upstream AbortError to WEB_ABORTED', async () => {
    stubFetch(() => Promise.reject(new DOMException('aborted', 'AbortError')))
    const stub = register({}, { credential: CREDENTIAL })
    const failure = await stub.provider.search({ query: 'q' }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('rejects an over-long query before resolving a key or dispatching', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ results: [] }))
    const stub = register()
    const query = 'x'.repeat(EXA_QUERY_MAX_CHARS + 1)
    const failure = await stub.provider.search({ query }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect((failure as Error).message).toContain(String(EXA_QUERY_MAX_CHARS))
    expect((failure as Error).message).not.toContain(query)
    expect(fetchMock.calls).toHaveLength(0)
    expect(stub.credentials.resolveCalls).toBe(0)
  })

  it('rejects a blank query before resolving a key', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ results: [] }))
    const stub = register()
    const failure = await stub.provider.search({ query: '   ' }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(fetchMock.calls).toHaveLength(0)
    expect(stub.credentials.resolveCalls).toBe(0)
  })
})
