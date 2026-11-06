/**
 * Fixtures shared by the knowledge-common suites: temporary directories under
 * `os.tmpdir()`, a local stand-in for `@deepseek-ai/dsh-atomic-write`, and a
 * synchronous git helper.
 *
 * **Why a stand-in.** `@deepseek-ai/dsh-atomic-write` is not installed in this
 * workspace — the root lockfile lists 33 `@deepseek-ai/*` packages and this is
 * not one of them — and this task must not run `npm install`. The stand-in
 * implements exactly the two behaviors this module relies on, as
 * `dsh-atomic-write` documents them: a `wx`-created random-suffix sibling
 * renamed over the target with the caller's mode, and a `wx`-created
 * `<file>.lock` sibling holding the operation. In production the consumers pass
 * the real package (a peer of both, DESIGN §3.1).
 * @module knowledge-common/test/support
 */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AtomicWriteApi } from '../src/index.ts'

const tempDirs: string[] = []

/**
 * Create a fresh directory under the OS temporary directory.
 * @param prefix - directory name prefix.
 * @returns the directory path.
 */
export async function createTempDir(prefix = 'knowledge-common-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Remove every directory {@link createTempDir} handed out. Call from `afterEach`. */
export async function removeTempDirs(): Promise<void> {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true })
    }),
  )
}

/** One observable step of the stand-in's write protocol. */
export interface AtomicWriteEvent {
  /** What happened. */
  readonly kind: 'lock-acquired' | 'write' | 'lock-released'
  /** The file it happened to. */
  readonly file: string
}

/** The stand-in, with the event log its tests assert on. */
export interface TestAtomicWrite extends AtomicWriteApi {
  /** Steps in the order they happened. */
  readonly events: AtomicWriteEvent[]
}

/** The reason a signal aborted, as an `Error`; `AbortSignal.reason` is typed `any`. */
function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason
  return reason instanceof Error ? reason : new Error('the operation was aborted')
}

/** Wait for a delay, rejecting when the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Build the stand-in used by every suite that needs a lock and an atomic write.
 * @returns the API plus its event log.
 */
export function createTestAtomicWrite(): TestAtomicWrite {
  const events: AtomicWriteEvent[] = []
  return {
    events,
    async writeFileAtomic(filename, content, options) {
      await mkdir(path.dirname(filename), {
        recursive: true,
        ...(options.dirMode === undefined ? {} : { mode: options.dirMode }),
      })
      const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
      try {
        await writeFile(temp, content, { mode: options.mode, flag: 'wx' })
        await rename(temp, filename)
      } catch (error) {
        await rm(temp, { force: true })
        throw error
      }
      events.push({ kind: 'write', file: filename })
    },
    async withFileLock<T>(
      filename: string,
      operation: () => Promise<T>,
      options?: { readonly signal?: AbortSignal; readonly waitMs?: number },
    ): Promise<T> {
      const lockPath = `${filename}.lock`
      const waitMs = options?.waitMs ?? 2_000
      const deadline = Date.now() + waitMs
      let delay = 5
      for (;;) {
        options?.signal?.throwIfAborted()
        try {
          await writeFile(lockPath, `${String(process.pid)}\n`, { mode: 0o600, flag: 'wx' })
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        if (Date.now() >= deadline) {
          throw new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}`)
        }
        await sleep(delay, options?.signal)
        delay = Math.min(delay * 2, 50)
      }
      events.push({ kind: 'lock-acquired', file: filename })
      try {
        return await operation()
      } finally {
        events.push({ kind: 'lock-released', file: filename })
        await rm(lockPath, { force: true })
      }
    },
  }
}

/** Whether a usable `git` is on PATH. */
export function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Run one git command and return its standard output.
 * @param cwd - working directory.
 * @param args - arguments after `git`.
 * @returns the trimmed standard output.
 */
export function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

/** Identity flags for commits in a throwaway repository. */
export const GIT_IDENTITY: readonly string[] = [
  '-c',
  'user.name=knowledge-common',
  '-c',
  'user.email=knowledge-common@example.invalid',
]
