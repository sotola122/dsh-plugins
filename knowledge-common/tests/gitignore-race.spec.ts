/**
 * The two re-checks that run inside the locked update: the read/stat size
 * comparison, and the target inspection that maps a permission failure. Both
 * need the bytes or the filesystem to disagree with the plan, so the locked
 * update is handed content directly.
 * @module knowledge-common/test/gitignore-race.test
 */
import { chmod, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureGitignoreBlock,
  expectedGitignoreLines,
  GitignoreEditError,
  type AtomicWriteApi,
  type LockedUpdater,
} from '../src/index.ts'
import { createTempDir, removeTempDirs } from './support.ts'

/** The content the mocked locked update hands its updater. */
const state = vi.hoisted(() => ({ current: 'a different length' as string | null }))

vi.mock('../src/atomic.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/atomic.ts')>(),
  async updateFileLocked<T>(_api: AtomicWriteApi, _filename: string, update: LockedUpdater<T>): Promise<T> {
    const next = await update(state.current)
    return next.result
  },
}))

afterEach(removeTempDirs)

/** The seam ensureGitignoreBlock would otherwise lock through. */
const api = {
  async writeFileAtomic(): Promise<void> {},
  async withFileLock<T>(_filename: string, operation: () => Promise<T>): Promise<T> {
    return operation()
  },
}

describe('ensureGitignoreBlock read/stat race', () => {
  it('refuses when the read bytes disagree with the file size', async () => {
    state.current = 'a different length'
    const root = await createTempDir()
    await writeFile(path.join(root, '.gitignore'), 'dist/\n')
    const failure = await ensureGitignoreBlock(api, { root, lines: expectedGitignoreLines() }).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(GitignoreEditError)
    expect((failure as GitignoreEditError).code).toBe('GITIGNORE_CONFLICT')
  })

  it('maps a permission failure from inspecting the target', async () => {
    state.current = null
    const root = await createTempDir()
    await writeFile(path.join(root, '.gitignore'), 'dist/\n')
    await chmod(root, 0o000)
    try {
      const failure = await ensureGitignoreBlock(api, { root, lines: expectedGitignoreLines() }).catch(
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(GitignoreEditError)
      expect((failure as GitignoreEditError).code).toBe('GITIGNORE_UNWRITABLE')
    } finally {
      await chmod(root, 0o755)
    }
  })
})
