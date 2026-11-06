/**
 * Wrapper suite: the credential-resolving provider's mapping of carried-provider
 * failures. The carried adapter always throws `WebError` instances, so a
 * stubbed adapter covers the wrapper's documented tolerance for any thrown
 * value: plain values, error-like objects, empty messages, and cancellation.
 * @module @anago-harness/web-search-exa/test/provider.spec
 */
import { WebError } from '@deepseek-ai/dsh-web'
import { describe, expect, it, vi } from 'vitest'
import { ExaCredentialSearchProvider, type ExaCredentialProviderOptions } from '../src/provider.ts'

/** The stubbed upstream search, replaced per test. */
const upstream = vi.hoisted(() => ({ search: vi.fn() }))

vi.mock('../src/exa.ts', () => ({
  EXA_PROVIDER_ID: 'exa',
  EXA_DEFAULT_BASE_URL: 'https://api.exa.ai',
  EXA_DEFAULT_SEARCH_TYPE: 'auto',
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT: 3,
  ExaSearchProvider: class {
    search(...args: unknown[]): unknown {
      return upstream.search(...args)
    }
  },
}))

/** One operation's options with a literal key, so no async credential read runs. */
function options(overrides: Partial<ExaCredentialProviderOptions> = {}): ExaCredentialProviderOptions {
  return {
    apiKey: 'exa-secret-value',
    apiKeyEnv: 'EXA_API_KEY',
    resolveCredential: async () => undefined,
    readEnvironment: () => undefined,
    baseURL: 'https://api.exa.ai',
    searchType: 'auto',
    highlightsPerResult: 3,
    ...overrides,
  }
}

/** Run one search through a provider over the given options. */
function search(overrides: Partial<ExaCredentialProviderOptions> = {}) {
  return new ExaCredentialSearchProvider({ options: () => options(overrides) })
    .search({ query: 'deepseek' })
}

/** Capture a rejection for inspection. */
async function rejectionOf(operation: Promise<unknown>): Promise<WebError> {
  try {
    await operation
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(WebError)
    return error as WebError
  }
  throw new Error('expected the search to reject')
}

describe('upstream failure mapping', () => {
  it('reports a thrown plain value as a provider failure with a bounded detail', async () => {
    upstream.search.mockRejectedValue('plain upstream refusal')
    const error = await rejectionOf(search())
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('plain upstream refusal')
    expect(error.message).toContain('EXA_API_KEY')
    expect(error.cause).toBe('plain upstream refusal')
  })

  it('keeps a machine code carried by an error-like object', async () => {
    upstream.search.mockRejectedValue({ code: 'RATE_LIMIT' })
    const error = await rejectionOf(search())
    expect(error.code).toBe('RATE_LIMIT')
    expect(error.message).toContain('[object Object]')
  })

  it('ignores an empty code and falls back to the generic provider failure', async () => {
    upstream.search.mockRejectedValue({ code: '' })
    const error = await rejectionOf(search())
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
  })

  it('reports no upstream detail for an error with an empty message', async () => {
    upstream.search.mockRejectedValue(new Error(''))
    const error = await rejectionOf(search())
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('with no upstream detail')
  })

  it('keeps cancellation as WEB_ABORTED even when the upstream value is not a WebError', async () => {
    const cause = { name: 'AbortError' }
    upstream.search.mockRejectedValue(cause)
    const error = await rejectionOf(search())
    expect(error.code).toBe('WEB_ABORTED')
    expect(error.cause).toBe(cause)
  })
})
