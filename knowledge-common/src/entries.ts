/**
 * The entry format of a memory file (DESIGN §4.1): entries separated by a line
 * that holds only `§`, an optional leading HTML comment that is neither an
 * entry nor injected, Unicode code-point counting, and the canonical key used
 * for duplicate detection.
 *
 * Parsing never invents content: the delimiter test is {@link isDelimiterLine},
 * the same function the scan calls, so a line the parser treats as a boundary
 * can never be stored as entry text.
 * @module knowledge-common/entries
 */

import { countCodePoints, ENTRY_DELIMITER, isDelimiterLine, normalizeForMatch } from './text.ts'

/** A parsed memory file. */
export interface MemoryDocument {
  /**
   * The leading HTML comment, verbatim, or `null`. It is not an entry and must
   * not be injected (DESIGN §4.1); it is carried here so a rewrite does not
   * destroy a comment a user put at the top of the file.
   */
  readonly header: string | null
  /** The entries, trimmed, in file order, without the delimiters. */
  readonly entries: readonly string[]
}

/** One or more leading HTML comments, up to the first line that is not one. */
const LEADING_COMMENT = /^\s*<!--[\s\S]*?-->/u

/**
 * Parse a memory file.
 * @param text - the file content; `\r\n` and a lone `\r` are accepted and
 * normalized to `\n`, so a CRLF file does not turn every entry into a control
 * character refusal at scan time.
 * @returns the header comment and the entries.
 */
export function parseDocument(text: string): MemoryDocument {
  let rest = text.replace(/\r\n?/gu, '\n')
  let header: string | null = null
  for (;;) {
    const match = LEADING_COMMENT.exec(rest)
    if (match === null) break
    const comment = match[0].trim()
    header = header === null ? comment : `${header}\n${comment}`
    rest = rest.slice(match[0].length)
  }
  const entries: string[] = []
  let current: string[] = []
  const flush = (): void => {
    const entry = current.join('\n').trim()
    if (entry !== '') entries.push(entry)
    current = []
  }
  for (const line of rest.split('\n')) {
    if (isDelimiterLine(line)) flush()
    else current.push(line)
  }
  flush()
  return { header, entries }
}

/**
 * Render a document in the canonical form: the header comment (when present), a
 * blank line, the entries separated by `§` lines, and a final newline. Entries
 * are trimmed and empty ones dropped, so `parseDocument(serializeDocument(doc))`
 * returns `doc` unchanged.
 * @param document - the document to render.
 * @returns the file content.
 */
export function serializeDocument(document: MemoryDocument): string {
  const entries = document.entries.map(entry => entry.trim()).filter(entry => entry !== '')
  const header = document.header?.trim() ?? ''
  const body = entries.join(`\n${ENTRY_DELIMITER}\n`)
  if (header === '' && body === '') return ''
  if (header === '') return `${body}\n`
  if (body === '') return `${header}\n`
  return `${header}\n\n${body}\n`
}

/**
 * The character count a limit is measured against: the entries' code points,
 * without the header comment and without the delimiter lines (DESIGN §4.1).
 * @param document - the parsed document.
 * @returns the number of code points.
 */
export function documentChars(document: MemoryDocument): number {
  let total = 0
  for (const entry of document.entries) total += countCodePoints(entry)
  return total
}

/**
 * Whether `text` is already present, comparing canonical keys (DESIGN §4.1:
 * `MEMORY_DUPLICATE`).
 * @param entries - the existing entries.
 * @param text - the candidate entry.
 * @returns true when an entry has the same canonical key.
 */
export function isDuplicateEntry(entries: readonly string[], text: string): boolean {
  const key = normalizeForMatch(text)
  return entries.some(entry => normalizeForMatch(entry) === key)
}
