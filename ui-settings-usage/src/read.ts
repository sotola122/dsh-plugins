/**
 * What every provider reader shares: the read's time limit, the authorized GET,
 * the mapping from failure to a closed reason code, the renewal of a stored
 * OAuth grant, and the coercion of untyped response values. A token reaches only
 * a request's headers, and redirects are refused so it cannot follow one.
 * @module @anago-harness/ui-settings-usage/read
 */

import type { AuthorizationRenewal, AuthorizationService } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { ProviderUsage, UsageFailureReason, UsageMeter, UsageProviderId, UsageSignInReason } from './types.ts'

/** The usage fields a response parser produces. */
export type ReportedUsage = Omit<Extract<ProviderUsage, { status: 'ok' }>, 'provider' | 'status'>

/** The most characters one report retains from a provider-supplied name. */
export const MAX_NAME_LENGTH = 64

/** A numeric timestamp below this counts as seconds; above it, as milliseconds. */
const MILLISECOND_EPOCH_FLOOR = 100_000_000_000

/** The limits of one provider read. */
export interface ReadLimits {
  /** Time limit for the whole read, renewal and response body included. */
  readonly timeoutMs: number
  /** Stops the read; it rejects with this signal's reason instead of returning a row. */
  readonly signal: AbortSignal
}

/**
 * Run one provider read inside its time limit. Only `limits.signal` makes the
 * returned promise reject; every other failure becomes a row.
 * @param provider - the row's provider.
 * @param limits - the time limit and cancellation signal.
 * @param read - the read, given the signal that covers both.
 * @returns the provider's row.
 * @throws The signal's reason when `limits.signal` aborts.
 */
export async function readWithinLimit(
  provider: UsageProviderId,
  limits: ReadLimits,
  read: (signal: AbortSignal) => Promise<ProviderUsage>,
): Promise<ProviderUsage> {
  const deadline = AbortSignal.timeout(limits.timeoutMs)
  try {
    return await read(AbortSignal.any([limits.signal, deadline]))
  } catch (error) {
    limits.signal.throwIfAborted()
    if (deadline.aborted) return failed(provider, 'timeout')
    return failed(provider, error instanceof SyntaxError ? 'invalid-response' : 'network')
  }
}

/** One authorized usage request. */
export interface UsageRequest {
  /** The absolute URL. */
  readonly url: string
  /** Authorization and any provider-specific headers. */
  readonly headers: Readonly<Record<string, string>>
  /** Stops the request and its response body. */
  readonly signal: AbortSignal
  /**
   * Normalize the parsed response. Only recognized fields cross into the row.
   * @param body - the parsed response.
   * @returns the usage, or undefined when no recognized field is present.
   */
  readonly parse: (body: unknown) => ReportedUsage | undefined
}

/**
 * Send one usage request and turn its response into a row.
 * @param provider - the row's provider.
 * @param request - the URL, headers, signal, and response parser.
 * @returns the provider's row.
 * @throws What `fetch` or the body parser throws; {@link readWithinLimit} maps it to a row.
 */
export async function requestUsage(provider: UsageProviderId, request: UsageRequest): Promise<ProviderUsage> {
  const response = await fetch(request.url, {
    headers: { Accept: 'application/json', ...request.headers },
    redirect: 'error',
    signal: request.signal,
  })
  if (!response.ok) {
    await response.body?.cancel()
    return httpFailure(provider, response.status)
  }
  const usage = request.parse(await response.json())
  return usage === undefined ? failed(provider, 'invalid-response') : { provider, status: 'ok', ...usage }
}

/** The row for a non-success response. */
function httpFailure(provider: UsageProviderId, status: number): ProviderUsage {
  if (status === 401) return signInRequired(provider, 'token-rejected')
  if (status === 403) return failed(provider, 'forbidden')
  if (status === 429) return failed(provider, 'rate-limited')
  return { provider, status: 'failed', reason: 'http-error', httpStatus: status }
}

/**
 * The row for a failure that carries only its reason.
 * @param provider - the row's provider.
 * @param reason - the closed failure code.
 * @returns the row.
 */
export function failed(provider: UsageProviderId, reason: UsageFailureReason): ProviderUsage {
  return { provider, status: 'failed', reason }
}

/**
 * The row for a provider that needs the human to sign in again.
 * @param provider - the row's provider.
 * @param reason - the closed sign-in code.
 * @returns the row.
 */
export function signInRequired(provider: UsageProviderId, reason: UsageSignInReason): ProviderUsage {
  return { provider, status: 'sign-in-required', reason }
}

/** The members of a stored OAuth grant that a reader authorizes with. */
export interface AccessGrant {
  /** The access token. */
  readonly access: string
  /** Epoch milliseconds when the access token expires. */
  readonly expires: number
  /** The OpenAI account the token belongs to; only the Codex grant carries it. */
  readonly accountId?: string
}

/** What resolving a grant needs from the plugin. */
export interface GrantSources {
  /** The store holding the grant. */
  readonly credentials: Pick<CredentialProvider, 'readRecord'>
  /** The renewal path; undefined in a composition that mounts no authorization service. */
  readonly authorization: Pick<AuthorizationService, 'renew'> | undefined
}

/** Validate a stored grant payload, which is durable data of another plugin's format. */
function parseAccessGrant(payload: unknown): AccessGrant | undefined {
  if (!isRecord(payload) || typeof payload.access !== 'string' || payload.access.length === 0) return undefined
  if (typeof payload.expires !== 'number') return undefined
  return {
    access: payload.access,
    expires: payload.expires,
    ...field('accountId', typeof payload.accountId === 'string' && payload.accountId.length > 0 ? payload.accountId : undefined),
  }
}

/** Read and validate one stored grant, or the row explaining why there is none. */
async function storedGrant(
  provider: UsageProviderId,
  key: CredentialKey,
  credentials: GrantSources['credentials'],
): Promise<AccessGrant | ProviderUsage> {
  let record
  try {
    record = await credentials.readRecord(key)
  } catch (_error) {
    // The store's message may quote its backing path; the row carries the code alone.
    return failed(provider, 'credential-unusable')
  }
  if (record?.kind !== 'grant') return signInRequired(provider, 'not-signed-in')
  return parseAccessGrant(record.payload) ?? failed(provider, 'credential-unusable')
}

/**
 * Resolve the grant a read authorizes with, renewing it first when the flow that
 * owns the record says it is due. A token that has not expired stays usable when
 * its early renewal fails; an expired one becomes a sign-in row. Nothing here
 * starts a sign-in.
 * @param provider - the row's provider.
 * @param key - the record the provider's sign-in flow commits.
 * @param sources - the store and the optional renewal path.
 * @param signal - stops the wait for the renewal.
 * @returns the grant, or the row explaining why there is none.
 * @throws The signal's reason when it aborts during the renewal.
 */
export async function currentAccessGrant(
  provider: UsageProviderId,
  key: CredentialKey,
  sources: GrantSources,
  signal: AbortSignal,
): Promise<AccessGrant | ProviderUsage> {
  const stored = await storedGrant(provider, key, sources.credentials)
  if (isRow(stored)) return stored
  let renewal: AuthorizationRenewal | 'failed'
  try {
    renewal = await sources.authorization?.renew(key, signal) ?? 'unavailable'
  } catch (_error) {
    // The issuer's refusal may quote its own text; the row carries the code alone.
    signal.throwIfAborted()
    renewal = 'failed'
  }
  const grant = renewal === 'current' ? await storedGrant(provider, key, sources.credentials) : stored
  if (isRow(grant) || Date.now() < grant.expires) return grant
  return signInRequired(provider, renewal === 'failed' ? 'renewal-failed' : 'token-expired')
}

/**
 * Tell a resolved grant from the row that replaced it.
 * @param value - the result of {@link currentAccessGrant}.
 * @returns whether the value is a row.
 */
export function isRow(value: AccessGrant | ProviderUsage): value is ProviderUsage {
  return 'status' in value
}

/**
 * A one-member object when the value is present, otherwise an empty one, for
 * spreading an optional field.
 * @param key - the member name.
 * @param value - the member value.
 * @returns the object to spread.
 */
export function field<K extends string, V>(key: K, value: V | undefined): { readonly [P in K]?: V } {
  return value === undefined ? {} : { [key]: value } as { [P in K]: V }
}

/**
 * Whether a parsed JSON value is an object with named members.
 * @param value - the parsed value.
 * @returns whether its members can be read by name.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The named members of an optional response object.
 * @param value - the parsed value.
 * @returns its members, or none when it is not an object.
 */
export function membersOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/**
 * Read a provider-supplied name, bounded to what one row retains.
 * @param value - the parsed value.
 * @returns the bounded text, or undefined for anything but non-empty text.
 */
export function boundedText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_NAME_LENGTH) : undefined
}

/**
 * Read a number a provider may send as JSON text, as balances often are.
 * @param value - the parsed value.
 * @returns the finite number, or undefined for anything else.
 */
export function amount(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Read a timestamp a provider sends as epoch seconds, epoch milliseconds, or a date string.
 * @param value - the parsed value.
 * @returns epoch milliseconds, or undefined when the value names no instant.
 */
export function instant(value: unknown): number | undefined {
  const numeric = amount(value)
  if (numeric !== undefined) {
    if (numeric <= 0) return undefined
    return numeric < MILLISECOND_EPOCH_FLOOR ? numeric * 1000 : numeric
  }
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Keep a meter only when it reports something to show, so a response without
 * these numbers reads as missing rather than as an empty quota.
 * @param meter - the normalized quota.
 * @returns the meter, or undefined when it reports no amount, share, or unlimited state.
 */
export function withReading(meter: UsageMeter): UsageMeter | undefined {
  const { unlimited, entitlement, used, remaining, percentUsed, percentRemaining } = meter
  const reports = unlimited || [entitlement, used, remaining, percentUsed, percentRemaining].some(value => value !== undefined)
  return reports ? meter : undefined
}
