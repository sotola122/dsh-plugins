/** The browser entry reaches the stylesheet, every import resolves to a shipped file, and the manifest keeps the client declaration. */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageDir = resolve(import.meta.dirname, '..')

/** The client bundle entry the module system serves for `dsh.client`. */
const ENTRY = resolve(packageDir, 'src/client/index.ts')

/** Relative specifiers imported by the entry and, transitively, its local modules. */
function reachableSpecifiers(entry: string): Set<string> {
  const reached = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    for (const match of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s+'([^']+)'/gu)) {
      const specifier = match[1] ?? ''
      reached.add(specifier)
      if (!specifier.startsWith('.') || !/\.tsx?$/u.test(specifier)) continue
      queue.push(resolve(dirname(file), specifier))
    }
  }
  return reached
}

describe('client bundle entry', () => {
  const reached = reachableSpecifiers(ENTRY)

  it('imports the stylesheet that owns the font faces', () => {
    expect(reached).toContain('../styles/fonts.css?inline')
  })

  it('reaches every woff2 the stylesheet placeholder list needs', () => {
    const assets = readFileSync(resolve(packageDir, 'src/client/font-assets.ts'), 'utf8')
    const fonts = [...assets.matchAll(/from '\.\.\/fonts\/([^']+)'/gu)].map(match => match[1])
    expect(fonts).toHaveLength(7)
    for (const font of fonts) {
      expect(existsSync(resolve(packageDir, 'src/fonts', font ?? '')), font).toBe(true)
    }
    expect(reached).toContain('./font-assets.ts')
    expect(reached).toContain('./styles.ts')
  })

  it('maps every stylesheet placeholder to exactly one imported font', () => {
    const stylesheet = readFileSync(resolve(packageDir, 'src/styles/fonts.css'), 'utf8')
    const placeholders = new Set([...stylesheet.matchAll(/__DSH_FONT_[A-Z0-9_]+__/gu)].map(match => match[0]))
    const assets = readFileSync(resolve(packageDir, 'src/client/font-assets.ts'), 'utf8')
    const keys = [...assets.matchAll(/^ {2}(__DSH_FONT_[A-Z0-9_]+__):/gmu)].map(match => match[1])
    expect(keys).toHaveLength(placeholders.size)
    expect(new Set(keys)).toEqual(placeholders)
  })

  it('declares a web client bundle', async () => {
    const manifest = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8')) as {
      exports: Record<string, { default: string }>
      files: string[]
      dsh: { client: { platform: string; immediately?: boolean } }
    }
    expect(manifest.dsh.client).toEqual({ platform: 'web', immediately: true })
    expect(manifest.exports['./client']?.default).toBe('./lib/client.js')
    expect(manifest.exports['.']?.default).toBe('./lib/index.js')
    expect(manifest.files).toContain('lib/fonts')
  })
})
