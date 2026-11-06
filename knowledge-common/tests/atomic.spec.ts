/**
 * Locked atomic update suite (DESIGN §4.1, §10 並行書き込み): `mkdir` → lock →
 * read → write, all-or-nothing, the typed lock timeout, and a concurrent pair
 * of read-modify-write cycles that must not lose an update.
 * @module knowledge-common/test/atomic.test
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FileLockTimeoutError,
  readTextFileIfExists,
  updateFileLocked,
  type LockedUpdate,
} from '../src/index.ts'
import { createTempDir, createTestAtomicWrite, removeTempDirs } from './support.ts'

afterEach(removeTempDirs)

/** Wait for a delay inside an updater, to widen the read-modify-write window. */
async function pause(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('updateFileLocked', () => {
  it('creates the parent with 0700 and the file with 0600', async () => {
    const root = await createTempDir()
    const api = createTestAtomicWrite()
    const file = path.join(root, 'memories', 'MEMORY.md')
    await updateFileLocked(api, file, () => ({ content: 'entry\n', result: null }), {
      mode: 0o600,
    })
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await readFile(file, 'utf8')).toBe('entry\n')
  })

  it('hands the current content to the updater, and null when the file is absent', async () => {
    const root = await createTempDir()
    const api = createTestAtomicWrite()
    const file = path.join(root, 'MEMORY.md')
    const seen: (string | null)[] = []
    await updateFileLocked(
      api,
      file,
      (current) => {
        seen.push(current)
        return { content: current === null ? 'first\n' : `${current}second\n`, result: null }
      },
      { mode: 0o600 },
    )
    await updateFileLocked(
      api,
      file,
      (current) => {
        seen.push(current)
        return { content: null, result: null }
      },
      { mode: 0o600 },
    )
    expect(seen).toEqual([null, 'first\n'])
  })

  it('writes nothing when the updater returns null content', async () => {
    const root = await createTempDir()
    const api = createTestAtomicWrite()
    const file = path.join(root, 'MEMORY.md')
    await writeFile(file, 'original\n')
    const before = await stat(file)
    await updateFileLocked(api, file, () => ({ content: null, result: 'unchanged' }), {
      mode: 0o600,
    })
    const after = await stat(file)
    expect(after.ino).toBe(before.ino)
    expect(api.events.some(event => event.kind === 'write')).toBe(false)
  })

  it('writes while the lock is held', async () => {
    const root = await createTempDir()
    const api = createTestAtomicWrite()
    const file = path.join(root, 'MEMORY.md')
    await updateFileLocked(api, file, () => ({ content: 'entry\n', result: null }), {
      mode: 0o600,
    })
    expect(api.events.map(event => event.kind)).toEqual([
      'lock-acquired',
      'write',
      'lock-released',
    ])
  })

  it('leaves the file untouched when the updater throws', async () => {
    const root = await createTempDir()
    const api = createTestAtomicWrite()
    const file = path.join(root, 'MEMORY.md')
    await writeFile(file, 'original\n')
    const before = await stat(file)
    await expect(
      updateFileLocked(
        api,
        file,
        () => {
          throw new Error('refused')
        },
        { mode: 0o600 },
      ),
    ).rejects.toThrow('refused')
    expect(await readFile(file, 'utf8')).toBe('original\n')
    expect((await stat(file)).ino).toBe(before.ino)
  })

  it('reports the lock deadline as FileLockTimeoutError and writes nothing', async () => {
    const root = await createTempDir()
    const api = createTestAtomicWrite()
    const file = path.join(root, 'MEMORY.md')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(`${file}.lock`, '999999\n')
    const failure = await updateFileLocked(api, file, () => ({ content: 'entry\n', result: null }), {
      mode: 0o600,
      lockWaitMs: 120,
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(FileLockTimeoutError)
    expect((failure as FileLockTimeoutError).code).toBe('LOCK_TIMEOUT')
    expect(await readTextFileIfExists(file)).toBeNull()
  })

  it('propagates the caller’s cancellation reason', async () => {
    const root = await createTempDir()
    const api = createTestAtomicWrite()
    const file = path.join(root, 'MEMORY.md')
    const controller = new AbortController()
    controller.abort(new Error('cancelled by the caller'))
    await expect(
      updateFileLocked(api, file, () => ({ content: 'entry\n', result: null }), {
        mode: 0o600,
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled by the caller')
    expect(await readTextFileIfExists(file)).toBeNull()
  })

  it('does not lose an update when two writers race', async () => {
    const root = await createTempDir()
    const api = createTestAtomicWrite()
    const file = path.join(root, 'MEMORY.md')
    const append = async (current: string | null): Promise<LockedUpdate<null>> => {
      await pause(20)
      return { content: `${current ?? ''}line\n`, result: null }
    }
    await Promise.all([
      updateFileLocked(api, file, append, { mode: 0o600, lockWaitMs: 5_000 }),
      updateFileLocked(api, file, append, { mode: 0o600, lockWaitMs: 5_000 }),
    ])
    expect(await readFile(file, 'utf8')).toBe('line\nline\n')
    expect(api.events.filter(event => event.kind === 'write')).toHaveLength(2)
  })

  it('forwards a cancellation that arrives while the update runs', async () => {
    const root = await createTempDir()
    const api = createTestAtomicWrite()
    const file = path.join(root, 'MEMORY.md')
    const controller = new AbortController()
    const reason = new Error('cancelled during the update')
    await expect(
      updateFileLocked(
        api,
        file,
        async () => {
          controller.abort(reason)
          throw new Error('refused after cancellation')
        },
        { mode: 0o600, signal: controller.signal },
      ),
    ).rejects.toBe(reason)
    expect(await readTextFileIfExists(file)).toBeNull()
  })

  it('maps a lock timeout the injected API reports before the caller deadline', async () => {
    const root = await createTempDir()
    const api = {
      async writeFileAtomic(): Promise<void> {},
      async withFileLock(): Promise<never> {
        throw new Error('atomic-write: timed out waiting for the writer lock at /tmp/MEMORY.md.lock')
      },
    }
    const failure = await updateFileLocked(
      api,
      path.join(root, 'MEMORY.md'),
      () => ({ content: null, result: null }),
      { mode: 0o600, lockWaitMs: 10_000 },
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(FileLockTimeoutError)
  })

  it('rethrows a rejection that carries no message instead of assuming a lock timeout', async () => {
    const root = await createTempDir()
    const api = {
      async writeFileAtomic(): Promise<void> {},
      async withFileLock(): Promise<never> {
        throw 'opaque refusal'
      },
    }
    await expect(
      updateFileLocked(api, path.join(root, 'MEMORY.md'), () => ({ content: null, result: null }), {
        mode: 0o600,
        lockWaitMs: 10_000,
      }),
    ).rejects.toBe('opaque refusal')
  })
})

describe('readTextFileIfExists', () => {
  it('returns null for a missing file and the content otherwise', async () => {
    const root = await createTempDir()
    const file = path.join(root, 'MEMORY.md')
    expect(await readTextFileIfExists(file)).toBeNull()
    await writeFile(file, 'text\n')
    expect(await readTextFileIfExists(file)).toBe('text\n')
  })
})
