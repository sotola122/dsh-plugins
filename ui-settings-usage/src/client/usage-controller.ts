/**
 * The Usage section's read lifecycle: one Remote read at a time, started when
 * the section opens, with its result published to every row.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ProviderUsage, UsageProviderId, UsageReport } from '../types.ts'

/** What one provider row renders. */
export type UsageRow =
  | ProviderUsage
  | { readonly provider: UsageProviderId; readonly status: 'loading' }
  /** The Host call itself failed, so no provider produced a row. */
  | { readonly provider: UsageProviderId; readonly status: 'failed'; readonly reason: 'host-unavailable' }

/** Every provider in display order, shown before the Host answers. */
const PROVIDERS: readonly UsageProviderId[] = ['github-copilot', 'openai-codex', 'xai', 'opencode-go']

/** Owns the section's rows and its in-flight Remote read. */
export class UsageController {
  /** The rows the section renders. */
  readonly rows: SnapshotStore<readonly UsageRow[]> = createSnapshotStore<readonly UsageRow[]>(
    PROVIDERS.map(provider => ({ provider, status: 'loading' })),
  )
  /** Epoch milliseconds when the shown rows were read; undefined while none are shown. */
  readonly readAt: SnapshotStore<number | undefined> = createSnapshotStore<number | undefined>(undefined)
  private active: AbortController | undefined

  /**
   * @param read - the Remote read, reached as `ctx.remote.providerUsage.report`.
   * @param warn - reports a failed Host call; it receives no response text.
   */
  constructor(
    private readonly read: (signal: AbortSignal) => Promise<RemoteResult<UsageReport>>,
    private readonly warn: (message: string) => void,
  ) {}

  /**
   * Show every row as loading and read again, superseding any read in flight.
   * @returns settlement after the rows are published or the read was superseded.
   */
  async refresh(): Promise<void> {
    this.active?.abort()
    const lifetime = new AbortController()
    this.active = lifetime
    this.rows.set(PROVIDERS.map(provider => ({ provider, status: 'loading' })))
    this.readAt.set(undefined)
    let report: UsageReport | undefined
    try {
      const result = await this.read(lifetime.signal)
      if (result.ok) report = result.value
    } catch (_error) {
      // A cancelled or dropped call settles the same way below; its text is not shown.
      report = undefined
    }
    if (lifetime.signal.aborted) return
    if (report === undefined) this.warn('ui-settings-usage: the Host usage read failed')
    this.rows.set(report?.providers ?? PROVIDERS.map(provider => ({ provider, status: 'failed', reason: 'host-unavailable' })))
    this.readAt.set(report?.readAt)
  }

  /** Abandon the read in flight; a late answer publishes nothing. */
  cancel(): void {
    this.active?.abort()
  }
}
