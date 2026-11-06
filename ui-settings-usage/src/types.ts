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
  /** Provider-defined quota name, such as `premium_interactions`. */
  readonly id: string
  /** Whether the provider reports this quota as unlimited. */
  readonly unlimited: boolean
  /** Total allowance for the period. */
  readonly entitlement?: number
  /** Allowance left in the period. */
  readonly remaining?: number
  /** Share of the allowance left, from 0 to 100. */
  readonly percentRemaining?: number
}

/** Why a provider row carries no usage although reading it was attempted; another HTTP status has its own row. */
export type UsageFailureReason =
  /** No OAuth grant is stored for the provider. */
  | 'not-signed-in'
  /** The stored credential could not be read or lacks a usable token. */
  | 'credential-unusable'
  /** The provider answered 401 or 403. */
  | 'unauthorized'
  /** The provider answered 429. */
  | 'rate-limited'
  /** The configured time limit elapsed before the response finished. */
  | 'timeout'
  /** The request failed without an HTTP response, including a refused redirect. */
  | 'network'
  /** The response was not JSON or carried no recognized usage field. */
  | 'invalid-response'

/** Why a provider row is not read at all. */
export type UsageUnsupportedReason =
  /** The provider's adapter defines no usage endpoint to read. */
  | 'no-usage-endpoint'
  /** The profile turned reading this provider off. */
  | 'disabled'

/** One provider's row in a usage report, discriminated by `status`. */
export type ProviderUsage =
  | {
    readonly provider: UsageProviderId
    readonly status: 'ok'
    /** Subscription plan name the provider reports. */
    readonly plan?: string
    /** Epoch milliseconds when the quota period resets. */
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
}
