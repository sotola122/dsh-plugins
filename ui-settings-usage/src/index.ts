/**
 * Provider usage for the Settings page, Host half: the `providerUsage` Remote
 * the browser section calls when it opens. Nothing is requested at load or in
 * the background, so an offline Host only shows failed rows on that page.
 * @module @anago-harness/ui-settings-usage
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-credentials'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { readCodexUsage } from './codex.ts'
import { readCopilotUsage } from './copilot.ts'
import { readOpenCodeGoUsage } from './opencode-go.ts'
import { untilAborted } from './read.ts'
import { readXaiUsage } from './xai.ts'
import type { ProviderUsage, UsageProviderId, UsageReport } from './types.ts'

export type * from './types.ts'

/** Accepts https anywhere and plain http on a loopback host, so a token never crosses a network unencrypted. */
const ENDPOINT_PATTERN = /^(?:https:\/\/[^\s/?#]+|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?)(?:\/[^\s?#]*)?$/

/** The grammar of a credential reference name. */
const REF_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The references an OpenCode Go key is stored under: this fork's name, then pi-ai's. */
const OPENCODE_API_KEY_ENVS = ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY']

/** Reading one provider's usage. */
export interface ProviderReadConfig {
  /** Whether the section reads this provider; false reports the row as unsupported without any request. */
  enabled: boolean
  /** Usage URL replacing the built-in one: https, or http on a loopback host, without a query. */
  endpoint?: string
}

/** Reading OpenCode Go usage. */
export interface OpenCodeGoConfig extends ProviderReadConfig {
  /** Credential references holding the API key, tried in order before the record `llm-pi-ai` stores. */
  apiKeyEnvs: string[]
}

/** Plugin config; a change applies when the Host next loads the row. */
export interface Config {
  /** Time limit in milliseconds for one provider's read, token renewal and response body included. */
  timeoutMs: number
  /** How long in milliseconds a read answers later opens and refreshes instead of a new request; 0 reads every time. */
  minRefreshIntervalMs: number
  /** GitHub Copilot quota reading. */
  copilot: ProviderReadConfig
  /** OpenAI Codex usage reading. */
  openaiCodex: ProviderReadConfig
  /** xAI credit usage reading. */
  xai: ProviderReadConfig
  /** OpenCode Go usage reading. */
  opencodeGo: OpenCodeGoConfig
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Remote serving the Settings page's provider usage rows. */
    providerUsage: ProviderUsageService
  }
}

/** The Config schema of one provider that needs only the common fields. */
function providerRead() {
  return z.object({
    enabled: z.boolean().default(true),
    endpoint: z.string().pattern(ENDPOINT_PATTERN),
  }).default({ enabled: true })
}

/** Reports each provider's usage to the Settings page. */
export default class ProviderUsageService extends TypertRemoteService {
  static inject = ['credentials', 'typert']
  static Config = z.object({
    timeoutMs: z.number().step(1).min(1).max(120_000).default(10_000),
    minRefreshIntervalMs: z.number().step(1).min(0).max(3_600_000).default(30_000),
    copilot: providerRead(),
    openaiCodex: providerRead(),
    xai: providerRead(),
    opencodeGo: z.object({
      enabled: z.boolean().default(true),
      endpoint: z.string().pattern(ENDPOINT_PATTERN),
      apiKeyEnvs: z.array(z.string().pattern(REF_NAME_PATTERN)).default(OPENCODE_API_KEY_ENVS),
    }).default({ enabled: true, apiKeyEnvs: OPENCODE_API_KEY_ENVS }),
  })

  /** Stops a shared read when the plugin unloads. */
  private readonly lifetime = new AbortController()
  /** The read every caller shares while it runs. */
  private reading: Promise<UsageReport> | undefined
  /** The last read still valid for its interval. */
  private recent: UsageReport | undefined
  /** Advances on each credential change, so a read that started before one is not retained. */
  private credentialGeneration = 0

  /**
   * @param ctx - Host context carrying the credentials service.
   * @param config - validated plugin config.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'providerUsage', { namespace: 'providerUsage' })
    ctx.effect(() => () => { this.lifetime.abort() }, 'ui-settings-usage: shared read')
    const forgetRecent = (): void => {
      this.credentialGeneration += 1
      this.recent = undefined
    }
    ctx.on('credentials/record-updated', forgetRecent)
    ctx.on('credentials/reference-updated', forgetRecent)
  }

  /**
   * Read every provider's usage for the Settings page, at most once per
   * `minRefreshIntervalMs` unless a credential changed. Callers share a running
   * read, and it finishes after they cancel so the next open can reuse it. A
   * provider's failure stays in its own row; no row carries a credential or
   * provider response text.
   * @param signal - browser cancellation or Remote contribution withdrawal; it stops this caller's wait only.
   * @returns one row per provider.
   */
  @Remote
  async report(signal: AbortSignal): Promise<UsageReport> {
    signal.throwIfAborted()
    const { recent } = this
    if (recent !== undefined && Date.now() - recent.readAt < this.config.minRefreshIntervalMs) return recent
    this.reading ??= this.readAll().finally(() => { this.reading = undefined })
    return untilAborted(this.reading, signal)
  }

  /** Read all four providers once, retaining the result unless a credential changed meanwhile. */
  private async readAll(): Promise<UsageReport> {
    const generation = this.credentialGeneration
    const { timeoutMs, copilot, openaiCodex, xai, opencodeGo } = this.config
    const limits = { timeoutMs, signal: this.lifetime.signal }
    const { credentials } = this.ctx
    const grants = { credentials, authorization: this.ctx.get('authorization') }
    const providers = await Promise.all([
      this.row('github-copilot', copilot.enabled, () => readCopilotUsage({ ...limits, credentials, endpoint: copilot.endpoint })),
      this.row('openai-codex', openaiCodex.enabled, () => readCodexUsage({ ...limits, ...grants, endpoint: openaiCodex.endpoint })),
      this.row('xai', xai.enabled, () => readXaiUsage({ ...limits, ...grants, endpoint: xai.endpoint })),
      this.row('opencode-go', opencodeGo.enabled, () => readOpenCodeGoUsage({
        ...limits, credentials, apiKeyEnvs: opencodeGo.apiKeyEnvs, endpoint: opencodeGo.endpoint,
      })),
    ])
    const report: UsageReport = { providers, readAt: Date.now() }
    if (generation === this.credentialGeneration) this.recent = report
    return report
  }

  /** Read one provider unless the profile turned it off, and log a failure by its code alone. */
  private async row(provider: UsageProviderId, enabled: boolean, read: () => Promise<ProviderUsage>): Promise<ProviderUsage> {
    if (!enabled) return { provider, status: 'unsupported', reason: 'disabled' }
    const row = await read()
    if (row.status === 'failed' || (row.status === 'sign-in-required' && row.reason === 'renewal-failed')) {
      this.ctx.logger.warn(`ui-settings-usage: ${provider} usage read failed (${row.reason})`)
    }
    return row
  }
}
