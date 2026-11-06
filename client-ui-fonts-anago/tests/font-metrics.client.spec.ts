/**
 * The measured font binaries are the shipped ones, and the terminal face keeps
 * the two-cell width that xterm needs: a full-width glyph advances exactly twice
 * its half-width glyph. A browser terminal measures its cell from the half-width
 * advance, so 全角 occupies two cells only when that ratio holds.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const fontsDir = resolve(import.meta.dirname, '../src/fonts')

/** One record of the authoring step that produced the woff2 subsets. */
interface FontRecord {
  file: string
  family: string
  derivedFrom?: string
  fontWeight: string
  unicodeRange: string
  bytes: number
  sha256: string
  glyphs: number
  unitsPerEm: number
  advances: {
    fullWidth: number | null
    halfWidth: number | null
    ideograph: number | null
    latin: number | null
  }
}

const metrics = JSON.parse(readFileSync(resolve(fontsDir, 'fonts.json'), 'utf8')) as {
  fonts: FontRecord[]
  licenses: Record<string, string>
}
const stylesheet = readFileSync(resolve(import.meta.dirname, '../src/styles/fonts.css'), 'utf8')

/** Em advance of one recorded glyph, or `undefined` when the subset omits it. */
function em(value: number | null): number | undefined {
  return value ?? undefined
}

describe('shipped font binaries', () => {
  it('records exactly the seven files the stylesheet loads', () => {
    expect(metrics.fonts.map(font => font.file).sort()).toEqual([
      'intel-one-mono-latin-ext.woff2',
      'intel-one-mono-latin.woff2',
      'intel-one-mono-symbols.woff2',
      'noto-sans-jp-kana.woff2',
      'noto-sans-jp-kanji.woff2',
      'noto-sans-jp-latin.woff2',
      'udev-gothic-regular.woff2',
    ])
    const total = metrics.fonts.reduce((sum, font) => sum + font.bytes, 0)
    expect(total).toBeLessThan(6 * 1024 * 1024)
  })

  it('keeps every file byte-identical to the one that was measured', () => {
    for (const font of metrics.fonts) {
      const bytes = readFileSync(resolve(fontsDir, font.file))
      expect(bytes.byteLength, font.file).toBe(font.bytes)
      expect(createHash('sha256').update(bytes).digest('hex'), font.file).toBe(font.sha256)
      expect(bytes.subarray(0, 4).toString('latin1'), font.file).toBe('wOF2')
    }
  })

  it('ships one OFL text per family with the recorded name', () => {
    for (const font of metrics.fonts) {
      const license = metrics.licenses[font.family]
      expect(license, font.family).toBeDefined()
      const text = readFileSync(resolve(fontsDir, license ?? ''), 'utf8')
      expect(text, license).toContain('SIL OPEN FONT LICENSE Version 1.1')
    }
  })

  it('declares the same unicode range for each face as its subset', () => {
    for (const font of metrics.fonts) {
      expect(stylesheet, font.file).toContain(`unicode-range: ${font.unicodeRange};`)
    }
  })

  it('keeps a full-width glyph at exactly two cells in the terminal face', () => {
    const gothic = metrics.fonts.find(font => font.file === 'udev-gothic-regular.woff2')
    expect(gothic?.unitsPerEm).toBe(2048)
    expect(em(gothic?.advances.halfWidth ?? null)).toBe(0.5)
    expect(em(gothic?.advances.fullWidth ?? null)).toBe(1)
    expect(em(gothic?.advances.ideograph ?? null)).toBe(1)
    expect(em(gothic?.advances.fullWidth ?? null)).toBe(2 * (em(gothic?.advances.halfWidth ?? null) ?? 0))
  })

  it('ships the unmodified upstream font under its own name', () => {
    const [gothic] = metrics.fonts.filter(font => font.file === 'udev-gothic-regular.woff2')
    expect(gothic?.family).toBe('UDEV Gothic')
    expect(gothic?.file).toContain('udev')
    expect(metrics.licenses['UDEV Gothic']).toBe('UDEV-Gothic-OFL.txt')
    expect(stylesheet).toContain("font-family: 'UDEV Gothic';")
    expect(stylesheet).not.toContain("font-family: 'Anago Gothic';")
  })

  it('keeps the Japanese fallback on the same half/full-width metrics', () => {
    const kana = metrics.fonts.find(font => font.file === 'noto-sans-jp-kana.woff2')
    expect(em(kana?.advances.halfWidth ?? null)).toBe(0.5)
    expect(em(kana?.advances.fullWidth ?? null)).toBe(1)
    expect(em(kana?.advances.fullWidth ?? null)).toBe(2 * (em(kana?.advances.halfWidth ?? null) ?? 0))
  })

  it('covers the full Japanese range across the UDEV Gothic and Noto faces', () => {
    const ranges = metrics.fonts.map(font => font.unicodeRange).join(' ')
    for (const block of ['U+3000-303F', 'U+3040-309F', 'U+30A0-30FF', 'U+4E00-9FFF', 'U+3400-4DBF', 'U+FF65-FF9F']) {
      expect(ranges).toContain(block)
    }
    expect(metrics.fonts.filter(font => font.family === 'UDEV Gothic')).toHaveLength(1)
    expect(metrics.fonts.filter(font => font.family === 'Noto Sans JP')).toHaveLength(3)
    expect(metrics.fonts.filter(font => font.family === 'Intel One Mono')).toHaveLength(3)
  })
})
