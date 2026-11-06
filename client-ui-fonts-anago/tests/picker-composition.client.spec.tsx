// @vitest-environment jsdom
/**
 * The picker through the shipped pieces: the real slot registry and renderer,
 * the locale service, ui-settings, and ui-theme's own font rows. Only the Host
 * settings transport is stubbed, so a selection is observed as the settings
 * mutation it sends, and unloading the plugin returns each row to its text field.
 */
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '../../../packages/client/locale/src/client/index.ts'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '../../../packages/client/ui-settings/src/client/index.ts'
import { apply as themeApply, inject as themeInject } from '../../../packages/client/ui-theme/src/client/index.ts'
import { THEME_SETTINGS_NAMESPACE, ThemeSettingsSchema } from '../../../packages/client/ui-theme/src/theme-settings.ts'
import { FONT_CHOICES } from '../src/client/font-catalog.ts'

vi.mock('../src/styles/fonts.css?inline', () => ({ default: '' }))
vi.mock('../src/client/font-assets.ts', () => ({ FONT_REPLACEMENTS: {} }))

const { apply: fontsApply } = await import('../src/client/index.ts')

const SLOT = 'settings.general.item'
const INTEL = FONT_CHOICES.code.find(choice => choice.id === 'intel-one-mono')?.list ?? ''

let runtime: SlotTestRuntime | undefined

afterEach(async () => {
  cleanup()
  await runtime?.dispose()
  runtime = undefined
  Reflect.deleteProperty(document, 'fonts')
})

/** Boot the settings row under the real registry with one persisted code list. */
async function bench(codeFontFamily = '') {
  Object.defineProperty(document, 'fonts', { configurable: true, value: { load: () => Promise.resolve([]) } })
  const b = await SlotTestRuntime.create()
  runtime = b
  const locale = new LocaleRuntime(b.ctx)
  locale.setLocale('en')
  b.ctx.provide('locale', locale)
  b.slots.installLocale(locale)
  const section: Record<string, unknown> = {
    preference: 'system', fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
    textFontFamily: '', codeFontFamily, terminalFontFamily: '',
  }
  const namespace = () => ({
    ns: THEME_SETTINGS_NAMESPACE, schema: ThemeSettingsSchema.toJSON(), value: { ...section },
    autoGenerate: true, applies: 'live' as const, secrets: [], revision: 0,
  })
  const mutate = vi.fn((_ns: string, ops: { path: string[]; value: unknown }[]) => {
    for (const op of ops) section[op.path[0] as string] = op.value
    return Promise.resolve({ ok: true as const, value: namespace() })
  })
  b.remote.provideNamespaces({
    settings: {
      describe: () => Promise.resolve({ ok: true as const, value: { writable: true, hasDocument: true, namespaces: [namespace()] } }),
      mutate,
    },
  })
  await b.mount({ inject: [...settingsInject], apply: settingsApply })
  await b.declare({ [SLOT]: { kind: 'list', scope: 'root' } } as never)
  await b.mount({ inject: [...themeInject], apply: themeApply })
  await act(async () => { await Promise.resolve() })
  b.renderSlot(SLOT as never, {})
  return { b, mutate }
}

describe('font picker composition', () => {
  it('replaces each font row field and persists a selection through the theme settings', async () => {
    const { b, mutate } = await bench()
    expect(screen.getByRole('textbox', { name: 'Code font' })).toBeDefined()

    await b.mount({ apply: fontsApply })
    expect(screen.queryByRole('textbox', { name: 'Code font' })).toBeNull()
    for (const name of ['Text font', 'Code font', 'Terminal font']) {
      expect(screen.getByRole('combobox', { name })).toBeDefined()
    }

    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Code font' })
    expect(select.value).toBe('default')
    await act(async () => { fireEvent.change(select, { target: { value: 'intel-one-mono' } }) })
    expect(mutate).toHaveBeenCalled()
    expect(mutate.mock.lastCall?.[1]).toEqual([expect.objectContaining({ path: ['codeFontFamily'], value: INTEL })])
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Code font' }).value).toBe('intel-one-mono')
  })

  it('keeps a persisted list outside the catalog under Custom', async () => {
    const { b } = await bench('"Iosevka", monospace')
    await b.mount({ apply: fontsApply })
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Code font' }).value).toBe('custom')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Code font, custom font list' }).value).toBe('"Iosevka", monospace')
  })

  it('returns each row to its text field when the plugin unloads', async () => {
    const { b } = await bench('"Iosevka"')
    const fonts = await b.mount({ apply: fontsApply })
    expect(screen.getByRole('combobox', { name: 'Code font' })).toBeDefined()

    await fonts.dispose()
    expect(screen.queryByRole('combobox', { name: 'Code font' })).toBeNull()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Code font' }).value).toBe('"Iosevka"')
  })
})
