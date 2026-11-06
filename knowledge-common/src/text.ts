/**
 * Text primitives shared by the entry format and the scan: the one
 * normalization pipeline (`stripFormatCharacters` → NFKC → whitespace collapse
 * → lower case), Unicode code-point counting, and the delimiter test that both
 * parsing and scanning call (DESIGN §4.1, §9).
 * @module knowledge-common/text
 */

/** The character that forms a delimiter line on its own (DESIGN §4.1). */
export const ENTRY_DELIMITER = '§'

/** Unicode format characters (`Cf`): zero-width marks, bidi controls, BOM, tags. */
const FORMAT_CHARACTER = /\p{Cf}/u

/**
 * Remove every `Cf` character. This is the first normalization step, so a
 * pattern split by a zero-width mark still matches after normalization
 * (DESIGN §9).
 * @param text - raw text.
 * @returns the text without format characters.
 */
export function stripFormatCharacters(text: string): string {
  return text.replace(/\p{Cf}/gu, '')
}

/**
 * The canonical form used for pattern matching and for duplicate detection:
 * `Cf` removal, NFKC, whitespace collapsed to single spaces and trimmed, then
 * lower case (DESIGN §4.1, §9).
 * @param text - raw text.
 * @returns the canonical comparison key.
 */
export function normalizeForMatch(text: string): string {
  return stripFormatCharacters(text).normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase()
}

/**
 * Count Unicode code points, so an astral character counts once (DESIGN §4.1).
 * @param text - text to measure.
 * @returns the number of code points.
 */
export function countCodePoints(text: string): number {
  let total = 0
  for (const _character of text) total += 1
  return total
}

/**
 * Whether a line is a delimiter line: `§` and nothing but optional surrounding
 * whitespace (DESIGN §4.1). Parsing and scanning both call this function, so a
 * line the parser treats as a boundary can never slip through the scan as
 * content.
 * @param line - one line, without its line terminator.
 * @returns true when the line separates entries.
 */
export function isDelimiterLine(line: string): boolean {
  return line.trim() === ENTRY_DELIMITER
}

/**
 * Split text into lines without their terminators, accepting `\n`, `\r\n`, and
 * a lone `\r`.
 * @param text - text to split.
 * @returns the lines in order.
 */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/u)
}

/**
 * Whether a code point is an ASCII control character that the scan refuses.
 * `\n` and `\t` are the two the format allows (DESIGN §9).
 * @param character - one code point.
 * @returns true for a rejected control character.
 */
export function isRejectedControlCharacter(character: string): boolean {
  if (character === '\n' || character === '\t') return false
  return /[\u0000-\u001F\u007F-\u009F]/u.test(character)
}

/**
 * Whether a code point is a format character (includes bidi controls and tag
 * characters, which the scan names separately for its report).
 * @param character - one code point.
 * @returns true for a `Cf` character.
 */
export function isFormatCharacter(character: string): boolean {
  return FORMAT_CHARACTER.test(character)
}
