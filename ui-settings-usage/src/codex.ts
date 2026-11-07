/**
 * Read OpenAI Codex usage with the OAuth grant `llm-pi-ai` stores. The access
 * token expires, so a read renews it first through the flow that owns the record.
 * @module @anago-harness/ui-settings-usage/codex
 */

import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { amount, boundedText, currentAccessGrant, failed, field, instant, isRecord, isRow, membersOf, readWithinLimit, requestUsage, withReading } from './read.ts'
import type { GrantSources, ReadLimits, ReportedUsage } from './read.ts'
import type { ProviderUsage, UsageMeter } from './types.ts'

/** The record the pi-ai OpenAI Codex flow commits. */
const CODEX_RECORD: CredentialKey = credentialKey('llm-pi-ai', 'openai-codex')

/** The usage endpoint of the ChatGPT backend. */
const DEFAULT_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage'

/** What one Codex read needs from the plugin. */
export interface CodexUsageRequest extends ReadLimits, GrantSources {
  /** Configured endpoint; absent uses the ChatGPT backend. */
  readonly endpoint: string | undefined
}

/** Read an individual limit or a rate-limit window, which share these field names. */
function limitMeter(id: string, value: unknown): UsageMeter | undefined {
  if (!isRecord(value)) return undefined
  const afterSeconds = amount(value.reset_after_seconds)
  return withReading({
    id,
    unlimited: false,
    ...field('entitlement', amount(value.limit)),
    ...field('used', amount(value.used)),
    ...field('remaining', amount(value.remaining)),
    ...field('percentUsed', amount(value.used_percent)),
    ...field('percentRemaining', amount(value.remaining_percent)),
    ...field('unit', boundedText(value.unit)),
    ...field('resetAt', instant(value.reset_at) ?? (afterSeconds === undefined ? undefined : Date.now() + afterSeconds * 1000)),
  })
}

/** Read the `credits` object, whose balance arrives as JSON text. */
function creditsMeter(value: unknown): UsageMeter | undefined {
  if (!isRecord(value)) return undefined
  return withReading({ id: 'credits', unlimited: value.unlimited === true, ...field('remaining', amount(value.balance)) })
}

/**
 * Normalize a `wham/usage` response. Only recognized fields cross into the row;
 * the response's user id, account id, and email are never read.
 * @param body - the parsed response.
 * @returns the plan and quotas, or undefined when none is present.
 */
export function parseCodexUsage(body: unknown): ReportedUsage | undefined {
  if (!isRecord(body)) return undefined
  const rateLimit = membersOf(body.rate_limit)
  const meters = [
    limitMeter('spend_limit', membersOf(body.spend_control).individual_limit),
    limitMeter('primary_window', rateLimit.primary_window),
    limitMeter('secondary_window', rateLimit.secondary_window),
    limitMeter('code_review', membersOf(body.code_review_rate_limit).primary_window),
    creditsMeter(body.credits),
  ].flatMap(meter => meter ?? [])
  const plan = boundedText(body.plan_type)
  if (plan === undefined && meters.length === 0) return undefined
  return { ...field('plan', plan), meters }
}

/**
 * Read the signed-in account's Codex usage. Every failure becomes a row whose
 * reason is a closed code; only caller cancellation rejects.
 * @param request - the store, renewal path, endpoint, time limit, and cancellation signal.
 * @returns the provider's row.
 * @throws The signal's reason when the caller cancels.
 */
export function readCodexUsage(request: CodexUsageRequest): Promise<ProviderUsage> {
  return readWithinLimit('openai-codex', request, async (signal) => {
    const grant = await currentAccessGrant('openai-codex', CODEX_RECORD, request, signal)
    signal.throwIfAborted()
    if (isRow(grant)) return grant
    if (grant.accountId === undefined) return failed('openai-codex', 'credential-unusable')
    return requestUsage('openai-codex', {
      url: request.endpoint ?? DEFAULT_ENDPOINT,
      headers: { Authorization: `Bearer ${grant.access}`, 'ChatGPT-Account-Id': grant.accountId },
      signal,
      parse: parseCodexUsage,
    })
  })
}
