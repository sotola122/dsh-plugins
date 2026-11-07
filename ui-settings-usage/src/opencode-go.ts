/**
 * Read OpenCode Go usage with a stored API key, which does not expire and has no
 * renewal path: a rejected key reads as a sign-in row.
 * @module @anago-harness/ui-settings-usage/opencode-go
 */

import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { amount, failed, field, instant, isRecord, readWithinLimit, requestUsage, signInRequired, withReading } from './read.ts'
import type { ReadLimits, ReportedUsage } from './read.ts'
import type { ProviderUsage } from './types.ts'

/** The record the pi-ai OpenCode Go key prompt commits. */
const OPENCODE_RECORD: CredentialKey = credentialKey('llm-pi-ai', 'opencode-go')

/** The usage endpoint of the OpenCode gateway. */
const DEFAULT_ENDPOINT = 'https://opencode.ai/zen/go/v1/usage'

/** The usage windows the response reports, in display order. */
const WINDOWS = ['rolling', 'weekly', 'monthly'] as const

/** What one OpenCode Go read needs from the plugin. */
export interface OpenCodeGoUsageRequest extends ReadLimits {
  /** The store holding the key. */
  readonly credentials: Pick<CredentialProvider, 'readRecord' | 'resolve'>
  /** Credential references to try in order, before the stored record. */
  readonly apiKeyEnvs: readonly string[]
  /** Configured endpoint; absent uses the OpenCode gateway. */
  readonly endpoint: string | undefined
}

/**
 * Normalize a `zen/go/v1/usage` response. `percent` is the share consumed.
 * @param body - the parsed response.
 * @returns the quotas, or undefined when none is present.
 */
export function parseOpenCodeGoUsage(body: unknown): ReportedUsage | undefined {
  if (!isRecord(body) || !isRecord(body.usage)) return undefined
  const usage = body.usage
  const meters = WINDOWS.flatMap((id) => {
    const window = usage[id]
    if (!isRecord(window)) return []
    return withReading({
      id,
      unlimited: false,
      ...field('percentUsed', amount(window.percent)),
      ...field('resetAt', instant(window.resetsAt)),
    }) ?? []
  })
  return meters.length === 0 ? undefined : { meters }
}

/** The first stored key: each configured reference, then the record the key prompt writes. */
async function storedKey(request: OpenCodeGoUsageRequest): Promise<string | undefined> {
  for (const name of request.apiKeyEnvs) {
    const hit = await request.credentials.resolve(credentialRef(name))
    if (hit !== undefined && hit.value.length > 0) return hit.value
  }
  const record = await request.credentials.readRecord(OPENCODE_RECORD)
  return record?.kind === 'api-key' ? record.key : undefined
}

/**
 * Read the key's OpenCode Go usage. Every failure becomes a row whose reason is
 * a closed code; only caller cancellation rejects.
 * @param request - the store, references, endpoint, time limit, and cancellation signal.
 * @returns the provider's row.
 * @throws The signal's reason when the caller cancels.
 */
export function readOpenCodeGoUsage(request: OpenCodeGoUsageRequest): Promise<ProviderUsage> {
  return readWithinLimit('opencode-go', request, async (signal) => {
    let key
    try {
      key = await storedKey(request)
    } catch (_error) {
      // The store's message may quote its backing path; the row carries the code alone.
      signal.throwIfAborted()
      return failed('opencode-go', 'credential-unusable')
    }
    signal.throwIfAborted()
    if (key === undefined || key.length === 0) return signInRequired('opencode-go', 'not-signed-in')
    return requestUsage('opencode-go', {
      url: request.endpoint ?? DEFAULT_ENDPOINT,
      headers: { Authorization: `Bearer ${key}` },
      signal,
      parse: parseOpenCodeGoUsage,
    })
  })
}
