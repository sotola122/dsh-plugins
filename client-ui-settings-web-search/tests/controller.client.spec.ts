/** The two cards' shared controller: provider exclusivity, key writes, and the validation that blocks a save. */

import { describe, expect, it, vi } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError, stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import {
  BRAVE_API_KEY_REF, EXA_API_KEY_REF, WebSearchProviderCardController,
  type BraveSearchSettings, type ExaSearchSettings, type WebProviderSelection, type WebSearchProviderCardFace,
} from '../src/client/web-search-provider-card-controller.ts'

/** Make the stub behave like a Host that accepts every write. */
function acceptWrites<T>(host: StubConfigForm<T>): void {
  const section = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().value as object })
  const layer = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().user as object })
  host.mutate.mockImplementation((ops: readonly SettingsPathOpView[]) => {
    const value = { ...section() }
    const user = { ...layer() }
    for (const op of ops) {
      const field = op.path[0]!
      if (op.op === 'set') {
        value[field] = op.value
        user[field] = op.value
      } else {
        Reflect.deleteProperty(user, field)
        value[field] = (host.scope.getSnapshot().base as Record<string, unknown> | undefined)?.[field]
      }
    }
    host.publish({ value: value as T, user })
    return Promise.resolve(true)
  })
}

/** The controller's context, scripted down to the credentials namespace. */
function ctxWith(namespaces: object) {
  return { remote: namespaces } as never
}

/** A credentials answer for every requested reference. */
function credentialsApi(configured: boolean, writable = true) {
  const describe = vi.fn((refs: readonly string[]) => Promise.resolve({
    ok: true as const,
    value: Object.fromEntries(refs.map(ref => [ref, { configured, writable }])),
  }))
  const set = vi.fn(() => Promise.resolve({ ok: true as const, value: undefined }))
  return { ctx: ctxWith({ credentials: { describe, set } }), describe, set }
}

/**
 * Mount the controller over three stub scopes.
 * @param options - whether the Host accepts writes, the credential answer, and a scripted context.
 * @returns the scopes, the controller, the lazily started faces, and a state reader.
 */
function bench(options: { accept?: boolean; configured?: boolean; writable?: boolean; ctx?: never } = {}) {
  const web = stubConfigForm<WebProviderSelection>()
  const exa = stubConfigForm<ExaSearchSettings>()
  const brave = stubConfigForm<BraveSearchSettings>()
  if (options.accept === true) {
    acceptWrites(web)
    acceptWrites(exa)
    acceptWrites(brave)
  }
  const credentials = credentialsApi(options.configured ?? true, options.writable ?? true)
  const controller = new WebSearchProviderCardController(
    { web: web.scope, exa: exa.scope, brave: brave.scope }, options.ctx ?? credentials.ctx,
  )
  const faces = new Map<'exa' | 'brave', WebSearchProviderCardFace>()
  const face = (id: 'exa' | 'brave'): WebSearchProviderCardFace => {
    let existing = faces.get(id)
    if (existing === undefined) {
      existing = controller.inject(id)
      faces.set(id, existing)
    }
    return existing
  }
  return {
    web, exa, brave, credentials, controller, face,
    state: (id: 'exa' | 'brave') => face(id).hooks.webSearchProviderCard.getSnapshot(),
  }
}

/** Serve all three scopes, with the shipped Exa selection unless a scenario overrides it. */
type SelectionLayers = { value?: WebProviderSelection; base?: WebProviderSelection; user?: WebProviderSelection }

function serve(b: ReturnType<typeof bench>, selection: SelectionLayers = {}): void {
  b.web.publish({
    status: 'ready', writable: true, value: { searchProvider: 'exa' }, base: { searchProvider: 'exa' }, user: {},
    ...selection,
  })
  b.exa.publish({ status: 'ready', writable: true, value: { searchType: 'auto' }, base: {}, user: {} })
  b.brave.publish({
    status: 'ready', writable: true,
    value: { maxResults: 8, safesearch: 'moderate' }, base: { maxResults: 8, safesearch: 'moderate' }, user: {},
  })
}

describe('WebSearchProviderCardController selection', () => {
  it('derives both switches from the one staged selection', () => {
    const b = bench()
    serve(b)
    expect(b.state('exa')).toMatchObject({ enabled: true, switchAvailable: true })
    expect(b.state('brave')).toMatchObject({ enabled: false, switchAvailable: true })

    b.face('exa').setEnabled(false)

    // Turning Exa off selects Brave; the two cards report one provider.
    expect(b.state('exa')).toMatchObject({ enabled: false, dirty: true })
    expect(b.state('brave')).toMatchObject({ enabled: true, dirty: true })
    expect(b.web.mutate).not.toHaveBeenCalled()

    // Turning Brave off again selects Exa, which is already the composed value.
    b.face('brave').setEnabled(false)
    expect(b.state('exa')).toMatchObject({ enabled: true, dirty: false })
    expect(b.state('brave')).toMatchObject({ enabled: false, dirty: false })
    b.controller.dispose()
  })

  it('starts a card once and resets one field through its injected face', () => {
    const b = bench()
    serve(b)
    const face = b.face('exa')
    expect(b.controller.inject('exa').hooks).toEqual(face.hooks)

    face.edit('searchType', 'neural')
    expect(b.state('exa')).toMatchObject({ dirty: true, searchType: { text: 'neural' } })

    face.resetField('searchType')
    expect(b.state('exa')).toMatchObject({ dirty: false, searchType: { text: 'auto', overridden: false } })
    b.controller.dispose()
  })

  it('writes the staged provider only on save', async () => {
    const b = bench({ accept: true })
    serve(b)
    b.face('brave').setEnabled(true)
    expect(b.state('brave').enabled).toBe(true)
    expect(b.state('exa').enabled).toBe(false)
    b.face('brave').save()
    await vi.waitFor(() => { expect(b.state('brave').dirty).toBe(false) })
    expect(b.web.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['searchProvider'], value: 'brave' }], undefined)
    expect(b.state('brave').enabled).toBe(true)
    expect(b.state('exa').enabled).toBe(false)
    b.controller.dispose()
  })

  it('clears the override when the staged provider equals the composed value', async () => {
    const b = bench({ accept: true })
    serve(b, { value: { searchProvider: 'brave' }, user: { searchProvider: 'brave' } })
    expect(b.state('exa').enabled).toBe(false)

    b.face('exa').setEnabled(true)
    expect(b.state('exa').enabled).toBe(true)
    expect(b.state('brave').enabled).toBe(false)
    b.face('exa').save()

    await vi.waitFor(() => { expect(b.state('exa').dirty).toBe(false) })
    expect(b.web.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['searchProvider'] }], undefined)
    b.controller.dispose()
  })

  it('shows the switch disabled while the Host serves no web namespace', () => {
    const b = bench()
    serve(b)
    b.web.publish({ status: 'unavailable' })
    expect(b.state('exa')).toMatchObject({ available: true, switchAvailable: false, enabled: false })
    expect(b.state('exa').apiKey.text).toBe('')
    b.controller.dispose()
  })
})

describe('WebSearchProviderCardController credential', () => {
  it('writes the staged key through the credentials domain, never a settings section', async () => {
    const b = bench({ configured: false })
    serve(b)
    const exa = b.face('exa')
    exa.edit('apiKey', ' ex-secret ')
    expect(b.state('exa').dirty).toBe(true)
    expect(b.credentials.set).not.toHaveBeenCalled()

    b.credentials.describe.mockImplementation((refs: readonly string[]) => Promise.resolve({
      ok: true as const, value: Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])),
    }))
    exa.save()

    await vi.waitFor(() => { expect(b.credentials.set).toHaveBeenCalledWith(EXA_API_KEY_REF, 'ex-secret') })
    for (const host of [b.web, b.exa, b.brave]) expect(host.mutate).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(b.state('exa')).toMatchObject({ dirty: false, apiKeyConfigured: true }) })
    b.controller.dispose()
  })

  it('addresses each provider its own reference', async () => {
    const b = bench()
    serve(b)
    const brave = b.face('brave')
    brave.edit('apiKey', 'br-secret')
    brave.save()
    await vi.waitFor(() => { expect(b.credentials.set).toHaveBeenCalledWith(BRAVE_API_KEY_REF, 'br-secret') })
    b.controller.dispose()
  })

  it('keeps the stored key when the draft is left blank', () => {
    const b = bench()
    serve(b)
    const exa = b.face('exa')
    exa.edit('apiKey', '   ')
    expect(b.state('exa').dirty).toBe(false)
    exa.save()
    expect(b.credentials.set).not.toHaveBeenCalled()
    b.controller.dispose()
  })

  it('re-reads only a started card whose reference the Host reports', async () => {
    const b = bench({ configured: false })
    serve(b)
    b.face('exa')
    await vi.waitFor(() => { expect(b.credentials.describe).toHaveBeenCalled() })
    b.credentials.describe.mockClear()

    b.controller.refreshCredential(BRAVE_API_KEY_REF)
    expect(b.credentials.describe).not.toHaveBeenCalled()

    b.credentials.describe.mockImplementation((refs: readonly string[]) => Promise.resolve({
      ok: true as const, value: Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])),
    }))
    b.controller.refreshCredential(EXA_API_KEY_REF)
    await vi.waitFor(() => { expect(b.state('exa').apiKeyConfigured).toBe(true) })
    b.controller.dispose()
  })

  it('drops an answer that describes another reference', async () => {
    type Answer = { ok: true; value: Record<string, { configured: boolean; writable: boolean }> }
    let answer: ((value: Answer) => void) | undefined
    const describe = vi.fn(() => new Promise<Answer>((resolve) => { answer = resolve }))
    const b = bench({ ctx: ctxWith({ credentials: { describe, set: vi.fn() } }) })
    serve(b)
    b.face('exa')
    // The section renames its reference while the first read is pending.
    b.exa.publish({ value: { apiKeyEnv: 'RENAMED_KEY', searchType: 'auto' } })
    await vi.waitFor(() => { expect(describe).toHaveBeenLastCalledWith(['RENAMED_KEY']) })

    answer?.({ ok: true, value: { [EXA_API_KEY_REF]: { configured: true, writable: true } } })
    await Promise.resolve()

    expect(b.state('exa').apiKeyConfigured).toBe(false)
    b.controller.dispose()
  })

  it('disables the key control when the reference is not writable', async () => {
    const b = bench({ configured: true, writable: false })
    serve(b)
    b.face('exa')
    await vi.waitFor(() => { expect(b.state('exa').apiKeyWritable).toBe(false) })
    b.controller.dispose()
  })

  it('keeps the card usable when the credential read is refused', async () => {
    const refusal = () => Promise.resolve({
      ok: false as const,
      error: new RemoteError('credential/rejected', 'offline', { ref: EXA_API_KEY_REF }),
    })
    const b = bench({ ctx: ctxWith({ credentials: { describe: vi.fn(refusal), set: vi.fn(refusal) } }) })
    serve(b)
    const exa = b.face('exa')
    await Promise.resolve()
    expect(b.state('exa')).toMatchObject({ available: true, apiKeyConfigured: false, apiKeyWritable: true })
    exa.edit('apiKey', 'ex-secret')
    exa.save()
    b.controller.dispose()
  })
})

describe('WebSearchProviderCardController fields', () => {
  it('saves the Exa search type before the selection', async () => {
    const b = bench({ accept: true })
    serve(b)
    const exa = b.face('exa')
    exa.edit('searchType', 'neural')
    exa.save()
    await vi.waitFor(() => { expect(b.state('exa').dirty).toBe(false) })
    expect(b.exa.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['searchType'], value: 'neural' },
    ], undefined)
    b.controller.dispose()
  })

  it('saves Brave result bound and safe search', async () => {
    const b = bench({ accept: true })
    serve(b)
    const brave = b.face('brave')
    brave.edit('maxResults', '12')
    brave.edit('safesearch', 'strict')
    brave.save()
    await vi.waitFor(() => { expect(b.state('brave').dirty).toBe(false) })
    expect(b.brave.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['maxResults'], value: 12 },
      { op: 'set', path: ['safesearch'], value: 'strict' },
    ], undefined)
    b.controller.dispose()
  })

  it('defaults the select fields to the composed provider defaults', () => {
    const b = bench()
    serve(b)
    const exa = b.state('exa')
    const brave = b.state('brave')
    if (exa.provider !== 'exa' || brave.provider !== 'brave') throw new Error('unexpected card provider')
    expect(exa.searchType).toEqual({ text: 'auto', overridden: false, invalid: false })
    expect(brave.safesearch).toEqual({ text: 'moderate', overridden: false, invalid: false })
    b.controller.dispose()
  })

  it.each([
    ['exa', 'searchType', 'semantic'],
    ['brave', 'maxResults', '0'],
    ['brave', 'maxResults', '21'],
    ['brave', 'maxResults', '1.5'],
  ] as const)('blocks the save of an unsupported %s.%s: %s', (id, field, text) => {
    const b = bench()
    serve(b)
    const face = b.face(id)
    face.edit(field, text)
    expect(b.state(id)).toMatchObject({ invalid: true, switchBlocked: true })
    face.save()
    expect(b[id].mutate).not.toHaveBeenCalled()
    expect(b.credentials.set).not.toHaveBeenCalled()
    b.controller.dispose()
  })

  it.each([
    ['exa', 'searchType', 'neural', 'neural'],
    ['brave', 'maxResults', '20', 20],
    ['brave', 'maxResults', '', undefined],
  ] as const)('saves or clears a supported %s.%s: %j', async (id, field, text, stored) => {
    const b = bench({ accept: true })
    serve(b)
    const face = b.face(id)
    face.edit(field, text)
    expect(b.state(id).invalid).toBe(false)
    face.save()
    await vi.waitFor(() => { expect(b.state(id).dirty).toBe(false) })
    expect(b[id].mutate).toHaveBeenCalledWith([
      stored === undefined ? { op: 'unset', path: [field] } : { op: 'set', path: [field], value: stored },
    ], undefined)
    b.controller.dispose()
  })

  it('drops drafts on discard and locks the switch while an invalid edit is staged', () => {
    const b = bench()
    serve(b)
    const exa = b.face('exa')
    exa.edit('searchType', 'semantic')
    expect(b.state('exa')).toMatchObject({ invalid: true, switchBlocked: true })
    exa.discard()
    expect(b.state('exa')).toMatchObject({ invalid: false, switchBlocked: false, dirty: false })
    b.controller.dispose()
  })

  it('releases every subscription on dispose', () => {
    const b = bench()
    serve(b)
    b.face('exa')
    b.controller.dispose()
    for (const host of [b.web, b.exa, b.brave]) expect(host.listenerCount()).toBe(0)
  })
})
