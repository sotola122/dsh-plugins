/**
 * Read GitHub Copilot quota with the OAuth grant `llm-pi-ai` stores.
 *
 * The record's `refresh` member is the GitHub token, the same token pi-ai sends
 * to `copilot_internal/v2/token` on this API host; `access` is the short-lived
 * Copilot proxy token. The token reaches only the request's `Authorization`
 * header, and redirects are refused so it cannot follow one.
 * @module @anago-harness/ui-settings-usage/copilot
 */

import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { ProviderUsage, UsageFailureReason, UsageMeter } from './types.ts'

/** The record the pi-ai GitHub Copilot flow commits. */
const COPILOT_RECORD: CredentialKey = credentialKey('llm-pi-ai', 'github-copilot')

/** The quota endpoint for github.com accounts. */
const DEFAULT_ENDPOINT = 'https://api.github.com/copilot_internal/user'

/** The headers pi-ai sends to `copilot_internal/v2/token` on the same API host. */
const COPILOT_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
}

/** A hostname an enterprise grant may name; anything else could redirect the token. */
const ENTERPRISE_DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i

/** The most quotas and characters one report retains from a provider response. */
const MAX_METERS = 16
const MAX_NAME_LENGTH = 64

/** The token and API host one stored grant supplies. */
interface CopilotGrant {
  /** The GitHub token authorizing the request. */
  readonly token: string
  /** The GitHub Enterprise domain, absent for github.com. */
  readonly enterpriseDomain?: string
}

/** What one Copilot read needs from the plugin. */
export interface CopilotUsageRequest {
  /** The store holding the grant. */
  readonly credentials: Pick<CredentialProvider, 'readRecord'>
  /** Configured endpoint; absent derives it from the grant's domain. */
  readonly endpoint: string | undefined
  /** Time limit for the whole request, response body included. */
  readonly timeoutMs: number
  /** Caller cancellation. */
  readonly signal: AbortSignal
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
    ...numberField('entitlement', value.entitlement),
    ...numberField('remaining', value.remaining),
    ...numberField('percentRemaining', value.percent_remaining),
  }
}

/**
 * Normalize a `copilot_internal/user` response. Only recognized fields cross
 * into the row; account identifiers and tokens in the response are never read.
 * @param body - the parsed response.
 * @returns the plan, reset time, and quotas, or undefined when none is present.
 */
export function parseCopilotUsage(body: unknown): Omit<Extract<ProviderUsage, { status: 'ok' }>, 'provider' | 'status'> | undefined {
  if (!isRecord(body)) return undefined
  const snapshots = isRecord(body.quota_snapshots) ? Object.entries(body.quota_snapshots) : []
  const meters = snapshots
    .flatMap(([id, value]) => parseMeter(id, value) ?? [])
    .slice(0, MAX_METERS)
  const plan = typeof body.copilot_plan === 'string' && body.copilot_plan.length > 0
    ? body.copilot_plan.slice(0, MAX_NAME_LENGTH)
    : undefined
  if (plan === undefined && meters.length === 0) return undefined
  const resetAt = typeof body.quota_reset_date === 'string' ? Date.parse(body.quota_reset_date) : Number.NaN
  return {
    ...plan === undefined ? {} : { plan },
    ...Number.isFinite(resetAt) ? { resetAt } : {},
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
export async function readCopilotUsage(request: CopilotUsageRequest): Promise<ProviderUsage> {
  const { credentials, endpoint, timeoutMs, signal } = request
  let record
  try {
    record = await credentials.readRecord(COPILOT_RECORD)
  } catch (_error) {
    // The store's message may quote its backing path; the row carries the code alone.
    signal.throwIfAborted()
    return failed('credential-unusable')
  }
  signal.throwIfAborted()
  if (record?.kind !== 'grant') return failed('not-signed-in')
  const grant = parseGrant(record.payload)
  if (grant === undefined) return failed('credential-unusable')

  const deadline = AbortSignal.timeout(timeoutMs)
  try {
    const response = await fetch(resolveCopilotEndpoint(endpoint, grant.enterpriseDomain), {
      headers: { ...COPILOT_HEADERS, Authorization: `Bearer ${grant.token}` },
      redirect: 'error',
      signal: AbortSignal.any([signal, deadline]),
    })
    if (!response.ok) {
      await response.body?.cancel()
      return httpFailure(response.status)
    }
    const usage = parseCopilotUsage(await response.json())
    return usage === undefined
      ? failed('invalid-response')
      : { provider: 'github-copilot', status: 'ok', ...usage }
  } catch (error) {
    signal.throwIfAborted()
    if (deadline.aborted) return failed('timeout')
    return failed(error instanceof SyntaxError ? 'invalid-response' : 'network')
  }
}

/** The row for a non-success response. */
function httpFailure(status: number): ProviderUsage {
  if (status === 401 || status === 403) return failed('unauthorized')
  if (status === 429) return failed('rate-limited')
  return { provider: 'github-copilot', status: 'failed', reason: 'http-error', httpStatus: status }
}

/** The row for a failure that carries only its reason. */
function failed(reason: UsageFailureReason): ProviderUsage {
  return { provider: 'github-copilot', status: 'failed', reason }
}

/** A one-member object when the value is a finite number, otherwise an empty one. */
function numberField<K extends string>(key: K, value: unknown): { readonly [P in K]?: number } {
  return typeof value === 'number' && Number.isFinite(value) ? { [key]: value } as { [P in K]: number } : {}
}

/** Whether a parsed JSON value is an object with named members. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
