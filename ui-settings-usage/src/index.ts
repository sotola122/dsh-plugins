/**
 * Provider usage for the Settings page, Host half: the `providerUsage` Remote
 * the browser section calls when it opens. Nothing is requested at load or in
 * the background, so an offline Host only shows failed rows on that page.
 * @module @anago-harness/ui-settings-usage
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { readCopilotUsage } from './copilot.ts'
import type { ProviderUsage, UsageProviderId, UsageReport } from './types.ts'

export type * from './types.ts'

/** Accepts https anywhere and plain http on a loopback host, so a token never crosses a network unencrypted. */
const ENDPOINT_PATTERN = /^(?:https:\/\/[^\s/?#]+|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?)(?:\/[^\s?#]*)?$/

/** The providers whose adapters define no usage endpoint this plugin could read. */
const NO_USAGE_ENDPOINT: readonly UsageProviderId[] = ['openai-codex', 'xai', 'opencode-go']

/** GitHub Copilot quota reading. */
export interface CopilotConfig {
  /** Whether the section reads Copilot quota; false reports the row as unsupported without any request. */
  enabled: boolean
  /** Quota URL replacing the one derived from the signed-in grant: https, or http on a loopback host. */
  endpoint?: string
}

/** Plugin config; a change applies when the Host next loads the row. */
export interface Config {
  /** Time limit in milliseconds for each provider request, response body included. */
  timeoutMs: number
  /** GitHub Copilot quota reading. */
  copilot: CopilotConfig
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Remote serving the Settings page's provider usage rows. */
    providerUsage: ProviderUsageService
  }
}

/** Reports each provider's usage to the Settings page. */
export default class ProviderUsageService extends TypertRemoteService {
  static inject = ['credentials', 'typert']
  static Config = z.object({
    timeoutMs: z.number().step(1).min(1).max(120_000).default(10_000),
    copilot: z.object({
      enabled: z.boolean().default(true),
      endpoint: z.string().pattern(ENDPOINT_PATTERN),
    }).default({ enabled: true }),
  })

  /**
   * @param ctx - Host context carrying the credentials service.
   * @param config - validated plugin config.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'providerUsage', { namespace: 'providerUsage' })
  }

  /**
   * Read every provider's usage for the Settings page. A provider's failure
   * stays in its own row; no row carries a credential or provider response text.
   * @param signal - browser cancellation or Remote contribution withdrawal.
   * @returns one row per provider.
   */
  @Remote
  async report(signal: AbortSignal): Promise<UsageReport> {
    const copilot = await this.copilotRow(signal)
    return {
      providers: [
        copilot,
        ...NO_USAGE_ENDPOINT.map((provider): ProviderUsage => ({ provider, status: 'unsupported', reason: 'no-usage-endpoint' })),
      ],
    }
  }

  private async copilotRow(signal: AbortSignal): Promise<ProviderUsage> {
    const { enabled, endpoint } = this.config.copilot
    if (!enabled) return { provider: 'github-copilot', status: 'unsupported', reason: 'disabled' }
    const row = await readCopilotUsage({
      credentials: this.ctx.credentials, endpoint, timeoutMs: this.config.timeoutMs, signal,
    })
    if (row.status === 'failed') this.ctx.logger.warn(`ui-settings-usage: github-copilot usage read failed (${row.reason})`)
    return row
  }
}
