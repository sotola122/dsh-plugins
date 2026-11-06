/**
 * The credential lookup order the fork's search providers share: the literal
 * configured value first, then the credentials service, then the launch
 * environment. Each provider supplies its own `WebError` factories, so its
 * wording stays its own while the sequence and abort checks live here.
 * @module @anago-harness/web-search-credentials/lookup
 */

import type { WebError } from '@deepseek-ai/dsh-web'

/** The credential sources one provider option snapshot carries. */
export interface CredentialSources {
  /** Literal key from the config; takes precedence when non-empty. */
  readonly apiKey?: string | undefined
  /** Credential reference name, used in the missing-credential report. */
  readonly apiKeyEnv: string
  /** Read the reference through the credentials service. */
  readonly resolveCredential: () => Promise<string | undefined>
  /** Read the reference from the launch environment. */
  readonly readEnvironment: () => string | undefined
}

/** The provider-owned failures one lookup can raise. */
export interface CredentialLookupErrors {
  /**
   * Build the cancellation error, retaining the caller's abort reason.
   * @param signal - the aborted caller signal.
   * @returns the provider's `WEB_ABORTED` error.
   */
  readonly aborted: (signal: AbortSignal) => WebError
  /**
   * Build the credentials-service failure.
   * @param cause - what the service threw.
   * @param reference - the credential reference name.
   * @returns the provider's `WEB_PROVIDER_ERROR`.
   */
  readonly resolutionFailure: (cause: unknown, reference: string) => WebError
  /**
   * Build the no-source-found error.
   * @param reference - the credential reference name.
   * @returns the provider's `WEB_PROVIDER_CREDENTIAL_MISSING` error.
   */
  readonly missing: (reference: string) => WebError
}

/**
 * Throw the provider's cancellation error when the caller already aborted, so
 * no credential read is started for a cancelled search.
 * @param signal - the caller's signal, when one was passed.
 * @param errors - the provider's error factories.
 * @throws {WebError} the provider's `WEB_ABORTED` when the signal is aborted.
 */
function throwIfAborted(signal: AbortSignal | undefined, errors: CredentialLookupErrors): void {
  if (signal?.aborted === true) throw errors.aborted(signal)
}

/**
 * Resolve the key for one operation without retaining it, in the documented
 * order: the literal config value, the credentials service, then the launch
 * environment.
 * @param sources - this operation's credential sources.
 * @param signal - the caller's signal, checked across the asynchronous read.
 * @param errors - the provider's error factories.
 * @returns the resolved key; always non-empty.
 * @throws {WebError} the provider's `missing` error when no source supplies a key,
 *   its `aborted` error on cancellation, or its `resolutionFailure` error when the
 *   credentials service throws.
 */
export async function resolveCredentialValue(
  sources: CredentialSources,
  signal: AbortSignal | undefined,
  errors: CredentialLookupErrors,
): Promise<string> {
  const literal = sources.apiKey
  if (literal !== undefined && literal.length > 0) return literal
  throwIfAborted(signal, errors)
  let resolved: string | undefined
  try {
    resolved = await sources.resolveCredential()
  } catch (error) {
    if (signal?.aborted === true) throw errors.aborted(signal)
    throw errors.resolutionFailure(error, sources.apiKeyEnv)
  }
  if (resolved !== undefined && resolved.length > 0) return resolved
  throwIfAborted(signal, errors)
  const ambient = sources.readEnvironment()
  if (ambient !== undefined && ambient.length > 0) return ambient
  throw errors.missing(sources.apiKeyEnv)
}
