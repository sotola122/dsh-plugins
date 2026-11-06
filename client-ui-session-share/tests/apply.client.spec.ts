/** Plugin wiring: the declared services, the localized block it raises, and what unload clears. */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId, SessionOwnership } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import { apply as hostApply } from '../src/index.ts'

/** English copy of the block reason, read from the shipped dictionary. */
const EN_REASON = en['composer.heldElsewhere']

/** Brand a plain test id the way the Session layer does. */
function id(value: string): SessionId {
  return value as SessionId
}

/** One successful Host ownership answer. */
function answer(state: SessionOwnership): { ok: true; value: Record<SessionId, SessionOwnership> } {
  return { ok: true, value: { [id('a')]: state } }
}

/** Replace the catalog snapshot with exactly these ids. */
function catalog(list: ReturnType<typeof createSnapshotStore<SessionListState>>, ...values: SessionId[]): void {
  list.set({
    ids: values,
    byId: Object.fromEntries(values.map(value => [value, {
      id: value,
      displayTitle: value,
      running: false,
      blank: false,
      updatedAt: 0,
      retainedBy: {},
    }])),
    phase: 'ready',
    projectionsBySession: {},
  })
}

/** A browser bench: the real locale service plus the faces the plugin injects. */
function bench() {
  const ctx = new Context()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const list = createSnapshotStore<SessionListState>({
    ids: [], byId: {}, phase: 'ready', projectionsBySession: {},
  })
  ctx.provide('sessions', { list } as never)
  const set = vi.fn()
  ctx.provide('conversation', { blocks: { set } } as never)
  const ownership = vi.fn()
  new TestRemote(ctx, { session: { ownership } })
  return { ctx, locale, list, set, ownership }
}

describe('client-ui-session-share apply', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    // `remote` itself is required: the property proxy rejects `ctx.remote`
    // without it, even when `remote.session` is also injected.
    expect(inject).toEqual(['remote', 'remote.session', 'sessions', 'conversation', 'locale'])
  })

  it('registers both dictionaries for the plugin lifetime', async () => {
    const { ctx, locale } = bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const t = locale.bind(NS)

    expect(t('composer.heldElsewhere')).toBe(EN_REASON)
    locale.setLocale('zh')
    expect(t('composer.heldElsewhere')).toBe(zh['composer.heldElsewhere'])

    await fiber.dispose()
    expect(t('composer.heldElsewhere')).toBe('composer.heldElsewhere')
  })

  it('raises the localized lock-all block and clears it when the lease moves', async () => {
    const { ctx, list, set, ownership } = bench()
    catalog(list, id('a'))
    ownership.mockResolvedValue(answer('held-elsewhere'))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    await vi.waitFor(() => {
      expect(set).toHaveBeenCalledWith(id('a'), { reason: EN_REASON, lock: 'all' })
    })

    ownership.mockResolvedValue(answer('free'))
    catalog(list, id('a'))
    await vi.waitFor(() => {
      expect(set).toHaveBeenCalledWith(id('a'), undefined)
    })

    await fiber.dispose()
  })

  it('raises the copy of the active locale', async () => {
    const { ctx, locale, list, set, ownership } = bench()
    locale.setLocale('zh')
    catalog(list, id('a'))
    ownership.mockResolvedValue(answer('held-elsewhere'))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    await vi.waitFor(() => {
      expect(set).toHaveBeenCalledWith(id('a'), {
        reason: zh['composer.heldElsewhere'],
        lock: 'all',
      })
    })

    await fiber.dispose()
  })

  it('clears every raised block and stops polling on unload', async () => {
    const { ctx, list, set, ownership } = bench()
    catalog(list, id('a'))
    ownership.mockResolvedValue(answer('held-elsewhere'))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => {
      expect(set).toHaveBeenCalledWith(id('a'), { reason: EN_REASON, lock: 'all' })
    })
    const probes = ownership.mock.calls.length
    set.mockClear()

    await fiber.dispose()
    catalog(list, id('a'), id('b'))
    await Promise.resolve()

    expect(set).toHaveBeenCalledWith(id('a'), undefined)
    expect(set).toHaveBeenCalledTimes(1)
    expect(ownership).toHaveBeenCalledTimes(probes)
  })

  it('polls at the configured interval', async () => {
    vi.useFakeTimers()
    const { ctx, list, ownership } = bench()
    catalog(list, id('a'))
    ownership.mockResolvedValue(answer('free'))
    const fiber = ctx.plugin({ inject: [...inject], apply }, { ownerPollMs: 25 })
    await vi.advanceTimersByTimeAsync(0)
    expect(ownership).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(25)
    expect(ownership).toHaveBeenCalledTimes(2)

    await fiber.dispose()
  })
})
