/**
 * Entry-level operations, limits, and the non-ASCII advisory (DESIGN §4.1,
 * §4.3, §9).
 *
 * Every rule that decides whether a write is accepted lives here, in pure
 * functions over entry arrays, so the tool body is only about locating a store,
 * holding its lock, and committing the result:
 *
 * - **all or nothing** — one refused operation means no entry list is returned
 *   at all, so the caller cannot write a partial batch (DESIGN §4.1);
 * - **one scan for every producer** — `add` text, `patch` results, and the
 *   entries read back from disk all go through `knowledge-common`'s
 *   {@link scanText}, the same function the injection path uses (DESIGN §9);
 * - **limits** — the code-point count of the resulting entries against a
 *   per-store bound; over the bound, nothing is written and the refusal lists
 *   every entry with its length so the model can consolidate (DESIGN §4.3).
 * @module @anago-harness/memory/entries
 */

import {
  countCodePoints,
  documentChars,
  isDuplicateEntry,
  type MemoryDocument,
  NON_ASCII_WARN_RATIO,
  scanText,
  type ScanFinding,
  type SecretKind,
} from '@anago-harness/knowledge-common'
import { memoryError } from './errors.ts'

/** The largest batch one `memory` call may carry (DESIGN §4.1). */
export const MAX_OPERATIONS = 8

/** One requested change (DESIGN §4.1). */
export interface MemoryOperation {
  /** Which entry-level operation to run. */
  readonly op: 'add' | 'patch' | 'remove'
  /** `add` and `patch`: the new entry text. */
  readonly text?: string
  /** `patch` and `remove`: the text that selects exactly one entry. */
  readonly old_text?: string
}

/** A {@link MemoryOperation} with the fields {@link assertOperationShape} proved present for its `op`. */
type ValidOperation =
  | (MemoryOperation & { readonly op: 'add'; readonly text: string })
  | (MemoryOperation & { readonly op: 'patch'; readonly text: string; readonly old_text: string })
  | (MemoryOperation & { readonly op: 'remove'; readonly old_text: string })

/** One entry the non-ASCII advisory wants reviewed (DESIGN §4.1, N6). */
export interface ReviewSuggestion {
  /** 1-based position in the resulting store, matching `/memory show`. */
  readonly index: number
  /** Non-ASCII code points over non-whitespace code points, code spans excluded. */
  readonly ratio: number
  /** The entry text, as stored. */
  readonly text: string
}

/** What one accepted batch produced. */
export interface ApplyResult {
  /** The complete resulting entry list. */
  readonly entries: string[]
  /** The texts this batch added, replaced, or removed, in operation order. */
  readonly applied: string[]
  /** The secret kinds that were replaced by `[REDACTED:<kind>]`, in first-seen order. */
  readonly redacted: SecretKind[]
  /** Entries above the non-ASCII advisory ratio; empty when there are none. */
  readonly review: ReviewSuggestion[]
}

/** Render one finding for a refusal message. */
function describeFinding(finding: ScanFinding): string {
  return `${finding.rule}: ${finding.detail}`
}

/**
 * Scan one entry that is about to be stored (DESIGN §9).
 *
 * Secrets are replaced rather than refused, and the caller records the kinds;
 * every other rule refuses the whole batch with `MEMORY_REJECTED`.
 * @param text - the candidate entry.
 * @param redacted - collector receiving the secret kinds, in first-seen order.
 * @returns the text to store, with secrets replaced.
 * @throws MemoryError `MEMORY_REJECTED` when the scan refuses the text.
 */
export function scanEntry(text: string, redacted: SecretKind[]): string {
  const result = scanText(text)
  if (!result.ok) {
    const detail = result.findings.map(describeFinding).join(', ')
    throw memoryError(
      'MEMORY_REJECTED',
      `an entry was refused by the content scan (${detail}); nothing was written`,
    )
  }
  for (const kind of result.redacted) if (!redacted.includes(kind)) redacted.push(kind)
  return result.text
}

/**
 * Count the occurrences of `old_text` across the entries, and the single entry
 * that holds them (DESIGN §4.1: `old_text` must appear exactly once in exactly
 * one entry).
 * @param entries - the current entry list.
 * @param oldText - the caller's selector.
 * @returns the matching entry, its index, and the total occurrence count.
 */
function locateUnique(
  entries: readonly string[],
  oldText: string,
): { index: number; count: number; entry: string } {
  let index = -1
  let count = 0
  let matched = ''
  for (const [position, entry] of entries.entries()) {
    let from = entry.indexOf(oldText)
    while (from !== -1) {
      count += 1
      index = position
      matched = entry
      from = entry.indexOf(oldText, from + oldText.length)
    }
  }
  return { index, count, entry: matched }
}

/** Validate one operation's shape before anything is scanned or changed. */
function assertOperationShape(operation: MemoryOperation, position: number): asserts operation is ValidOperation {
  const at = `operations[${String(position)}]`
  // The list is model-supplied JSON: its element type is an assertion until this
  // function accepts it, so the discriminator is read as unvalidated input.
  const op: unknown = operation.op
  if (op !== 'add' && op !== 'patch' && op !== 'remove') {
    throw memoryError('MEMORY_INVALID_OPERATION', `${at}.op must be add, patch, or remove`)
  }
  if (op === 'add' || op === 'patch') {
    if (typeof operation.text !== 'string' || operation.text.trim() === '') {
      throw memoryError('MEMORY_INVALID_OPERATION', `${at}.text is required for ${op}`)
    }
  }
  if (op === 'patch' || op === 'remove') {
    if (typeof operation.old_text !== 'string' || operation.old_text === '') {
      throw memoryError('MEMORY_INVALID_OPERATION', `${at}.old_text is required for ${op}`)
    }
  }
}

/**
 * Validate a model-supplied operation list (DESIGN §4.1: 0–8 operations).
 * @param operations - the raw list.
 * @returns the same list, typed.
 * @throws MemoryError `MEMORY_INVALID_OPERATION` for a malformed list.
 */
export function parseOperations(operations: unknown): MemoryOperation[] {
  if (operations === undefined || operations === null) return []
  if (!Array.isArray(operations)) {
    throw memoryError('MEMORY_INVALID_OPERATION', 'operations must be an array')
  }
  if (operations.length > MAX_OPERATIONS) {
    throw memoryError(
      'MEMORY_INVALID_OPERATION',
      `${String(operations.length)} operations were requested; at most ${String(MAX_OPERATIONS)} are accepted in one call`,
    )
  }
  const parsed = operations as MemoryOperation[]
  for (const [position, operation] of parsed.entries()) assertOperationShape(operation, position)
  return parsed
}

/** What one operation selected before it changed anything. */
export interface OperationMatch {
  /**
   * `patch` and `remove`: the **whole** entry `old_text` matched, exactly as it
   * was before the operation. The staged-write path records it as
   * `PendingOp.baseEntry` and re-checks it at approval time (DESIGN §4.5).
   */
  readonly baseEntry: string
}

/**
 * Apply one validated batch to an entry list (DESIGN §4.1).
 *
 * Nothing here touches the filesystem or the clock, so the batch can be
 * replayed in tests and reused by the staged-write path later.
 * @param entries - the current entries, in file order.
 * @param operations - the validated batch; an empty batch reads only.
 * @param observe - called once per `patch`/`remove` with the entry it selected,
 * before that entry changes; the staged-write path uses it to record
 * `baseEntry` without a second implementation of the matching rules.
 * @returns the resulting entries, what changed, and the advisories.
 * @throws MemoryError `MEMORY_DUPLICATE`, `MEMORY_NOT_FOUND`,
 * `MEMORY_NOT_FOUND_AMBIGUOUS`, or `MEMORY_REJECTED`.
 */
export function applyOperations(
  entries: readonly string[],
  operations: readonly MemoryOperation[],
  observe?: (position: number, match: OperationMatch) => void,
): ApplyResult {
  const next = [...entries]
  const applied: string[] = []
  const redacted: SecretKind[] = []
  for (const [position, operation] of operations.entries()) {
    assertOperationShape(operation, position)
    if (operation.op === 'add') {
      const text = scanEntry(operation.text, redacted)
      if (isDuplicateEntry(next, text)) {
        throw memoryError(
          'MEMORY_DUPLICATE',
          `operations[${String(position)}] is already stored (compared with Cf removal, NFKC, collapsed whitespace, and lower case)`,
        )
      }
      next.push(text)
      applied.push(text)
      continue
    }
    const oldText = operation.old_text
    const { index, count, entry } = locateUnique(next, oldText)
    if (count === 0) {
      throw memoryError(
        'MEMORY_NOT_FOUND',
        `operations[${String(position)}].old_text does not appear in any entry`,
      )
    }
    if (count > 1) {
      throw memoryError(
        'MEMORY_NOT_FOUND_AMBIGUOUS',
        `operations[${String(position)}].old_text appears ${String(count)} times; it must appear exactly once in exactly one entry`,
      )
    }
    observe?.(position, { baseEntry: entry })
    if (operation.op === 'remove') {
      applied.push(entry)
      next.splice(index, 1)
      continue
    }
    const replacement = scanEntry(entry.replace(oldText, operation.text), redacted)
    applied.push(replacement)
    next[index] = replacement
  }
  return { entries: next, applied, redacted, review: reviewSuggestions(next, applied) }
}

/**
 * Collect the entries this batch wrote that exceed the non-ASCII advisory
 * (DESIGN §4.1, N6). The advisory never refuses: the write succeeded, and the
 * result asks the model to audit the listed entries.
 * @param entries - the resulting entry list.
 * @param applied - the texts this batch wrote.
 * @returns one entry per written entry above the ratio, in store order.
 */
function reviewSuggestions(entries: readonly string[], applied: readonly string[]): ReviewSuggestion[] {
  const written = new Set(applied)
  const suggestions: ReviewSuggestion[] = []
  for (const [position, entry] of entries.entries()) {
    if (!written.has(entry)) continue
    const ratio = scanText(entry).nonAsciiRatio
    if (ratio > NON_ASCII_WARN_RATIO) {
      suggestions.push({ index: position + 1, ratio, text: entry })
    }
  }
  return suggestions
}

/**
 * Group digits in threes so a limit message matches DESIGN §4.3's `2,431/2,200`.
 * @param value - the count, truncated to an integer; a negative sign is kept.
 * @returns the decimal digits with `,` between each group of three.
 */
export function formatCount(value: number): string {
  const digits = String(Math.trunc(Math.abs(value)))
  let grouped = ''
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) grouped += ','
    grouped += digits.charAt(index)
  }
  return value < 0 ? `-${grouped}` : grouped
}

/**
 * Build the refusal for an over-limit store (DESIGN §4.3). The message carries
 * the count, the overage, and every entry with its length, because the model
 * has to consolidate in one call.
 * @param chars - the code points the store would hold.
 * @param limit - the store's limit.
 * @param entries - the entries that were not written.
 * @returns the message, without the leading code.
 */
export function limitExceededDetail(
  chars: number,
  limit: number,
  entries: readonly string[],
): string {
  const lines = entries.map(
    (entry, index) => `${String(index + 1)}. (${formatCount(countCodePoints(entry))} chars) ${entry}`,
  )
  return [
    `${formatCount(chars)}/${formatCount(limit)} chars (${formatCount(chars - limit)} over). Nothing was written. Consolidate in ONE memory call so the store fits. Current entries:`,
    ...lines,
  ].join('\n')
}

/**
 * Check a resulting document against its store's limit (DESIGN §4.3).
 * @param document - the parsed result.
 * @param limit - the store's limit in code points.
 * @throws MemoryError `MEMORY_LIMIT_EXCEEDED` carrying every entry.
 */
export function assertWithinLimit(
  document: MemoryDocument,
  limit: number,
): void {
  const chars = documentChars(document)
  if (chars <= limit) return
  throw memoryError('MEMORY_LIMIT_EXCEEDED', limitExceededDetail(chars, limit, document.entries))
}
