/**
 * The refusals the `memory` tool reports to the model, and their message
 * format.
 *
 * DSH renders a throw from a tool body as the tool result `Error: <message>`
 * (DESIGN S8), so every message begins with the stable code: the model can act
 * on the code, and a person reading a transcript can grep it. Nothing in this
 * plugin throws outside tool execution; the injection path logs and skips
 * instead, because a listener exception ends the turn.
 * @module @anago-harness/memory/errors
 */

/**
 * Stable failure codes: DESIGN §4.1's table, §4.5's four staged-write codes,
 * and the two additions marked below.
 */
export type MemoryErrorCode =
  /** The writer lock was not acquired within `lockWaitMs` (DESIGN S17). */
  | 'MEMORY_LOCK_TIMEOUT'
  /** `add` text already exists, compared by canonical key (DESIGN §4.1). */
  | 'MEMORY_DUPLICATE'
  /** `old_text` matched nothing. */
  | 'MEMORY_NOT_FOUND'
  /** `old_text` matched more than once, in one entry or across entries. */
  | 'MEMORY_NOT_FOUND_AMBIGUOUS'
  /** §9's scan refused the text (DESIGN §4.1, §9). */
  | 'MEMORY_REJECTED'
  /** The store would exceed its limit; nothing was written (DESIGN §4.3). */
  | 'MEMORY_LIMIT_EXCEEDED'
  /** `target: 'workspace'` outside a git repository, or `workspace.enabled: false` (DESIGN §5.1). */
  | 'MEMORY_NO_WORKSPACE'
  /** `.dsh/memory/MEMORY.md` is not ignored and the managed block could not be written (DESIGN §5.1). */
  | 'MEMORY_NO_IGNORE_RULE'
  /** The managed block's markers are unusable, or the file changed under the edit (DESIGN §5.1). */
  | 'MEMORY_GITIGNORE_CONFLICT'
  /** `git ls-files -- .dsh/memory` is not empty; ignored rules do not apply to tracked files (DESIGN §5.1). */
  | 'MEMORY_TRACKED'
  /** A subagent child (`delegationDepth > 0`) may read but never write (DESIGN §4.4, Q3). */
  | 'MEMORY_READ_ONLY'
  /**
   * The store's pending directory already holds `pending.maxPerStore` files,
   * so nothing was staged (DESIGN §4.5).
   */
  | 'MEMORY_PENDING_FULL'
  /**
   * An id that is not a pending file of a store this session can address: the
   * form is wrong, the file is not directly under a pending directory, the
   * JSON's `id` disagrees with the file name, or the shape is not `PendingOp`
   * (DESIGN §4.5).
   */
  | 'MEMORY_PENDING_UNKNOWN'
  /**
   * The store changed between staging and approval, so the staged operation no
   * longer applies; the pending file was removed (DESIGN §4.5).
   */
  | 'MEMORY_PENDING_STALE'
  /** `approve all` exceeded 20 operations or 64 KiB of text and applied none (DESIGN §4.5). */
  | 'MEMORY_PENDING_ALL_LIMIT'
  /** The operation list is malformed (unknown op, missing `text` or `old_text`, too many). */
  | 'MEMORY_INVALID_OPERATION'
  /**
   * The session's agent preset is listed in `presets.exclude`
   * (DESIGN §4.4; the plugin's own code, not a design-table code).
   */
  | 'MEMORY_DISABLED'
  /** A filesystem failure the plugin could not map to a documented code (this plugin's own code). */
  | 'MEMORY_IO'

/** One refusal, carrying the code the model should act on. */
export class MemoryError extends Error {
  /** The stable machine-readable code. */
  readonly code: MemoryErrorCode

  /**
   * @param code - the stable code.
   * @param detail - what happened, without the code prefix.
   */
  constructor(code: MemoryErrorCode, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'MemoryError'
    this.code = code
  }
}

/**
 * Build one refusal. The message is `<code>: <detail>` so DSH's
 * `Error: <message>` rendering starts with the code (DESIGN §4.1).
 * @param code - the stable code.
 * @param detail - what happened.
 * @returns the error to throw from tool execution.
 */
export function memoryError(code: MemoryErrorCode, detail: string): MemoryError {
  return new MemoryError(code, detail)
}

/**
 * Whether a value is one of this plugin's refusals.
 * @param value - candidate.
 * @returns true for a {@link MemoryError}.
 */
export function isMemoryError(value: unknown): value is MemoryError {
  return value instanceof MemoryError
}

/**
 * Describe any thrown value in one line, for a log message or an error detail.
 * @param error - any thrown value.
 * @returns the message, or the value's string form.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
