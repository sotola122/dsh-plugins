/**
 * Mirror Session write ownership into the composer block registry.
 *
 * The Host probes each listed Session's write lease. A Session another process
 * holds gets a composer block that locks every control which would resume an
 * Agent, so the page cannot become a second writer; every other answer clears
 * the block this watcher raised. Only its own blocks are cleared, so a block
 * another plugin owns survives a poll, and a failed probe leaves the last known
 * ownership in place.
 * @module @anago-harness/client-ui-session-share/src/client/session-ownership-watcher
 */

import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ComposerBlocks } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId, SessionOwnership } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Maximum Sessions one ownership probe may name. The Host rejects a longer
 * request, so the watcher probes the first listed Sessions and keeps the rest
 * at their last known state.
 */
export const OWNERSHIP_PROBE_LIMIT = 200

/** The faces the watcher reads and writes, assembled by the plugin's `apply`. */
export interface SessionOwnershipWatcherOptions {
  /** The browser's Session catalog snapshot and change notifications. */
  readonly list: ObservableSnapshot<SessionListState>
  /** The per-Session composer block registry. */
  readonly blocks: ComposerBlocks
  /** Host ownership probe reached as `ctx.remote.session.ownership`. */
  readonly ownership: (
    ids: readonly SessionId[],
  ) => Promise<RemoteResult<Record<SessionId, SessionOwnership>>>
  /** Localized block reason, read when a block is raised. */
  readonly reason: () => string
  /** Milliseconds between ownership probes. */
  readonly pollMs: number
}

/**
 * Poll Session ownership and keep the composer blocked exactly while another
 * process holds the Session's write lease.
 *
 * One probe runs at a time: a poll that starts during an in-flight probe shares
 * it, and a poll that starts after {@link dispose} does nothing. A failed probe
 * reports once per failure streak and changes no block.
 */
export class SessionOwnershipWatcher {
  private readonly blocked = new Set<SessionId>()
  private inFlight: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private stopList: (() => void) | undefined
  private started = false
  private stopped = false
  private failing = false

  /** @param options - the catalog, block registry, probe, reason, and interval to use. */
  constructor(private readonly options: SessionOwnershipWatcherOptions) {}

  /**
   * Probe now and start following the catalog and the poll interval. Repeat
   * calls are no-ops, so one plugin lifetime owns at most one subscription and
   * one timer.
   */
  start(): void {
    if (this.started) return
    this.started = true
    this.stopList = this.options.list.subscribe(() => { void this.refresh() })
    this.timer = setInterval(() => { void this.refresh() }, this.options.pollMs)
    void this.refresh()
  }

  /**
   * Probe Session ownership now.
   * @returns completion of this probe, or of the one already running.
   */
  refresh(): Promise<void> {
    if (this.stopped || this.inFlight !== undefined) {
      return this.inFlight ?? Promise.resolve()
    }
    const run = this.probe().finally(() => { this.inFlight = undefined })
    this.inFlight = run
    return run
  }

  /**
   * Stop polling and clear every block this watcher raised. Idempotent; an
   * in-flight probe answers late but applies nothing.
   */
  dispose(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.stopList?.()
    this.stopList = undefined
    for (const id of this.blocked) this.options.blocks.set(id, undefined)
    this.blocked.clear()
  }

  /** Run one probe and mirror a successful answer into the block registry. */
  private async probe(): Promise<void> {
    const ids = this.options.list.getSnapshot().ids
    const probed = ids.slice(0, OWNERSHIP_PROBE_LIMIT)
    if (probed.length === 0) {
      this.clearUnlisted(ids)
      return
    }
    let answer: Record<SessionId, SessionOwnership>
    try {
      const result = await this.options.ownership(probed)
      if (!result.ok) {
        this.reportFailure(result.error)
        return
      }
      answer = result.value
    } catch (error) {
      this.reportFailure(error)
      return
    }
    this.failing = false
    if (this.stopped) return
    for (const id of probed) this.mirror(id, answer[id] ?? 'unknown')
    this.clearUnlisted(ids)
  }

  /**
   * Raise or clear one Session's block from its ownership answer.
   * @param id - the probed Session.
   * @param ownership - the Host's answer for that Session.
   */
  private mirror(id: SessionId, ownership: SessionOwnership): void {
    if (ownership === 'held-elsewhere') {
      if (this.blocked.has(id)) return
      this.blocked.add(id)
      this.options.blocks.set(id, { reason: this.options.reason(), lock: 'all' })
      return
    }
    if (!this.blocked.delete(id)) return
    this.options.blocks.set(id, undefined)
  }

  /**
   * Clear blocks whose Session left the catalog, so a removed row leaves no
   * stale reason behind.
   * @param listed - Session ids in the catalog snapshot this probe read.
   */
  private clearUnlisted(listed: readonly SessionId[]): void {
    if (this.blocked.size === 0) return
    const present = new Set(listed)
    for (const id of [...this.blocked]) {
      if (present.has(id)) continue
      this.blocked.delete(id)
      this.options.blocks.set(id, undefined)
    }
  }

  /**
   * Report a failure once per streak, keeping the last known ownership.
   * @param cause - transport or business error that ended the probe.
   */
  private reportFailure(cause: unknown): void {
    if (this.failing) return
    this.failing = true
    console.warn('[session-share] ownership probe failed; keeping the last known ownership:', cause)
  }
}
