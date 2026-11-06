/**
 * The root walk's last-resort branch: when even the filesystem root cannot be
 * resolved, the lexical absolute path is returned instead of walking forever.
 * A filesystem that reports ENOENT for `/` is simulated by replacing `realpath`.
 * @module knowledge-common/test/paths-root.test
 */
import { describe, expect, it, vi } from 'vitest'
import { canonicalizeTargetPath } from '../src/paths.ts'

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  realpath: async () => {
    throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT' })
  },
}))

describe('canonicalizeTargetPath at the filesystem root', () => {
  it('returns the absolute target when no ancestor resolves', async () => {
    await expect(canonicalizeTargetPath('/a/b/c')).resolves.toBe('/a/b/c')
    await expect(canonicalizeTargetPath('relative.md', '/a/b')).resolves.toBe('/a/b/relative.md')
  })
})
