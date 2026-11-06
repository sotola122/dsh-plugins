/**
 * The stylesheet builder and the tag it mounts: every placeholder becomes the
 * bundled data URL, a mismatched build fails loud in either direction, and the
 * document holds the tag for exactly the plugin lifetime.
 */

import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FONT_REPLACEMENTS } from '../src/client/font-assets.ts'
import { installFontStyles, renderFontStylesheet, renderFontTokenDefaults } from '../src/client/styles.ts'
import { Config, FONT_CONFIG_GLOBAL } from '../src/config.ts'

// Vitest serves CSS imports as empty strings; the bundle build hands the entry
// the shipped stylesheet, so the bench supplies that same text.
vi.mock('../src/styles/fonts.css?inline', async () => ({
  default: (await import('node:fs')).readFileSync(new URL('../src/styles/fonts.css', import.meta.url), 'utf8'),
}))

const { apply: applyClient } = await import('../src/client/index.ts')

/** A style tag as the stub document records it. */
interface StubTag {
  readonly dataset: Record<string, string>
  textContent: string
  removed: boolean
  remove(): void
}

/** The global document the module reads, restored after each test. */
const realDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

afterEach(() => {
  if (realDocument === undefined) Reflect.deleteProperty(globalThis, 'document')
  else Object.defineProperty(globalThis, 'document', realDocument)
  Reflect.deleteProperty(globalThis, FONT_CONFIG_GLOBAL)
})

/**
 * Install a stub document holding the tags its head receives.
 * @returns the tags appended to the stub head, in append order.
 */
function installDocument(load: FontFaceSet['load'] = () => Promise.resolve([])): StubTag[] {
  const tags: StubTag[] = []
  const document = {
    fonts: { load },
    createElement(): StubTag {
      const tag: StubTag = {
        dataset: {},
        textContent: '',
        removed: false,
        remove() {
          tag.removed = true
          const index = tags.indexOf(tag)
          if (index >= 0) tags.splice(index, 1)
        },
      }
      return tag
    },
    head: {
      appendChild(tag: StubTag) {
        tags.push(tag)
      },
    },
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document })
  return tags
}

describe('renderFontStylesheet', () => {
  it('replaces every placeholder with its data URL', () => {
    const template = 'a __DSH_FONT_UDEV_GOTHIC__ b __DSH_FONT_NOTO_SANS_JP_LATIN__ c'
    const css = renderFontStylesheet(template, {
      __DSH_FONT_UDEV_GOTHIC__: 'data:font/woff2;base64,AAA',
      __DSH_FONT_NOTO_SANS_JP_LATIN__: 'data:font/woff2;base64,BBB',
    })
    expect(css).toBe('a data:font/woff2;base64,AAA b data:font/woff2;base64,BBB c')
    expect(css).not.toMatch(/__DSH_FONT_/u)
  })

  it('ships a replacement for every placeholder the stylesheet carries', () => {
    const stylesheet = readFileSync(new URL('../src/styles/fonts.css', import.meta.url), 'utf8')
    const css = renderFontStylesheet(stylesheet, FONT_REPLACEMENTS)
    expect(css).not.toMatch(/url\(__DSH_FONT_/u)
    expect(css).toContain(`url(${FONT_REPLACEMENTS.__DSH_FONT_UDEV_GOTHIC__})`)
  })

  it('rejects a font file the stylesheet does not use', () => {
    expect(() => renderFontStylesheet('no placeholders', { __DSH_FONT_UDEV_GOTHIC__: 'data:' }))
      .toThrow(/the stylesheet has no __DSH_FONT_UDEV_GOTHIC__ for 1 font files/u)
  })

  it('rejects a placeholder the replacement map does not cover', () => {
    expect(() => renderFontStylesheet('__DSH_FONT_NOTO_SANS_JP_KANA__', {}))
      .toThrow(/__DSH_FONT_NOTO_SANS_JP_KANA__ has no font file in FONT_REPLACEMENTS/u)
  })
})

describe('renderFontTokenDefaults', () => {
  it('writes every configured list as its default token', () => {
    expect(renderFontTokenDefaults({
      text: '"Inter", sans-serif', code: '"Iosevka", monospace', terminal: '"Fira Mono", monospace',
    })).toBe('\n:root:root {\n'
      + '  --dsh-font-family-text-default: "Inter", sans-serif;\n'
      + '  --dsh-font-family-code-default: "Iosevka", monospace;\n'
      + '  --dsh-font-family-terminal-default: "Fira Mono", monospace;\n}\n')
  })

  it('keeps the built-in stack for an empty list', () => {
    const css = renderFontTokenDefaults({ text: '', code: '"Iosevka", monospace', terminal: '' })
    expect(css).not.toContain('--dsh-font-family-text-default')
    expect(css).not.toContain('--dsh-font-family-terminal-default')
    expect(css).toContain('--dsh-font-family-code-default: "Iosevka", monospace;')
  })

  it('writes nothing when every interface keeps the built-in stack', () => {
    expect(renderFontTokenDefaults({ text: '', code: '', terminal: '' })).toBe('')
  })

  it('defaults to the shipped Japanese-first stacks', () => {
    const css = renderFontTokenDefaults(Config({}))
    const text = /--dsh-font-family-text-default: ([^;]+);/u.exec(css)?.[1] ?? ''
    expect(text.startsWith("'UDEV Gothic', 'Noto Sans JP', -apple-system, BlinkMacSystemFont")).toBe(true)
    const code = /--dsh-font-family-code-default: ([^;]+);/u.exec(css)?.[1] ?? ''
    expect(code.startsWith("'Intel One Mono', 'UDEV Gothic', 'Noto Sans JP'")).toBe(true)
    // Japanese inside a code span must resolve to the shipped faces, never to the
    // upstream Chinese-first entries that follow them.
    expect(code.indexOf("'UDEV Gothic'")).toBeLessThan(code.indexOf("'PingFang SC'"))
    expect(code.indexOf("'Noto Sans JP'")).toBeLessThan(code.indexOf("'Microsoft YaHei'"))
    expect(css).toContain('--dsh-font-family-terminal-default: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;')
  })
})

describe('installFontStyles', () => {
  it('does nothing outside a browser document', async () => {
    Reflect.deleteProperty(globalThis, 'document')
    const ctx = new Context()
    expect(() => { installFontStyles(ctx, 'body {}') }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('mounts an attributable tag and removes it with the plugin', async () => {
    const tags = installDocument()
    const ctx = new Context()
    installFontStyles(ctx, 'body { font-family: UDEV Gothic; }')

    expect(tags).toHaveLength(1)
    const tag = tags[0] as StubTag
    expect(tag.dataset).toEqual({
      plugin: '@anago-harness/client-ui-fonts-anago',
      pluginCss: '@anago-harness/client-ui-fonts-anago/fonts.css',
    })
    expect(tag.textContent).toBe('body { font-family: UDEV Gothic; }')

    await ctx.fiber.dispose()
    expect(tags).toHaveLength(0)
    expect(tag.removed).toBe(true)
  })

  it('loads the Latin face a terminal list measures with, and tolerates a failed load', async () => {
    const load = vi.fn<FontFaceSet['load']>(() => Promise.reject(new Error('blocked')))
    const tags = installDocument(load)
    const ctx = new Context()
    installFontStyles(ctx, 'body {}')
    await Promise.resolve()

    expect(load).toHaveBeenCalledExactlyOnceWith('1em "Intel One Mono"', 'W')
    expect(tags).toHaveLength(1)
    await ctx.fiber.dispose()
  })
})

describe('plugin entries', () => {
  it('mounts the shipped faces with the default stacks', async () => {
    const tags = installDocument()
    const ctx = new Context()
    applyClient(ctx)

    expect(tags).toHaveLength(1)
    const css = tags[0]?.textContent ?? ''
    expect(css).not.toMatch(/url\(__DSH_FONT_/u)
    expect(css).toContain('@font-face')
    expect(css).toContain("font-family: 'UDEV Gothic';")
    expect(css).toContain("--dsh-font-family-text-default: 'UDEV Gothic', 'Noto Sans JP',")

    await ctx.fiber.dispose()
    expect(tags).toHaveLength(0)
  })

  it('applies the lists the Host embedded in the page', async () => {
    const tags = installDocument()
    const ctx = new Context()
    Reflect.set(globalThis, FONT_CONFIG_GLOBAL, { text: '"Inter"', code: '', terminal: '"Fira Mono"' })
    applyClient(ctx)

    const css = tags[0]?.textContent ?? ''
    expect(css).toContain('--dsh-font-family-text-default: "Inter";')
    expect(css).not.toContain('--dsh-font-family-code-default')
    expect(css).toContain('--dsh-font-family-terminal-default: "Fira Mono";')

    await ctx.fiber.dispose()
    expect(tags).toHaveLength(0)
  })
})
