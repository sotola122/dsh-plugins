/**
 * The shared credential lookup: source precedence, cancellation at every read,
 * the credentials-service failure, and the readers' invalid-reference and
 * absent-source paths.
 * @module @anago-harness/web-search-credentials/test/lookup.spec
 */
import { Context } from '@deepseek-ai/cordis'
import { WebError } from '@deepseek-ai/dsh-web'
import { describe, expect, it, vi } from 'vitest'
import { resolveCredentialValue, type CredentialLookupErrors, type CredentialSources } from '../src/lookup.ts'
import { createCredentialReaders } from '../src/readers.ts'

/** The provider-owned failures, coded so assertions read the branch that threw. */
const errors: CredentialLookupErrors = {
  aborted: signal => new WebError(`aborted:${signal.aborted}`, 'WEB_ABORTED'),
  resolutionFailure: (cause, reference) =>
    new WebError(`failed:${reference}`, 'WEB_PROVIDER_ERROR', { cause }),
  missing: reference => new WebError(`missing:${reference}`, 'WEB_PROVIDER_CREDENTIAL_MISSING'),
}

/** One option snapshot with every source overridable per test. */
function sources(overrides: Partial<CredentialSources> = {}): CredentialSources {
  return {
    apiKeyEnv: 'ANAGO_TEST_API_KEY',
    resolveCredential: () => Promise.resolve(undefined),
    readEnvironment: () => undefined,
    ...overrides,
  }
}

describe('resolveCredentialValue', () => {
  it('prefers a non-empty literal key without reading any source', async () => {
    const resolveCredential = vi.fn(() => Promise.resolve('service'))
    const readEnvironment = vi.fn(() => 'environment')
    await expect(resolveCredentialValue(sources({ apiKey: 'literal', resolveCredential, readEnvironment }), undefined, errors))
      .resolves.toBe('literal')
    expect(resolveCredential).not.toHaveBeenCalled()
    expect(readEnvironment).not.toHaveBeenCalled()
  })

  it('falls through an empty literal key', async () => {
    await expect(resolveCredentialValue(sources({ apiKey: '', resolveCredential: () => Promise.resolve('service') }), undefined, errors))
      .resolves.toBe('service')
  })

  it('throws the aborted error before starting a read when the caller already cancelled', async () => {
    const resolveCredential = vi.fn(() => Promise.resolve('service'))
    const controller = new AbortController()
    controller.abort()
    await expect(resolveCredentialValue(sources({ resolveCredential }), controller.signal, errors))
      .rejects.toMatchObject({ code: 'WEB_ABORTED', message: 'aborted:true' })
    expect(resolveCredential).not.toHaveBeenCalled()
  })

  it('reports an aborted credentials read as cancellation, not a resolution failure', async () => {
    const controller = new AbortController()
    const resolveCredential = async (): Promise<string> => {
      controller.abort()
      throw new Error('service went away')
    }
    await expect(resolveCredentialValue(sources({ resolveCredential }), controller.signal, errors))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('reports a credentials-service throw with the reference and cause', async () => {
    const cause = new Error('keychain locked')
    await expect(resolveCredentialValue(
      sources({ resolveCredential: () => Promise.reject(cause) }),
      undefined,
      errors,
    )).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'failed:ANAGO_TEST_API_KEY',
      cause,
    })
  })

  it('honors a cancellation that arrives during the credentials read', async () => {
    const controller = new AbortController()
    await expect(resolveCredentialValue(
      sources({
        resolveCredential: async () => {
          controller.abort()
          return undefined
        },
      }),
      controller.signal,
      errors,
    )).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('falls back to the launch environment after an unset credentials value', async () => {
    await expect(resolveCredentialValue(
      sources({
        resolveCredential: () => Promise.resolve(''),
        readEnvironment: () => 'environment',
      }),
      undefined,
      errors,
    )).resolves.toBe('environment')
  })

  it('reports the missing credential when no source supplies a non-empty value', async () => {
    await expect(resolveCredentialValue(
      sources({
        resolveCredential: () => Promise.resolve(undefined),
        readEnvironment: () => '',
      }),
      undefined,
      errors,
    )).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
      message: 'missing:ANAGO_TEST_API_KEY',
    })
  })
})

describe('createCredentialReaders', () => {
  it('reads an invalid reference name as unset instead of asking the service', async () => {
    const ctx = new Context()
    const readers = createCredentialReaders(ctx, 'not a credential ref!')
    await expect(readers.resolveCredential()).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('reads a valid reference as unset when no credentials service is composed', async () => {
    const ctx = new Context()
    const readers = createCredentialReaders(ctx, 'ANAGO_TEST_API_KEY')
    await expect(readers.resolveCredential()).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('reads the launch environment lazily and treats an empty value as absent', () => {
    const ctx = new Context()
    const readers = createCredentialReaders(ctx, 'ANAGO_TEST_API_KEY_EMPTY')
    expect(readers.readEnvironment()).toBeUndefined()
  })
})
