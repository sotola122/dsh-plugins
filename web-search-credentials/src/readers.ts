/**
 * The two lazy credential readers a provider snapshot carries: the credentials
 * service and the launch environment. Both read the same reference name and
 * stay lazy, so a credential stored or changed after the plugin loaded reaches
 * the next search.
 * @module @anago-harness/web-search-credentials/readers
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

/** The lazy readers one provider option snapshot exposes. */
export interface CredentialReaders {
  /**
   * Read the reference through the credentials service.
   * @returns the stored value, or undefined while unconfigured or absent.
   */
  resolveCredential: () => Promise<string | undefined>
  /**
   * Read the reference from the launch environment.
   * @returns the ambient value, or undefined while absent or empty.
   */
  readEnvironment: () => string | undefined
}

/**
 * Build both credential readers for one reference name.
 *
 * The service read refuses a name outside the credential-reference grammar
 * before asking: such a name can never have stored a record, so it reads as
 * "not set" and is reported by the missing-credential path instead of throwing.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param reference - the credential reference name from the settings section.
 * @returns the credentials-service and launch-environment readers.
 */
export function createCredentialReaders(ctx: Context, reference: string): CredentialReaders {
  return {
    resolveCredential: async () => {
      if (!isCredentialRefName(reference)) return undefined
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return undefined
      return (await credentials.resolve(credentialRef(reference)))?.value
    },
    readEnvironment: () => {
      const entry = launchEnvironmentOf(ctx).get(reference)
      return entry !== undefined && entry.value.length > 0 ? entry.value : undefined
    },
  }
}
