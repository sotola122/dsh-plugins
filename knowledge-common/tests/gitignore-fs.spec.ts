/**
 * The filesystem failures the managed-block editor maps onto its documented
 * refusal: a `stat`/`lstat` that fails for a reason other than "does not exist".
 * The failure is simulated at the `node:fs/promises` seam so no permissions are
 * required on the test host.
 * @module knowledge-common/test/gitignore-fs.test
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureGitignoreBlock, expectedGitignoreLines, GitignoreEditError } from '../src/index.ts'
import { createTempDir, removeTempDirs } from './support.ts'

/** Which inspection call reports a permission failure. */
const state = vi.hoisted(() => ({ stat: false, lstat: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  const denied = (): never => {
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
  }
  return {
    ...original,
    async stat(...args: Parameters<typeof original.stat>) {
      if (state.stat) denied()
      return original.stat(...args)
    },
    async lstat(...args: Parameters<typeof original.lstat>) {
      if (state.lstat) denied()
      return original.lstat(...args)
    },
  }
})

afterEach(async () => {
  state.stat = false
  state.lstat = false
  await removeTempDirs()
})

/** A seam that runs the locked operation without acquiring a lock. */
const api = {
  async writeFileAtomic(): Promise<void> {},
  async withFileLock<T>(_filename: string, operation: () => Promise<T>): Promise<T> {
    return operation()
  },
}

describe('ensureGitignoreBlock inspection failures', () => {
  it('maps a stat failure that is not ENOENT', async () => {
    state.stat = true
    const root = await createTempDir()
    await writeFile(path.join(root, '.gitignore'), 'dist/\n')
    const failure = await ensureGitignoreBlock(api, { root, lines: expectedGitignoreLines() }).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(GitignoreEditError)
    expect((failure as GitignoreEditError).code).toBe('GITIGNORE_UNWRITABLE')
  })

  it('maps an lstat failure that is not ENOENT', async () => {
    state.lstat = true
    const root = await createTempDir()
    await writeFile(path.join(root, '.gitignore'), 'dist/\n')
    const failure = await ensureGitignoreBlock(api, { root, lines: expectedGitignoreLines() }).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(GitignoreEditError)
    expect((failure as GitignoreEditError).code).toBe('GITIGNORE_UNWRITABLE')
  })
})
