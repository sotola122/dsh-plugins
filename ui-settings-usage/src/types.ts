/**
 * Wire types of the `providerUsage` Remote, shared by the Host service and the
 * browser section. Failure and refusal reasons are closed codes, so no provider
 * response text or credential value can reach a row.
 * @module @anago-harness/ui-settings-usage/types
 */

/** A provider the Usage section reports, named by its `llm-pi-ai` route key. */
export type UsageProviderId = 'github-copilot' | 'openai-codex' | 'xai' | 'opencode-go'

/** One quota the provider reported; a number the provider omitted stays absent. */
export interface UsageMeter {
  /** Quota name: the provider's own for Copilot, a fixed name for the other providers. */
  readonly id: string
  /** Whether the provider reports this quota as unlimited. */
  readonly unlimited: boolean
  /** Total allowance for the period. */
  readonly entitlement?: number
  /** Allowance consumed in the period. */
  readonly used?: number
  /** Allowance left in the period. */
  readonly remaining?: number
  /** Share of the allowance consumed, from 0 to 100. */
  readonly percentUsed?: number
  /** Share of the allowance left, from 0 to 100. */
  readonly percentRemaining?: number
  /** Unit of `entitlement`, `used`, and `remaining`; absent when the provider names none. */
  readonly unit?: string
  /** Epoch milliseconds when this quota resets. */
  readonly resetAt?: number
}

/** Why a provider row carries no usage although reading it was attempted; another HTTP status has its own row. */
export type UsageFailureReason =
  /** The stored credential could not be read or lacks a usable token. */
  | 'credential-unusable'
  /** The provider answered 403. */
  | 'forbidden'
  /** The provider answered 429. */
  | 'rate-limited'
  /** The configured time limit elapsed before the read finished. */
  | 'timeout'
  /** The request failed without an HTTP response, including a refused redirect. */
  | 'network'
  /** The response was not JSON or carried no recognized usage field. */
  | 'invalid-response'

/** Why a provider row needs a human to sign in again; the section never starts a sign-in itself. */
export type UsageSignInReason =
  /** No credential is stored for the provider. */
  | 'not-signed-in'
  /** The token expired and this composition has no renewal path for it. */
  | 'token-expired'
  /** The token expired and its renewal failed. */
  | 'renewal-failed'
  /** The provider answered 401. */
  | 'token-rejected'

/** Why a provider row is not read at all. */
export type UsageUnsupportedReason =
  /** The profile turned reading this provider off. */
  | 'disabled'

/** One provider's row in a usage report, discriminated by `status`. */
export type ProviderUsage =
  | {
    readonly provider: UsageProviderId
    readonly status: 'ok'
    /** Subscription plan name the provider reports. */
    readonly plan?: string
    /** Epoch milliseconds when every quota in the row resets, when the provider reports one date for all of them. */
    readonly resetAt?: number
    /** Quotas the provider reported, possibly none when only a plan is known. */
    readonly meters: readonly UsageMeter[]
  }
  | {
    readonly provider: UsageProviderId
    readonly status: 'unsupported'
    readonly reason: UsageUnsupportedReason
  }
  | {
    readonly provider: UsageProviderId
    readonly status: 'sign-in-required'
    readonly reason: UsageSignInReason
  }
  | {
    readonly provider: UsageProviderId
    readonly status: 'failed'
    readonly reason: UsageFailureReason
  }
  | {
    readonly provider: UsageProviderId
    readonly status: 'failed'
    readonly reason: 'http-error'
    /** The non-success response status. */
    readonly httpStatus: number
  }

/** Every provider's row from one `providerUsage/report` call. */
export interface UsageReport {
  /** One row per {@link UsageProviderId}. */
  readonly providers: readonly ProviderUsage[]
  /** Epoch milliseconds when these rows were read; older than the call when the Host reused a recent read. */
  readonly readAt: number
}
