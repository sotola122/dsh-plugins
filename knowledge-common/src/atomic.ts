/**
 * Locked, atomic updates of one text file (DESIGN §4.1, §5.1, S17):
 * `mkdir` the parent (`0700`) → `withFileLock` → read → apply → `writeFileAtomic`.
 *
 * The atomic-write functions are parameters rather than imports. Consumers take
 * them from `@deepseek-ai/dsh-atomic-write` (a peer of both plugins, DESIGN
 * §3.1) and pass the module namespace:
 *
 * ```ts
 * import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
 * await updateFileLocked({ withFileLock, writeFileAtomic }, file, update, { mode: 0o600 })
 * ```
 *
 * That keeps this module free of runtime imports, so it bundles into either
 * plugin with `noExternal` and its unit tests need no host. All-or-nothing is
 * the updater's contract: it returns `content: null` to write nothing, and a
 * thrown error leaves the file exactly as it was.
 * @module knowledge-common/atomic
 */

import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { FileLockTimeoutError } from './errors.ts'

/** Permission bits for a user-private file (`MEMORY.md`, `USER.md`, pending). */
export const PRIVATE_FILE_MODE = 0o600
/** Permission bits for a user-private directory (`$DSH_HOME/memories`, `.dsh/memory`). */
export const PRIVATE_DIRECTORY_MODE = 0o700
/** Permission bits for a file the user shares with the repository (`.gitignore`). */
export const SHARED_FILE_MODE = 0o644

/** The lock budget of the memory tool when the caller states none (DESIGN §4.4). */
export const DEFAULT_LOCK_WAIT_MS = 5_000

/**
 * The two functions this module needs from `@deepseek-ai/dsh-atomic-write`. The
 * shape matches that package's exports, so the module namespace satisfies it.
 */
export interface AtomicWriteApi {
  /**
   * Replace `filename` with `content` in one atomic step.
   * @param filename - final path receiving the content.
   * @param content - complete next file content.
   * @param options - permission bits for the replacement inode and new parents.
   */
  readonly writeFileAtomic: (
    filename: string,
    content: string | Uint8Array,
    options: { readonly mode: number; readonly dirMode?: number },
  ) => Promise<void>
  /**
   * Hold the cross-process writer lock for `filename` around one operation.
   * @param filename - the file whose writers this lock serializes.
   * @param operation - the read-render-commit cycle to run while holding it.
   * @param options - acquisition options.
   * @returns the operation's result.
   */
  readonly withFileLock: <T>(
    filename: string,
    operation: () => Promise<T>,
    options?: { readonly signal?: AbortSignal; readonly waitMs?: number },
  ) => Promise<T>
}

/** What one locked update decided. */
export interface LockedUpdate<T> {
  /** The complete next file content, or `null` to leave the file untouched. */
  readonly content: string | null
  /** The value the caller receives. */
  readonly result: T
}

/**
 * The read-modify-write step, run while the lock is held. Throwing from here
 * (or from the write) leaves the file as it was.
 * @param current - the file's content, or `null` when it does not exist.
 * @returns the content to write and the caller's result.
 */
export type LockedUpdater<T> = (current: string | null) => Promise<LockedUpdate<T>> | LockedUpdate<T>

/** Options for {@link updateFileLocked}. */
export interface LockedUpdateOptions {
  /** Permission bits stamped on the replacement inode. */
  readonly mode: number
  /** Permission bits for parent directories this call creates; defaults to `0700`. */
  readonly dirMode?: number
  /** How long to wait for the writer lock; defaults to {@link DEFAULT_LOCK_WAIT_MS}. */
  readonly lockWaitMs?: number
  /** Cancels acquisition and the update itself. */
  readonly signal?: AbortSignal
  /** Create the parent directory first (default true). */
  readonly createParent?: boolean
}

/**
 * Read a text file, treating absence as `null`.
 * @param filename - path to read.
 * @returns the content, or `null` when the file does not exist.
 */
export async function readTextFileIfExists(filename: string): Promise<string | null> {
  try {
    return await readFile(filename, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Whether an error is the atomic-write package's own lock deadline. */
function isLockTimeoutMessage(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  return /timed out waiting for the writer lock/u.test(message)
}

/**
 * Run one read-modify-write cycle under the writer lock, writing atomically and
 * only when the updater asks for a write (DESIGN §4.1, S17).
 *
 * The deadline is enforced by this call as well as by `withFileLock`, so a lock
 * that never frees surfaces as {@link FileLockTimeoutError} whatever the
 * injected implementation reports.
 * @param api - `withFileLock` and `writeFileAtomic` from `@deepseek-ai/dsh-atomic-write`.
 * @param filename - the file to update.
 * @param update - the step to run while the lock is held.
 * @param options - modes, lock budget, and cancellation.
 * @returns the updater's result.
 * @throws FileLockTimeoutError when the lock is not acquired within the budget.
 */
export async function updateFileLocked<T>(
  api: AtomicWriteApi,
  filename: string,
  update: LockedUpdater<T>,
  options: LockedUpdateOptions,
): Promise<T> {
  options.signal?.throwIfAborted()
  const dirMode = options.dirMode ?? PRIVATE_DIRECTORY_MODE
  if (options.createParent !== false) {
    await mkdir(path.dirname(filename), { recursive: true, mode: dirMode })
  }
  const waitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS
  const deadline = new AbortController()
  const timer = setTimeout(() => {
    deadline.abort(new FileLockTimeoutError(filename, waitMs))
  }, waitMs)
  const forwardAbort = (): void => {
    deadline.abort(options.signal?.reason)
  }
  options.signal?.addEventListener('abort', forwardAbort, { once: true })
  try {
    return await api.withFileLock(
      filename,
      async () => {
        const current = await readTextFileIfExists(filename)
        const decision = await update(current)
        if (decision.content !== null) {
          await api.writeFileAtomic(filename, decision.content, {
            mode: options.mode,
            dirMode,
          })
        }
        return decision.result
      },
      { signal: deadline.signal, waitMs },
    )
  } catch (error) {
    if (options.signal?.aborted === true) throw options.signal.reason
    if (deadline.signal.aborted) throw deadline.signal.reason
    if (isLockTimeoutMessage(error)) throw new FileLockTimeoutError(filename, waitMs)
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', forwardAbort)
  }
}
