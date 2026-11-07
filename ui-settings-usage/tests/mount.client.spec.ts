/** The section and its Remote arrive together, in the active locale, and leave with the plugin. */

import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import { inject, mountUsage, NS } from '../src/client/mount.ts'
import type { UsageSectionInjected } from '../src/client/UsageSection.tsx'

const contribution: TypertRemoteContribution = { package: '@anago-harness/ui-settings-usage', descriptors: [] }

async function fixture() {
  const ctx = new Context()
  const unmount = vi.fn(async () => {})
  class TestRemote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(value: TypertRemoteContribution) {
      expect(value).toBe(contribution)
      return unmount
    }
  }
  new TestRemote()
  const report = vi.fn((_signal: AbortSignal) => Promise.resolve({
    ok: true,
    value: { providers: [{ provider: 'xai', status: 'unsupported', reason: 'disabled' }], readAt: 1_000 },
  }))
  ctx.provide('remote.providerUsage', { report } as never)
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
  return { ctx, report, unmount }
}

describe('mountUsage', () => {
  it('registers the section, localized, without reading until it opens', async () => {
    const b = await fixture()
    try {
      const dispose = await mountUsage(b.ctx, contribution)
      const [entry] = b.ctx.slots.entries('settings.section')
      expect(entry?.options).toMatchObject({ id: 'usage', order: 12 })
      expect(entry?.locale).toBe(NS)
      expect(resolveSlotLabel(entry?.options.label)).toBe('用量')
      expect(b.report).not.toHaveBeenCalled()
      await dispose()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('gives the section one stable face whose refresh reads the Remote', async () => {
    const b = await fixture()
    try {
      const dispose = await mountUsage(b.ctx, contribution)
      const entry = b.ctx.slots.entries('settings.section')[0]!
      const face = entry.inject!() as unknown as UsageSectionInjected
      expect(entry.inject!()).toBe(face)
      face.refresh()
      expect(b.report).toHaveBeenCalledOnce()
      await vi.waitFor(() => {
        expect(face.hooks.usageRows.getSnapshot()).toEqual([{ provider: 'xai', status: 'unsupported', reason: 'disabled' }])
      })
      expect(face.hooks.usageReadAt.getSnapshot()).toBe(1_000)
      await dispose()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('cancels the read in flight when the section closes', async () => {
    const b = await fixture()
    try {
      const dispose = await mountUsage(b.ctx, contribution)
      const face = b.ctx.slots.entries('settings.section')[0]!.inject!() as unknown as UsageSectionInjected
      b.report.mockImplementationOnce(() => new Promise(() => { /* Never settles; only cancellation is observed. */ }))
      face.refresh()
      face.cancel()
      expect(b.report.mock.calls[0]?.[0].aborted).toBe(true)
      await dispose()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('logs a failed Host read through the plugin logger without its text', async () => {
    const b = await fixture()
    try {
      const warn = vi.spyOn(b.ctx.logger, 'warn')
      const dispose = await mountUsage(b.ctx, contribution)
      const face = b.ctx.slots.entries('settings.section')[0]!.inject!() as unknown as UsageSectionInjected
      b.report.mockRejectedValueOnce(new Error('private detail'))
      face.refresh()
      await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('ui-settings-usage: the Host usage read failed') })
      await dispose()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('withdraws the section, cancels its read, and unmounts the Remote', async () => {
    const b = await fixture()
    try {
      const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountUsage(ctx, contribution) })
      await fiber
      const face = b.ctx.slots.entries('settings.section')[0]!.inject!() as unknown as UsageSectionInjected
      b.report.mockImplementationOnce(() => new Promise(() => { /* Never settles; only cancellation is observed. */ }))
      face.refresh()
      const signal = b.report.mock.calls[0]?.[0] as AbortSignal
      await fiber.dispose()
      expect(signal.aborted).toBe(true)
      expect(b.ctx.slots.entries('settings.section')).toHaveLength(0)
      expect(b.unmount).toHaveBeenCalledOnce()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('rolls back the Remote when the section cannot register', async () => {
    const b = await fixture()
    vi.spyOn(b.ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('registration failed') })
    try {
      await expect(mountUsage(b.ctx, contribution)).rejects.toThrow('registration failed')
      expect(b.unmount).toHaveBeenCalledOnce()
    } finally { await b.ctx.fiber.dispose() }
  })
})
