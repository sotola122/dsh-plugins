/**
 * Containment suite (DESIGN §5.2, §10 封じ込め・ルート): lexical containment,
 * `realpath` of the deepest existing ancestor with the missing tail re-attached,
 * and the `..`/symlink escapes the mutating tools must not follow.
 * @module knowledge-common/test/paths.test
 */
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalizeTargetPath,
  isContainedPath,
  isPathWithin,
  resolveContainedTarget,
} from '../src/index.ts'
import { createTempDir, removeTempDirs } from './support.ts'

afterEach(removeTempDirs)

describe('isPathWithin', () => {
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    ['/a/b', '/a/b', true],
    ['/a/b', '/a/b/c', true],
    ['/a/b', '/a/b/c/d.md', true],
    ['/a/b', '/a/bc', false],
    ['/a/b', '/a', false],
    ['/a/b', '/a/b/../c', false],
    ['/a/b', '/a/bb/../b', true],
  ]
  for (const [root, target, expected] of cases) {
    it(`${root} ⊃ ${target} → ${String(expected)}`, () => {
      expect(isPathWithin(root, target)).toBe(expected)
    })
  }

  it('treats the filesystem root as a prefix that already ends in a separator', () => {
    expect(isPathWithin('/', '/anywhere/at/all.md')).toBe(true)
    expect(isPathWithin('/', '/')).toBe(true)
  })

  it('compares case-insensitively on Windows, where the filesystem is', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      expect(isPathWithin('/Repo', '/repo/pages/a.md')).toBe(true)
      expect(isPathWithin('/Repo', '/other')).toBe(false)
    } finally {
      if (original === undefined) Reflect.deleteProperty(process, 'platform')
      else Object.defineProperty(process, 'platform', original)
    }
  })
})

describe('canonicalizeTargetPath', () => {
  it('keeps a missing tail after the deepest existing ancestor', async () => {
    const root = await createTempDir()
    const resolved = await canonicalizeTargetPath(path.join(root, 'missing', 'deep', 'file.md'))
    expect(resolved).toBe(path.join(await realpath(root), 'missing', 'deep', 'file.md'))
  })

  it('resolves a symlinked ancestor onto its target', async () => {
    const root = await createTempDir()
    const real = path.join(root, 'real')
    await mkdir(real)
    await symlink(real, path.join(root, 'link'))
    const resolved = await canonicalizeTargetPath(path.join(root, 'link', 'new.md'))
    expect(resolved).toBe(path.join(await realpath(real), 'new.md'))
  })

  it('removes .. before resolving, so a missing tail cannot be one', async () => {
    const root = await createTempDir()
    const nested = path.join(root, 'nested')
    await mkdir(nested)
    const resolved = await canonicalizeTargetPath(path.join(nested, '..', 'file.md'))
    expect(resolved).toBe(path.join(await realpath(root), 'file.md'))
  })

  it('resolves a relative target against the caller’s directory', async () => {
    const root = await createTempDir()
    const resolved = await canonicalizeTargetPath('file.md', root)
    expect(resolved).toBe(path.join(await realpath(root), 'file.md'))
  })

  it('rethrows a resolution failure that is not a missing component', async () => {
    const root = await createTempDir()
    await symlink('loop', path.join(root, 'loop'))
    await expect(canonicalizeTargetPath(path.join(root, 'loop'))).rejects.toMatchObject({
      code: 'ELOOP',
    })
  })
})

describe('resolveContainedTarget', () => {
  it('accepts a path inside the root, existing or not', async () => {
    const root = await createTempDir()
    await writeFile(path.join(root, 'page.md'), 'x\n')
    expect(await resolveContainedTarget(root, 'page.md', root)).not.toBeNull()
    expect(await resolveContainedTarget(root, 'pages/new.md', root)).not.toBeNull()
    expect(await isContainedPath(root, '.', root)).toBe(true)
  })

  it('refuses a path that leaves through ..', async () => {
    const root = await createTempDir()
    const outside = await createTempDir()
    await writeFile(path.join(outside, 'secret.md'), 'x\n')
    expect(await resolveContainedTarget(root, path.join('..', path.basename(outside), 'secret.md'), root)).toBeNull()
  })

  it('refuses a path that leaves through a symlinked directory', async () => {
    const root = await createTempDir()
    const outside = await createTempDir()
    await writeFile(path.join(outside, 'secret.md'), 'x\n')
    await symlink(outside, path.join(root, 'escape'))
    expect(await resolveContainedTarget(root, 'escape/secret.md', root)).toBeNull()
    expect(await resolveContainedTarget(root, 'escape/new.md', root)).toBeNull()
  })

  it('accepts a symlink that stays inside the root', async () => {
    const root = await createTempDir()
    await mkdir(path.join(root, 'pages'))
    await symlink(path.join(root, 'pages'), path.join(root, 'alias'))
    const resolved = await resolveContainedTarget(root, 'alias/new.md', root)
    expect(resolved).toBe(path.join(await realpath(root), 'pages', 'new.md'))
  })

  it('refuses a sibling whose name merely shares the prefix', async () => {
    const parent = await createTempDir()
    const root = path.join(parent, 'wiki')
    const sibling = path.join(parent, 'wiki-public')
    await mkdir(root)
    await mkdir(sibling)
    expect(await resolveContainedTarget(root, sibling, parent)).toBeNull()
  })
})
