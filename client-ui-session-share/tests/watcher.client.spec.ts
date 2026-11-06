/** Ownership polling: what it blocks, what it clears, and what a failed probe leaves alone. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId, SessionOwnership } from '@deepseek-ai/dsh-session/types'
import {
  OWNERSHIP_PROBE_LIMIT, SessionOwnershipWatcher,
} from '../src/client/session-ownership-watcher.ts'

/** The localized reason the bench's translate function returns. */
const REASON = 'This Session is open for writing in another process.'

/** Brand plain test ids the way the Session layer does. */
function ids(...values: string[]): SessionId[] {
  return values.map(value => value as SessionId)
}

/** One successful Host ownership answer. */
function answer(states: readonly (readonly [string, SessionOwnership])[]): {
  ok: true
  value: Record<SessionId, SessionOwnership>
} {
  return {
    ok: true,
    value: Object.fromEntries(states.map(([id, state]) => [id as SessionId, state])),
  }
}

/** Replace the catalog snapshot with exactly these ids. */
function catalog(list: ReturnType<typeof createSnapshotStore<SessionListState>>, ...values: SessionId[]): void {
  list.set({
    ids: values,
    byId: Object.fromEntries(values.map(id => [id, {
      id,
      displayTitle: id,
      running: false,
      blank: false,
      updatedAt: 0,
      retainedBy: {},
    }])),
    phase: 'ready',
    projectionsBySession: {},
  })
}

/** A watcher over a real catalog store, a recording block registry, and a scripted probe. */
function bench(pollMs = 1000) {
  const list = createSnapshotStore<SessionListState>({
    ids: [], byId: {}, phase: 'ready', projectionsBySession: {},
  })
  const set = vi.fn()
  const ownership = vi.fn()
  const watcher = new SessionOwnershipWatcher({
    list,
    blocks: { set } as never,
    ownership,
    reason: () => REASON,
    pollMs,
  })
  return { list, set, ownership, watcher }
}

describe('SessionOwnershipWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('raises a lock-all block for a Session another process holds', async () => {
    const { list, set, ownership, watcher } = bench()
    catalog(list, ...ids('a', 'b'))
    ownership.mockResolvedValue(answer([['a', 'free'], ['b', 'held-elsewhere']]))

    await watcher.refresh()

    expect(ownership).toHaveBeenCalledWith(ids('a', 'b'))
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith(ids('b')[0], { reason: REASON, lock: 'all' })
  })

  it('clears its block when the other process releases the lease', async () => {
    const { list, set, ownership, watcher } = bench()
    catalog(list, ...ids('a'))
    ownership.mockResolvedValue(answer([['a', 'held-elsewhere']]))
    await watcher.refresh()
    set.mockClear()

    ownership.mockResolvedValue(answer([['a', 'free']]))
    await watcher.refresh()

    expect(set).toHaveBeenCalledWith(ids('a')[0], undefined)
  })

  it('keeps its raised block while the Session stays held', async () => {
    const { list, set, ownership, watcher } = bench()
    catalog(list, ...ids('a'))
    ownership.mockResolvedValue(answer([['a', 'held-elsewhere']]))
    await watcher.refresh()
    set.mockClear()

    await watcher.refresh()

    expect(ownership).toHaveBeenCalledTimes(2)
    expect(set).not.toHaveBeenCalled()
  })

  it('never clears a Session another plugin blocked', async () => {
    const { list, set, ownership, watcher } = bench()
    catalog(list, ...ids('a', 'b'))
    ownership.mockResolvedValue(answer([['a', 'free'], ['b', 'free']]))

    await watcher.refresh()

    expect(set).not.toHaveBeenCalled()
  })

  it('keeps the last state and reports once when the probe rejects', async () => {
    const { list, set, ownership, watcher } = bench()
    catalog(list, ...ids('a'))
    ownership.mockResolvedValue(answer([['a', 'held-elsewhere']]))
    await watcher.refresh()
    set.mockClear()

    ownership.mockRejectedValue(new Error('connection lost'))
    await watcher.refresh()
    await watcher.refresh()

    expect(set).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledTimes(1)

    ownership.mockResolvedValue(answer([['a', 'free']]))
    await watcher.refresh()
    expect(set).toHaveBeenCalledWith(ids('a')[0], undefined)
  })

  it('keeps the last state when the Host reports a business failure', async () => {
    const { list, set, ownership, watcher } = bench()
    catalog(list, ...ids('a'))
    ownership.mockResolvedValue(answer([['a', 'held-elsewhere']]))
    await watcher.refresh()
    set.mockClear()

    ownership.mockResolvedValue({
      ok: false,
      error: { code: 'gateway/internal', message: 'probe failed', data: {} },
    })
    await watcher.refresh()

    expect(set).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('treats an id the Host omitted as undecided and clears its block', async () => {
    const { list, set, ownership, watcher } = bench()
    catalog(list, ...ids('a'))
    ownership.mockResolvedValue(answer([['a', 'held-elsewhere']]))
    await watcher.refresh()
    set.mockClear()

    ownership.mockResolvedValue(answer([]))
    await watcher.refresh()

    expect(set).toHaveBeenCalledWith(ids('a')[0], undefined)
  })

  it('clears the block of a Session that left the catalog', async () => {
    const { list, set, ownership, watcher } = bench()
    catalog(list, ...ids('a'))
    ownership.mockResolvedValue(answer([['a', 'held-elsewhere']]))
    await watcher.refresh()
    set.mockClear()

    catalog(list)
    await watcher.refresh()

    expect(ownership).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith(ids('a')[0], undefined)
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('probes at most the Host allowance', async () => {
    const { list, ownership, watcher } = bench()
    const many = Array.from({ length: OWNERSHIP_PROBE_LIMIT + 1 }, (_, index) => `s${index}` as SessionId)
    catalog(list, ...many)
    ownership.mockResolvedValue(answer(many.map(id => [id, 'free'] as [SessionId, SessionOwnership])))

    await watcher.refresh()

    expect(ownership).toHaveBeenCalledTimes(1)
    expect((ownership.mock.calls[0]?.[0] as SessionId[]).length).toBe(OWNERSHIP_PROBE_LIMIT)
  })

  it('does not probe while the catalog is empty', async () => {
    const { ownership, watcher } = bench()

    await watcher.refresh()

    expect(ownership).not.toHaveBeenCalled()
  })

  it('shares one in-flight probe between concurrent callers', async () => {
    const { list, ownership, watcher } = bench()
    catalog(list, ...ids('a'))
    const gate = Promise.withResolvers<ReturnType<typeof answer>>()
    ownership.mockReturnValue(gate.promise)

    const first = watcher.refresh()
    const second = watcher.refresh()
    expect(second).toBe(first)
    gate.resolve(answer([['a', 'free']]))
    await Promise.all([first, second])

    expect(ownership).toHaveBeenCalledTimes(1)
  })

  it('polls on start, on the interval, and on a catalog change', async () => {
    const { list, ownership, watcher } = bench(500)
    catalog(list, ...ids('a'))
    ownership.mockResolvedValue(answer([['a', 'free']]))

    watcher.start()
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(ownership).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(500)
    expect(ownership).toHaveBeenCalledTimes(2)

    catalog(list, ...ids('a', 'b'))
    await vi.advanceTimersByTimeAsync(0)
    expect(ownership).toHaveBeenCalledTimes(3)
  })

  it('clears every raised block and stops polling on dispose', async () => {
    const { list, set, ownership, watcher } = bench(500)
    catalog(list, ...ids('a'))
    ownership.mockResolvedValue(answer([['a', 'held-elsewhere']]))
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    set.mockClear()

    watcher.dispose()
    await vi.advanceTimersByTimeAsync(1000)
    catalog(list, ...ids('a', 'b'))

    expect(set).toHaveBeenCalledWith(ids('a')[0], undefined)
    expect(set).toHaveBeenCalledTimes(1)
    await expect(watcher.refresh()).resolves.toBeUndefined()
    expect(ownership).toHaveBeenCalledTimes(1)
  })

  it('disposes without ever starting', async () => {
    const { set, ownership, watcher } = bench()

    expect(() => { watcher.dispose() }).not.toThrow()
    await expect(watcher.refresh()).resolves.toBeUndefined()
    expect(ownership).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('ignores an answer that arrives after dispose', async () => {
    const { list, set, ownership, watcher } = bench()
    catalog(list, ...ids('a'))
    const gate = Promise.withResolvers<ReturnType<typeof answer>>()
    ownership.mockReturnValue(gate.promise)

    const probe = watcher.refresh()
    watcher.dispose()
    gate.resolve(answer([['a', 'held-elsewhere']]))
    await probe

    expect(set).not.toHaveBeenCalled()
  })
})
