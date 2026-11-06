/**
 * Error types shared by the modules that can refuse to act.
 *
 * The design states failure codes for the *tools* (`MEMORY_LOCK_TIMEOUT`,
 * `MEMORY_GITIGNORE_CONFLICT`, `MEMORY_NO_IGNORE_RULE`, …). Those codes belong
 * to the tools, which also own their wording; this module reports what
 * happened with a stable `code` so a consumer can map it to its own code:
 *
 * | `code` | consumer code (DESIGN) |
 * | --- | --- |
 * | `LOCK_TIMEOUT` | `MEMORY_LOCK_TIMEOUT` |
 * | `GITIGNORE_MALFORMED` | `MEMORY_GITIGNORE_CONFLICT` |
 * | `GITIGNORE_CONFLICT` | `MEMORY_GITIGNORE_CONFLICT` |
 * | `GITIGNORE_UNWRITABLE` | `MEMORY_NO_IGNORE_RULE` |
 * | `GITIGNORE_WRITE_MISMATCH` | `MEMORY_NO_IGNORE_RULE` |
 *
 * @module knowledge-common/errors
 */

/** Why the managed `.gitignore` block could not be written (DESIGN §5.1). */
export type GitignoreErrorCode =
  | 'GITIGNORE_MALFORMED'
  | 'GITIGNORE_CONFLICT'
  | 'GITIGNORE_UNWRITABLE'
  | 'GITIGNORE_WRITE_MISMATCH'

/**
 * The `.gitignore` edit could not be applied. The file is left untouched on
 * every one of these codes; the caller decides whether the memory store goes
 * read-only (`GITIGNORE_MALFORMED`, `GITIGNORE_CONFLICT`) or reports the block
 * a user should add by hand (`GITIGNORE_UNWRITABLE`).
 */
export class GitignoreEditError extends Error {
  /** Stable machine-readable reason. */
  readonly code: GitignoreErrorCode

  /**
   * @param code - one of the `GITIGNORE_*` reasons.
   * @param message - human-readable detail, including the file path.
   */
  constructor(code: GitignoreErrorCode, message: string) {
    super(message)
    this.name = 'GitignoreEditError'
    this.code = code
  }
}

/**
 * Waiting for the cross-process writer lock exceeded the caller's budget. The
 * lock is released by whoever holds it; nothing was written by this call.
 */
export class FileLockTimeoutError extends Error {
  /** Stable machine-readable reason. */
  readonly code = 'LOCK_TIMEOUT'

  /**
   * @param filename - the file whose lock could not be acquired.
   * @param waitMs - the budget that expired.
   */
  constructor(filename: string, waitMs: number) {
    super(`timed out after ${String(waitMs)} ms waiting for the writer lock of ${filename}`)
    this.name = 'FileLockTimeoutError'
  }
}
