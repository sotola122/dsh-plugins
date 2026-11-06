/**
 * Store locations and the one locked read-modify-write path (DESIGN §4.1,
 * §4.3, S17).
 *
 * Three stores, one format: `$DSH_HOME/memories/MEMORY.md` (the agent's notes),
 * `$DSH_HOME/memories/USER.md` (the user profile), and
 * `<projectRoot>/.dsh/memory/MEMORY.md` (this repository's notes, only inside a
 * git worktree — see `./workspace`).
 *
 * `mkdir(0700)` → `withFileLock` → read → apply → `writeFileAtomic(0600)` is
 * `knowledge-common`'s {@link updateFileLocked}; what this module adds is the
 * mapping from its failures to the codes the model sees, and the fact that the
 * whole batch is applied inside the lock, so "one operation failed" can never
 * leave a partial file. {@link updateStoreChecked} adds the one thing the
 * staged path needs: a re-check that runs inside that same lock (DESIGN §4.5).
 * @module @anago-harness/memory/store
 */

import path from 'node:path'
import {
  type AtomicWriteApi,
  documentChars,
  FileLockTimeoutError,
  type MemoryDocument,
  parseDocument,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  readTextFileIfExists,
  type SecretKind,
  serializeDocument,
  updateFileLocked,
} from '@anago-harness/knowledge-common'
import { describeError, isMemoryError, memoryError } from './errors.ts'
import {
  applyOperations,
  assertWithinLimit,
  type MemoryOperation,
  type ReviewSuggestion,
} from './entries.ts'
import { MEMORY_FILE_NAME, USER_FILE_NAME, type WorkspaceStore } from './workspace.ts'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** The three stores a `memory` call can address (DESIGN §4.1). */
export type MemoryTarget = 'memory' | 'user' | 'workspace'

/** One addressable store. */
export interface StoreLocation {
  /** Which store this is. */
  readonly target: MemoryTarget
  /** Absolute path of its Markdown file. */
  readonly path: string
  /** Its code-point limit (DESIGN §4.3). */
  readonly limit: number
  /** A short label for headings and messages. */
  readonly label: string
}

/** Label of the global notes file, as the snapshot heading renders it. */
export const MEMORY_LABEL = 'Global memory'

/** Label of the user profile, as the snapshot heading renders it. */
export const USER_LABEL = 'User profile'

/** Label of the workspace store, as the snapshot heading renders it. */
export const WORKSPACE_LABEL = 'Workspace memory'

/**
 * The global store for one target (DESIGN §4.1). `$DSH_HOME/memories` is fixed;
 * only the environment decides where the harness home is.
 * @param target - `memory` or `user`.
 * @param limit - the store's code-point limit.
 * @returns the location.
 */
export function globalStore(target: 'memory' | 'user', limit: number): StoreLocation {
  const file = target === 'memory' ? MEMORY_FILE_NAME : USER_FILE_NAME
  return {
    target,
    path: dshHomePath('memories', file),
    limit,
    label: target === 'memory' ? MEMORY_LABEL : USER_LABEL,
  }
}

/**
 * The workspace store of one resolved repository.
 * @param store - the resolved workspace store.
 * @param limit - the store's code-point limit.
 * @returns the location.
 */
export function workspaceLocation(store: WorkspaceStore, limit: number): StoreLocation {
  return { target: 'workspace', path: store.file, limit, label: WORKSPACE_LABEL }
}

/**
 * The path of the file shown for a target, without touching the filesystem.
 * @param location - the store whose file is shown.
 * @returns `.dsh/memory/MEMORY.md` for the workspace store, else the store
 * file's base name.
 */
export function displayPath(location: StoreLocation): string {
  return location.target === 'workspace'
    ? path.join('.dsh', 'memory', MEMORY_FILE_NAME)
    : path.basename(location.path)
}

/** What one read found. */
export interface StoreReadResult {
  /** Whether the file exists. */
  readonly exists: boolean
  /** The parsed document; an absent file reads as an empty one. */
  readonly document: MemoryDocument
}

/**
 * Read one store. Absence is not an error: a store that was never written has
 * no entries, and the first write creates it.
 * @param location - the store to read.
 * @returns its document and whether the file existed.
 * @throws MemoryError `MEMORY_IO` when the file exists but cannot be read.
 */
export async function readStore(location: StoreLocation): Promise<StoreReadResult> {
  try {
    const content = await readTextFileIfExists(location.path)
    return { exists: content !== null, document: parseDocument(content ?? '') }
  } catch (error) {
    throw memoryError('MEMORY_IO', `${location.path} could not be read (${describeError(error)})`)
  }
}

/** What one accepted batch produced. */
export interface StoreUpdateResult {
  /** The complete resulting entry list. */
  readonly entries: string[]
  /** The texts this batch wrote, in operation order. */
  readonly applied: string[]
  /** The secret kinds replaced by `[REDACTED:<kind>]`. */
  readonly redacted: SecretKind[]
  /** Entries above the non-ASCII advisory ratio. */
  readonly review: ReviewSuggestion[]
  /** The resulting code-point count. */
  readonly chars: number
}

/** Inputs for {@link updateStore}. */
export interface StoreUpdateOptions {
  /** `withFileLock` and `writeFileAtomic` from `@deepseek-ai/dsh-atomic-write`. */
  readonly api: AtomicWriteApi
  /** Writer-lock budget. */
  readonly lockWaitMs: number
  /** Cancellation; an aborted call writes nothing. */
  readonly signal?: AbortSignal
}

/** A re-check that runs inside the store's writer lock (DESIGN §4.5). */
export type StoreUpdateGuard = (document: MemoryDocument) => void

/**
 * Apply one batch to one store, all or nothing (DESIGN §4.1).
 *
 * The updater throws on the first refused operation, on a refused scan, and on
 * an over-limit result; `updateFileLocked` turns each of those into "the file
 * was never touched". The header comment and the canonical `§` layout are
 * preserved for the entries that survive.
 * @param location - the store to update.
 * @param operations - one to eight validated operations.
 * @param options - atomic-write seam, lock budget, and cancellation.
 * @returns the resulting entries, what changed, and the advisories.
 * @throws MemoryError `MEMORY_LOCK_TIMEOUT`, `MEMORY_IO`, or any refusal from
 * {@link applyOperations} and {@link assertWithinLimit}.
 */
export async function updateStore(
  location: StoreLocation,
  operations: readonly MemoryOperation[],
  options: StoreUpdateOptions,
): Promise<StoreUpdateResult> {
  return await updateStoreChecked(location, operations, options)
}

/**
 * Apply one batch with a re-check inside the lock (DESIGN §4.5).
 *
 * The staged-write path needs its `baseEntry` check to be part of the same
 * locked read-modify-write as the change it guards: reading the store first and
 * writing afterwards would leave a window in which a direct edit (N2 allows
 * them) could invalidate the staged operation. A guard that throws therefore
 * writes nothing, exactly like a refused operation.
 * @param location - the store to update.
 * @param operations - the validated operations to apply.
 * @param options - atomic-write seam, lock budget, and cancellation.
 * @param guard - runs after the parse and before the operations; may throw.
 * @returns the resulting entries, what changed, and the advisories.
 * @throws MemoryError from the guard, `MEMORY_LOCK_TIMEOUT`, `MEMORY_IO`, or
 * any refusal from {@link applyOperations} and {@link assertWithinLimit}.
 */
export async function updateStoreChecked(
  location: StoreLocation,
  operations: readonly MemoryOperation[],
  options: StoreUpdateOptions,
  guard?: StoreUpdateGuard,
): Promise<StoreUpdateResult> {
  try {
    return await updateFileLocked<StoreUpdateResult>(
      options.api,
      location.path,
      (current) => {
        const document = parseDocument(current ?? '')
        guard?.(document)
        const applied = applyOperations(document.entries, operations)
        const next: MemoryDocument = { header: document.header, entries: applied.entries }
        assertWithinLimit(next, location.limit)
        return {
          content: serializeDocument(next),
          result: {
            entries: applied.entries,
            applied: applied.applied,
            redacted: applied.redacted,
            review: applied.review,
            chars: documentChars(next),
          },
        }
      },
      {
        mode: PRIVATE_FILE_MODE,
        dirMode: PRIVATE_DIRECTORY_MODE,
        lockWaitMs: options.lockWaitMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    )
  } catch (error) {
    if (isMemoryError(error)) throw error
    if (error instanceof FileLockTimeoutError) {
      throw memoryError(
        'MEMORY_LOCK_TIMEOUT',
        `${location.path} stayed locked for ${String(options.lockWaitMs)} ms; nothing was written`,
      )
    }
    throw memoryError('MEMORY_IO', `${location.path} could not be written (${describeError(error)})`)
  }
}

/**
 * The code-point count of a document, for a read-only result.
 * @param document - the parsed store document.
 * @returns the entries' code points, excluding the header comment and the
 * delimiters, which is the count a store limit is measured against.
 */
export function charsOf(document: MemoryDocument): number {
  return documentChars(document)
}
