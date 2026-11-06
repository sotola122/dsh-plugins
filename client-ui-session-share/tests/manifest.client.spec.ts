/** Manifest contract the plugin loader and the client bundle rely on. */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

interface ClientFace {
  readonly platform?: string
  readonly inject?: readonly string[]
}

interface PluginManifest {
  readonly exports: Record<string, { types?: string; default?: string } | string>
  readonly dsh?: { readonly client?: ClientFace }
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly files?: readonly string[]
}

const packageRoot = new URL('..', import.meta.url).pathname
const manifest = JSON.parse(
  readFileSync(join(packageRoot, 'package.json'), 'utf8'),
) as PluginManifest

/** Every TypeScript source of the browser half, relative to the package. */
function clientSources(dir = join(packageRoot, 'src', 'client')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return clientSources(path)
    return entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) ? [path] : []
  })
}

/** The meta block of one shipped locale resource. */
function meta(locale: string): Record<string, string> {
  const resource = JSON.parse(readFileSync(join(packageRoot, 'locale', `${locale}.json`), 'utf8')) as {
    meta?: Record<string, string>
  }
  return resource.meta ?? {}
}

describe('session-share manifest', () => {
  it('publishes a browser entry next to the host entry', () => {
    expect(manifest.exports['./client']).toEqual({
      types: './lib/types/client/index.d.ts',
      default: './lib/client.js',
    })
    expect(manifest.files).toContain('lib/client.js')
    expect(manifest.files).toContain('lib/index.js')
  })

  it('declares the web platform and the packages whose services it uses', () => {
    const client = manifest.dsh?.client
    expect(client?.platform).toBe('web')
    expect(client?.inject).toEqual([
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-conversation',
    ])
  })

  it('keeps the browser implementation out of the runtime dependency sections', () => {
    expect(manifest.dependencies ?? {}).toEqual({})
    expect(manifest.devDependencies?.['@deepseek-ai/schemastery']).toBe('workspace:~')
  })

  it('uses no CSS Modules, which the client bundle preset does not serve', () => {
    for (const source of clientSources()) {
      expect(readFileSync(source, 'utf8')).not.toMatch(/\.module\.css['"]/)
    }
  })

  it('ships the same locale metadata keys in both languages', () => {
    const en = meta('en')
    const zh = meta('zh')
    expect(Object.keys(en).sort()).toEqual(['description', 'title'])
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const value of Object.values(en)) expect(value.trim()).not.toBe('')
    for (const value of Object.values(zh)) expect(value.trim()).not.toBe('')
  })

  it('keeps the host Loader row inert', () => {
    expect(() => { apply() }).not.toThrow()
  })
})
