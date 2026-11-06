/**
 * The refusals and warnings this plugin reports, and their message format.
 *
 * DSH renders a throw from a tool body as the tool result `Error: <message>`
 * (DESIGN S8), so every message begins with the stable code: the model can act
 * on the code, and a person reading a transcript can grep it. Nothing here is
 * thrown from a listener or from the pre-execute policy — a listener exception
 * ends the turn (S8), and the policy returns `{kind:'deny', reason}` instead.
 * @module @anago-harness/llm-wiki/errors
 */

/**
 * Stable failure codes.
 *
 * `WIKI_RAW_IMMUTABLE`, `WIKI_READ_ONLY`, and `WIKI_REPO_REJECTED` are DESIGN
 * §6.4's and §6.6's codes; `WIKI_APPROVAL_UNAVAILABLE` is the approval gate's
 * refusal when the session cannot be prompted; the rest belong to `wiki_write`
 * and the global wiki and are declared here so the whole vocabulary lives in
 * one place. `WIKI_IO` is this plugin's own fallback for a filesystem failure
 * it could not map.
 */
export type WikiErrorCode =
  /** A `raw/` source already exists and is immutable (DESIGN §6.4, §6.6). */
  | 'WIKI_RAW_IMMUTABLE'
  /**
   * The wiki is being written from outside `header.cwd`, by a child, or with `write`/`edit`
   * where only `wiki_write` may write (DESIGN §6.2, §6.4).
   */
  | 'WIKI_READ_ONLY'
  /** A `wiki_write` path is outside the repository, inside `.git/`, or not an allowed shape (DESIGN §6.4). */
  | 'WIKI_WRITE_INVALID'
  /** `wiki_write` was handed both `content` and `edit`, or neither (DESIGN §6.4). */
  | 'WIKI_WRITE_CONFLICT'
  /** The designated global wiki path failed one of DESIGN §6.4's checks. */
  | 'WIKI_REPO_REJECTED'
  /** No global wiki is designated, the user disabled it, or it is off for this session (DESIGN §6.4). */
  | 'WIKI_GLOBAL_DISABLED'
  /**
   * `writeApproval: ask` met an effective policy of `never`: the session cannot
   * be prompted, so the write is refused rather than performed unapproved.
   */
  | 'WIKI_APPROVAL_UNAVAILABLE'
  /** The §9 scan refused the text (DESIGN §9). */
  | 'WIKI_REJECTED'
  /** One file exceeded `write.maxPageBytes` or `write.maxRawBytes` (DESIGN §6.4). */
  | 'WIKI_LIMIT_EXCEEDED'
  /** A filesystem failure the plugin could not map to a documented code. */
  | 'WIKI_IO'

/** One refusal, carrying the code the model should act on. */
export class WikiError extends Error {
  /** The stable machine-readable code. */
  readonly code: WikiErrorCode

  /**
   * @param code - the stable code.
   * @param detail - what happened, without the code prefix.
   */
  constructor(code: WikiErrorCode, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'WikiError'
    this.code = code
  }
}

/**
 * Build one refusal. The message is `<code>: <detail>` so DSH's
 * `Error: <message>` rendering starts with the code.
 * @param code - the stable code.
 * @param detail - what happened.
 * @returns the error to throw or to render as a deny reason.
 */
export function wikiError(code: WikiErrorCode, detail: string): WikiError {
  return new WikiError(code, detail)
}

/**
 * Whether a value is one of this plugin's refusals.
 * @param value - candidate.
 * @returns true for a {@link WikiError}.
 */
export function isWikiError(value: unknown): value is WikiError {
  return value instanceof WikiError
}

/**
 * Describe any thrown value in one line, for a log message or a warning.
 * @param error - any thrown value.
 * @returns the message, or the value's string form.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
