/**
 * Plugin-entry suite: the config schema's defaults, startup validation, registration
 * through `ctx.effect`, and the credential/environment wiring on the registered
 * provider (DESIGN §3.2, §3.3, §3.6).
 * @module @anago-harness/web-search-brave/test/index.spec
 */
import type { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type { WebSearchProvider } from '@deepseek-ai/dsh-web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, BRAVE_DEFAULT_API_KEY_ENV, Config, inject, name } from '../src/index.ts'
import { bravePayload, braveResult, headerOf, jsonResponse, recordingFetch } from './support.ts'

/** Build one plugin context stub with a registration sink. */
function stubContext(options: { environment?: Record<string, string>; credential?: string } = {}): {
  readonly ctx: Context
  readonly registered: WebSearchProvider[]
} {
  const registered: WebSearchProvider[] = []
  const launchEnvironment = createLaunchEnvironmentSnapshot([
    { source: 'process', values: options.environment ?? {} },
  ])
  const ctx = {
    web: {
      registerSearchProvider: (provider: WebSearchProvider) => {
        registered.push(provider)
        return () => {}
      },
    },
    effect: (execute: () => unknown) => execute(),
    get: (key: string) => {
      if (key === 'launchEnvironment') return launchEnvironment
      if (key === 'credentials' && options.credential !== undefined) {
        return { resolve: async () => ({ value: options.credential, source: 'file' }) }
      }
      return undefined
    },
  } as Context
  return { ctx, registered }
}

/** Register the plugin against a stub context and return the provider it registered. */
function register(config: Record<string, unknown> = {}, options: Parameters<typeof stubContext>[0] = {}): WebSearchProvider {
  const { ctx, registered } = stubContext(options)
  apply(ctx, Config(config))
  const provider = registered[0]
  if (provider === undefined) throw new Error('apply registered no provider')
  return provider
}

describe('plugin metadata', () => {
  it('declares its loader name and required service', () => {
    expect(name).toBe('web-search-brave')
    expect(inject).toEqual(['web'])
  })
})

describe('Config schema', () => {
  it('defaults every field to the documented value', () => {
    const config = Config({})
    expect(config.apiKeyEnv.get()).toBe(BRAVE_DEFAULT_API_KEY_ENV)
    expect(config.baseURL.get()).toBe('https://api.search.brave.com')
    expect(config.country.get()).toBe('JP')
    expect(config.searchLang.get()).toBe('jp')
    expect(config.uiLang.get()).toBe('ja-JP')
    expect(config.safesearch.get()).toBe('moderate')
    expect(config.timeoutMs.get()).toBe(10_000)
    expect(config.maxResults.get()).toBe(8)
    expect(config.apiKey.get()).toBeUndefined()
    expect(config.freshness.get()).toBeUndefined()
  })

  it('rejects a safesearch value Brave does not accept', () => {
    expect(() => Config({ safesearch: 'sometimes' } as never)).toThrow(/expected/u)
  })
})

describe('apply', () => {
  it('rejects an unusable timeoutMs at startup instead of clamping it', () => {
    for (const timeoutMs of [0, -1, Number.NaN, 60_000]) {
      expect(() => register({ timeoutMs })).toThrow(/web-search-brave timeoutMs/u)
    }
  })

  it('registers exactly one provider under the id brave', () => {
    const provider = register()
    expect(provider.id).toBe('brave')
    // キーの有無は検索時に判定するため、未設定でも available() は true（選抜で弾かない）。
    expect(provider.available()).toBe(true)
  })

  it('sees a launch-environment key through available()', () => {
    expect(register({}, { environment: { BRAVE_API_KEY: 'env-key' } }).available()).toBe(true)
  })

  it('is unusable when baseURL cannot parse', () => {
    expect(register({ baseURL: 'api.search.brave.com' }).available()).toBe(false)
  })
})

describe('registered provider wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('searches with the launch-environment key and the default settings', async () => {
    const recorder = recordingFetch(() =>
      jsonResponse(bravePayload([braveResult('https://example.com/a', 'A', 'Snippet')])),
    )
    vi.stubGlobal('fetch', recorder.fetch)
    const provider = register({}, { environment: { BRAVE_API_KEY: 'env-key' } })

    const result = await provider.search({ query: 'deepseek' })

    expect(result.sources).toHaveLength(1)
    const call = recorder.calls[0]
    expect(headerOf(call?.init ?? {}, 'X-Subscription-Token')).toBe('env-key')
    const url = new URL(call?.url ?? '')
    expect(url.pathname).toBe('/res/v1/web/search')
    expect(url.searchParams.get('country')).toBe('JP')
    expect(url.searchParams.get('count')).toBe('8')
  })

  it('prefers a key resolved through the credentials service over one in the environment', async () => {
    const recorder = recordingFetch(() => jsonResponse(bravePayload([])))
    vi.stubGlobal('fetch', recorder.fetch)
    const provider = register({}, { environment: { BRAVE_API_KEY: 'env-key' }, credential: 'credential-key' })

    await provider.search({ query: 'deepseek' })

    expect(headerOf(recorder.calls[0]?.init ?? {}, 'X-Subscription-Token')).toBe('credential-key')
  })

  it('honours config overrides for the sent parameters', async () => {
    const recorder = recordingFetch(() => jsonResponse(bravePayload([])))
    vi.stubGlobal('fetch', recorder.fetch)
    const provider = register(
      { country: '', searchLang: 'en', safesearch: 'strict', freshness: 'pw', maxResults: 5 },
      { environment: { BRAVE_API_KEY: 'env-key' } },
    )

    await provider.search({ query: 'deepseek', maxResults: 20 })

    const url = new URL(recorder.calls[0]?.url ?? '')
    expect(url.searchParams.has('country')).toBe(false)
    expect(url.searchParams.get('search_lang')).toBe('en')
    expect(url.searchParams.get('safesearch')).toBe('strict')
    expect(url.searchParams.get('freshness')).toBe('pw')
    expect(url.searchParams.get('count')).toBe('5')
  })

  it('reports a missing key with the credential reference name only', async () => {
    const failure = await register().search({ query: 'deepseek' }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    expect((failure as Error).message).toContain('BRAVE_API_KEY')
  })

  it('sends a literal config key ahead of every other source', async () => {
    const recorder = recordingFetch(() => jsonResponse(bravePayload([])))
    vi.stubGlobal('fetch', recorder.fetch)
    const provider = register({ apiKey: 'literal-key' }, { environment: { BRAVE_API_KEY: 'env-key' } })

    await provider.search({ query: 'deepseek' })

    expect(headerOf(recorder.calls[0]?.init ?? {}, 'X-Subscription-Token')).toBe('literal-key')
  })
})
