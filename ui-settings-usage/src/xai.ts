/**
 * Read xAI credit usage with the OAuth grant `llm-pi-ai` stores. The access token
 * expires, so a read renews it first through the flow that owns the record.
 *
 * The response is a protobuf message rendered as JSON: a zero-valued scalar may
 * be missing, and money is an object holding cents in `val`, where `{}` is zero.
 * @module @anago-harness/ui-settings-usage/xai
 */

import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { amount, currentAccessGrant, field, instant, isRecord, isRow, membersOf, readWithinLimit, requestUsage, withReading } from './read.ts'
import type { GrantSources, ReadLimits, ReportedUsage } from './read.ts'
import type { ProviderUsage } from './types.ts'

/** The record the pi-ai xAI flow commits. */
const XAI_RECORD: CredentialKey = credentialKey('llm-pi-ai', 'xai')

/** The billing endpoint of the Grok CLI proxy; `format=credits` is added to any configured URL too. */
const DEFAULT_ENDPOINT = 'https://cli-chat-proxy.grok.com/v1/billing'

/** The currency of the money fields, which the response does not name. */
const CURRENCY = 'USD'

/** What one xAI read needs from the plugin. */
export interface XaiUsageRequest extends ReadLimits, GrantSources {
  /** Configured endpoint; absent uses the Grok CLI proxy. */
  readonly endpoint: string | undefined
}

/** Read a money object as whole currency units; an object with no `val` holds zero. */
function dollars(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const cents = value.val === undefined ? 0 : amount(value.val)
  return cents === undefined ? undefined : cents / 100
}

/**
 * Normalize a `billing?format=credits` response. A number the response omits
 * stays absent rather than reading as zero, so a changed response shows as
 * missing numbers and never as an empty allowance.
 * @param body - the parsed response.
 * @returns the quotas, or undefined when none is present.
 */
export function parseXaiUsage(body: unknown): ReportedUsage | undefined {
  if (!isRecord(body) || !isRecord(body.config)) return undefined
  const config = body.config
  const period = membersOf(config.currentPeriod)
  const meters = [
    withReading({
      id: 'included_credits',
      unlimited: false,
      ...field('percentUsed', amount(config.creditUsagePercent)),
      ...field('resetAt', instant(period.end) ?? instant(config.billingPeriodEnd)),
    }),
    withReading({
      id: 'on_demand',
      unlimited: false,
      unit: CURRENCY,
      ...field('entitlement', dollars(config.onDemandCap)),
      ...field('used', dollars(config.onDemandUsed)),
    }),
    withReading({ id: 'prepaid_credits', unlimited: false, unit: CURRENCY, ...field('remaining', dollars(config.prepaidBalance)) }),
  ].flatMap(meter => meter ?? [])
  return meters.length === 0 ? undefined : { meters }
}

/**
 * Read the signed-in account's xAI credit usage. Every failure becomes a row
 * whose reason is a closed code; only caller cancellation rejects.
 * @param request - the store, renewal path, endpoint, time limit, and cancellation signal.
 * @returns the provider's row.
 * @throws The signal's reason when the caller cancels.
 */
export function readXaiUsage(request: XaiUsageRequest): Promise<ProviderUsage> {
  return readWithinLimit('xai', request, async (signal) => {
    const grant = await currentAccessGrant('xai', XAI_RECORD, request, signal)
    signal.throwIfAborted()
    if (isRow(grant)) return grant
    const url = new URL(request.endpoint ?? DEFAULT_ENDPOINT)
    url.searchParams.set('format', 'credits')
    return requestUsage('xai', {
      url: url.href,
      headers: { Authorization: `Bearer ${grant.access}` },
      signal,
      parse: parseXaiUsage,
    })
  })
}
