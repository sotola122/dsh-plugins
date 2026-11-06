/** The picker catalog names only shipped files and declared faces, and every list survives normalization unchanged. */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeFontFamily } from '../../../client/ui-theme/src/theme-settings.ts'
import { FONT_CATALOG, FONT_CHOICES } from '../src/client/font-catalog.ts'

const packageDir = resolve(import.meta.dirname, '..')
const stylesheet = readFileSync(resolve(packageDir, 'src/styles/fonts.css'), 'utf8')
const manifest = JSON.parse(readFileSync(resolve(packageDir, 'src/fonts/fonts.json'), 'utf8')) as {
  fonts: { file: string; family: string }[]
}

const bundled = FONT_CATALOG.filter(entry => entry.kind === 'bundled')
const system = FONT_CATALOG.filter(entry => entry.kind === 'system')

describe('font catalog', () => {
  it('gives every entry a unique id that the picker reserves for nothing else', () => {
    const ids = FONT_CATALOG.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain('default')
    expect(ids).not.toContain('custom')
  })

  it('stores every list in the form the theme service persists', () => {
    for (const entry of FONT_CATALOG) {
      for (const list of Object.values(entry.lists)) {
        expect(normalizeFontFamily(list), entry.id).toBe(list)
      }
    }
  })

  it('accounts for every shipped font file under its own family', () => {
    const listed = bundled.flatMap(entry => entry.files)
    expect([...listed].sort()).toEqual(manifest.fonts.map(font => font.file).sort())
    for (const entry of bundled) {
      for (const file of entry.files) {
        expect(existsSync(resolve(packageDir, 'src/fonts', file)), file).toBe(true)
        expect(manifest.fonts.find(font => font.file === file)?.family).toBe(entry.label)
      }
    }
  })

  it('leads each bundled list with a face the stylesheet declares', () => {
    for (const entry of bundled) {
      expect(stylesheet).toContain(`font-family: '${entry.label}';`)
      for (const list of Object.values(entry.lists)) {
        expect(list.startsWith(`"${entry.label}"`), entry.id).toBe(true)
      }
    }
  })

  it('needs no file for a system stack', () => {
    for (const entry of system) {
      expect(entry.files).toEqual([])
      for (const list of Object.values(entry.lists)) expect(list).not.toContain('"')
    }
  })

  it('offers each role the fonts that suit it', () => {
    const labels = (role: keyof typeof FONT_CHOICES, kind: 'bundled' | 'system') =>
      FONT_CHOICES[role].filter(choice => choice.kind === kind).map(choice => choice.label)
    expect(labels('text', 'bundled')).toEqual(['UDEV Gothic', 'Noto Sans JP'])
    expect(labels('code', 'bundled')).toEqual(['Intel One Mono', 'UDEV Gothic'])
    expect(labels('terminal', 'bundled')).toEqual(['Intel One Mono', 'UDEV Gothic'])
    expect(labels('text', 'system')).toEqual(['system-ui', 'sans-serif', 'serif', 'monospace'])
    expect(labels('code', 'system')).toEqual(['ui-monospace', 'monospace'])
    expect(labels('terminal', 'system')).toEqual(['ui-monospace', 'monospace'])
  })
})
