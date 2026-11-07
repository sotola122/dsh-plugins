/**
 * Read GitHub Copilot quota with the OAuth grant `llm-pi-ai` stores.
 *
 * The record's `refresh` member is the GitHub token, the same token pi-ai sends
 * to `copilot_internal/v2/token` on this API host; `access` is the short-lived
 * Copilot proxy token. This read never uses `access`, so its expiry neither
 * blocks the read nor calls for a renewal.
 * @module @anago-harness/ui-settings-usage/copilot
 */

import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { boundedText, failed, field, isRecord, MAX_NAME_LENGTH, readWithinLimit, requestUsage, signInRequired } from './read.ts'
import type { ReadLimits, ReportedUsage } from './read.ts'
import type { ProviderUsage, UsageMeter } from './types.ts'

/** The record the pi-ai GitHub Copilot flow commits. */
const COPILOT_RECORD: CredentialKey = credentialKey('llm-pi-ai', 'github-copilot')

/** The quota endpoint for github.com accounts. */
const DEFAULT_ENDPOINT = 'https://api.github.com/copilot_internal/user'

/** The headers pi-ai sends to `copilot_internal/v2/token` on the same API host. */
const COPILOT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
}

/** A hostname an enterprise grant may name; anything else could redirect the token. */
const ENTERPRISE_DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i

/** The most quotas one report retains from a provider response. */
const MAX_METERS = 16

/** The token and API host one stored grant supplies. */
interface CopilotGrant {
  /** The GitHub token authorizing the request. */
  readonly token: string
  /** The GitHub Enterprise domain, absent for github.com. */
  readonly enterpriseDomain?: string
}

/** What one Copilot read needs from the plugin. */
export interface CopilotUsageRequest extends ReadLimits {
  /** The store holding the grant. */
  readonly credentials: Pick<CredentialProvider, 'readRecord'>
  /** Configured endpoint; absent derives it from the grant's domain. */
  readonly endpoint: string | undefined
}

/**
 * Choose the URL one read calls: the configured override, then the grant's
 * enterprise API host (`api.<domain>`, as pi-ai derives its token URL), then
 * github.com.
 * @param endpoint - configured override.
 * @param enterpriseDomain - the grant's validated enterprise domain.
 * @returns the absolute URL.
 */
export function resolveCopilotEndpoint(endpoint: string | undefined, enterpriseDomain: string | undefined): string {
  if (endpoint !== undefined) return endpoint
  return enterpriseDomain === undefined ? DEFAULT_ENDPOINT : `https://api.${enterpriseDomain}/copilot_internal/user`
}

/**
 * Validate a stored grant payload, which is durable data of another plugin's format.
 * @param payload - the record's opaque payload.
 * @returns the token and domain, or undefined when the payload lacks a usable one.
 */
function parseGrant(payload: unknown): CopilotGrant | undefined {
  if (!isRecord(payload) || typeof payload.refresh !== 'string' || payload.refresh.length === 0) return undefined
  const enterprise = payload.enterpriseUrl
  if (enterprise === undefined || enterprise === null) return { token: payload.refresh }
  if (typeof enterprise !== 'string' || !ENTERPRISE_DOMAIN.test(enterprise)) return undefined
  return { token: payload.refresh, enterpriseDomain: enterprise }
}

/** A finite number from a field this API documents as numeric, or undefined. */
function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Read one quota snapshot, dropping a number that is not finite.
 * @param id - the snapshot's key in the response.
 * @param value - the snapshot.
 * @returns the meter, or undefined when the snapshot is not an object.
 */
function parseMeter(id: string, value: unknown): UsageMeter | undefined {
  if (!isRecord(value)) return undefined
  return {
    id: id.slice(0, MAX_NAME_LENGTH),
    unlimited: value.unlimited === true,
    ...field('entitlement', finite(value.entitlement)),
    ...field('remaining', finite(value.remaining)),
    ...field('percentRemaining', finite(value.percent_remaining)),
  }
}

/**
 * Normalize a `copilot_internal/user` response. Only recognized fields cross
 * into the row; account identifiers and tokens in the response are never read.
 * @param body - the parsed response.
 * @returns the plan, reset time, and quotas, or undefined when none is present.
 */
export function parseCopilotUsage(body: unknown): ReportedUsage | undefined {
  if (!isRecord(body)) return undefined
  const snapshots = isRecord(body.quota_snapshots) ? Object.entries(body.quota_snapshots) : []
  const meters = snapshots
    .flatMap(([id, value]) => parseMeter(id, value) ?? [])
    .slice(0, MAX_METERS)
  const plan = boundedText(body.copilot_plan)
  if (plan === undefined && meters.length === 0) return undefined
  const resetAt = typeof body.quota_reset_date === 'string' ? Date.parse(body.quota_reset_date) : Number.NaN
  return {
    ...field('plan', plan),
    ...field('resetAt', Number.isFinite(resetAt) ? resetAt : undefined),
    meters,
  }
}

/**
 * Read the signed-in account's Copilot quota. Every failure becomes a row whose
 * reason is a closed code; only caller cancellation rejects.
 * @param request - the store, endpoint, time limit, and cancellation signal.
 * @returns the provider's row.
 * @throws The signal's reason when the caller cancels.
 */
export function readCopilotUsage(request: CopilotUsageRequest): Promise<ProviderUsage> {
  return readWithinLimit('github-copilot', request, async (signal) => {
    let record
    try {
      record = await request.credentials.readRecord(COPILOT_RECORD)
    } catch (_error) {
      // The store's message may quote its backing path; the row carries the code alone.
      signal.throwIfAborted()
      return failed('github-copilot', 'credential-unusable')
    }
    signal.throwIfAborted()
    if (record?.kind !== 'grant') return signInRequired('github-copilot', 'not-signed-in')
    const grant = parseGrant(record.payload)
    if (grant === undefined) return failed('github-copilot', 'credential-unusable')
    return requestUsage('github-copilot', {
      url: resolveCopilotEndpoint(request.endpoint, grant.enterpriseDomain),
      headers: { ...COPILOT_HEADERS, Authorization: `Bearer ${grant.token}` },
      signal,
      parse: parseCopilotUsage,
    })
  })
}
