/** The section's read lifecycle: loading rows, Host failures, and answers that arrive too late. */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { UsageReport } from '../src/types.ts'
import { UsageController } from '../src/client/usage-controller.ts'

const REPORT: UsageReport = { providers: [{ provider: 'xai', status: 'unsupported', reason: 'no-usage-endpoint' }] }
const ok = (value: UsageReport): RemoteResult<UsageReport> => ({ ok: true, value })

function bench(read: (signal: AbortSignal) => Promise<RemoteResult<UsageReport>>) {
  const warn = vi.fn()
  return { controller: new UsageController(read, warn), warn }
}

describe('UsageController', () => {
  it('starts with a loading row per provider and sends nothing until asked', () => {
    const read = vi.fn(() => Promise.resolve(ok(REPORT)))
    const { controller } = bench(read)
    expect(controller.rows.getSnapshot().map(row => [row.provider, row.status])).toEqual([
      ['github-copilot', 'loading'], ['openai-codex', 'loading'], ['xai', 'loading'], ['opencode-go', 'loading'],
    ])
    expect(read).not.toHaveBeenCalled()
  })

  it('publishes the Host rows', async () => {
    const { controller, warn } = bench(() => Promise.resolve(ok(REPORT)))
    await controller.refresh()
    expect(controller.rows.getSnapshot()).toEqual(REPORT.providers)
    expect(warn).not.toHaveBeenCalled()
  })

  it.each<[string, () => Promise<RemoteResult<UsageReport>>]>([
    ['refused', () => Promise.resolve({ ok: false, error: new RemoteError('gateway/internal', 'private detail', {}) })],
    ['thrown', () => Promise.reject(new Error('private detail'))],
  ])('fails every row without quoting a %s Host call', async (_name, read) => {
    const { controller, warn } = bench(read)
    await controller.refresh()
    const rows = controller.rows.getSnapshot()
    expect(rows).toHaveLength(4)
    expect(new Set(rows.map(row => row.status))).toEqual(new Set(['failed']))
    expect(JSON.stringify(rows)).toContain('host-unavailable')
    expect(JSON.stringify([rows, warn.mock.calls])).not.toContain('private detail')
    expect(warn).toHaveBeenCalledOnce()
  })

  it('shows loading again on refresh and lets a newer read supersede an older one', async () => {
    const first = Promise.withResolvers<RemoteResult<UsageReport>>()
    const signals: AbortSignal[] = []
    const read = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return signals.length === 1 ? first.promise : Promise.resolve(ok(REPORT))
    })
    const { controller } = bench(read)
    const older = controller.refresh()
    await controller.refresh()
    expect(signals[0]?.aborted).toBe(true)
    first.resolve(ok({ providers: [{ provider: 'xai', status: 'failed', reason: 'network' }] }))
    await older
    expect(controller.rows.getSnapshot()).toEqual(REPORT.providers)
  })

  it.each(['resolve', 'reject'] as const)('publishes nothing when a cancelled read later settles with %s', async (outcome) => {
    const pending = Promise.withResolvers<RemoteResult<UsageReport>>()
    const { controller, warn } = bench(() => pending.promise)
    const task = controller.refresh()
    controller.cancel()
    if (outcome === 'resolve') pending.resolve(ok(REPORT))
    else pending.reject(new Error('cancelled'))
    await task
    expect(controller.rows.getSnapshot().every(row => row.status === 'loading')).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('tolerates a cancel with no read in flight', () => {
    const { controller } = bench(() => Promise.resolve(ok(REPORT)))
    expect(() => { controller.cancel() }).not.toThrow()
  })
})
