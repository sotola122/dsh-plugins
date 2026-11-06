/** What the browser half registers, when, which credential each card watches, and that it all leaves with the fiber. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, NS } from '../src/client/index.ts'
import type { WebSearchProviderCardFace } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

/** One Host view of a served namespace. */
function view(ns: string, revision = 0) {
  return { ns, schema: {}, value: {}, applies: 'live', secrets: [], revision }
}

/** @param served - namespaces the Host describes; omitted answers a failed read. */
async function bench(served?: string[]) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const describeCredentials = vi.fn(() => Promise.resolve({
    ok: false, error: new RemoteError('gateway/internal', 'no provider', {}),
  }))
  const describeSettings = vi.fn(() => Promise.resolve(served === undefined
    ? { ok: false, error: new RemoteError('gateway/internal', 'no provider', {}) }
    : { ok: true, value: { writable: true, hasDocument: true, namespaces: served.map(ns => view(ns)) } }))
  const remote = new TestRemote(ctx, {
    credentials: { describe: describeCredentials, set: vi.fn() },
    settings: { describe: describeSettings },
  })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, describeCredentials, describeSettings, remote }
}

/** The Plugins page's item slot, as its owner declares it. */
function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'plugins.item': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('client-ui-settings-web-search-providers apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.credentials', 'configForms'])
  })

  it('registers the Exa card while the Host serves its namespace, titled in the active locale', async () => {
    const { ctx, slots } = await bench(['web-search-exa', 'web'])
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    const entry = slots.entries('plugins.item')[0]!
    expect(entry.options).toMatchObject({ id: 'web-search-exa', order: 20 })
    expect(resolveSlotLabel(entry.options.label)).toBe('Exa 搜索')
    expect(entry.locale).toBe(NS)
    const face = (entry.inject as () => Pick<WebSearchProviderCardFace, 'hooks'>)()
    expect(Object.keys(face.hooks)).toEqual(['webSearchProviderCard'])
  })

  it('registers both cards when the Host serves both namespaces', async () => {
    const { ctx, slots } = await bench(['web-search-exa', 'web-search-brave', 'web'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(2) })
    const entries = slots.entries('plugins.item')
    expect(entries.map(entry => entry.options.id)).toEqual(['web-search-exa', 'web-search-brave'])
    expect(entries.map(entry => entry.options.order)).toEqual([20, 21])
    expect(entries.map(entry => resolveSlotLabel(entry.options.label))).toEqual(['Exa 搜索', 'Brave 搜索'])
  })

  it('registers only the Brave card when only its namespace is served', async () => {
    const { ctx, slots } = await bench(['web-search-brave', 'web'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    expect(slots.entries('plugins.item')[0]!.options.id).toBe('web-search-brave')
  })

  it('registers nothing while neither provider namespace is served', async () => {
    const { ctx, slots, describeSettings } = await bench(['web', 'shell'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })

    expect(slots.entries('plugins.item')).toHaveLength(0)
  })

  it('re-reads the credential when the Host reports the watched reference changed, and ignores another', async () => {
    const { ctx, slots, describeCredentials, remote } = await bench(['web-search-exa', 'web'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    // The card's inject face starts the credential read.
    ;(slots.entries('plugins.item')[0]!.inject as () => void)()
    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalled() })
    describeCredentials.mockClear()

    remote.emit('credentials/reference-updated', ['SOME_OTHER_KEY'])
    await Promise.resolve()
    expect(describeCredentials).not.toHaveBeenCalled()

    remote.emit('credentials/reference-updated', ['EXA_API_KEY'])
    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalledTimes(1) })
  })

  it('collapses both pages on teardown', async () => {
    const { ctx, slots } = await bench(['web-search-exa', 'web-search-brave', 'web'])
    declareRoot(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(2) })

    await fiber.dispose()

    expect(slots.entries('plugins.item')).toHaveLength(0)
  })
})
