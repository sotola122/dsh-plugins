/** Manifest contract the plugin loader and the client bundle rely on. */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

interface ClientFace {
  readonly platform?: string
  readonly inject?: readonly string[]
}

interface CardManifest {
  readonly exports: Record<string, { types?: string; default?: string } | string>
  readonly dsh?: { readonly client?: ClientFace }
  readonly dependencies?: Record<string, string>
  readonly files?: readonly string[]
}

const packageRoot = new URL('..', import.meta.url).pathname
const manifest = JSON.parse(
  readFileSync(join(packageRoot, 'package.json'), 'utf8'),
) as CardManifest

/** Every TypeScript source of the browser half, relative to the package. */
function clientSources(dir = join(packageRoot, 'src', 'client')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return clientSources(path)
    return entry.isFile() && entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [path] : []
  })
}

describe('card manifest', () => {
  it('publishes a browser entry next to the host entry', () => {
    expect(manifest.exports['./client']).toEqual({
      types: './lib/types/client/index.d.ts',
      default: './lib/client.js',
    })
    expect(manifest.files).toContain('lib/client.js')
  })

  it('declares the web platform and the services the card consumes', () => {
    const client = manifest.dsh?.client
    expect(client?.platform).toBe('web')
    expect(client?.inject).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-settings',
    ]))
    for (const service of client?.inject ?? []) expect(service).toMatch(/^@deepseek-ai\/dsh-/u)
  })

  it('stays free of runtime dependencies so the client bundle is self-contained', () => {
    expect(manifest.dependencies ?? {}).toEqual({})
  })

  it('uses no CSS Modules, which the client bundle preset does not serve', () => {
    for (const source of clientSources()) {
      expect(readFileSync(source, 'utf8')).not.toMatch(/\.module\.css['"]/)
    }
  })

  it('keeps the host Loader row inert', () => {
    expect(() => { apply() }).not.toThrow()
  })
})
