/**
 * Secret-safe reductions of untrusted provider text. The fork's search providers build
 * model-visible `WebError` messages from text an intermediary authored — a proxy error body, a
 * gateway echo, or an exception rendered with `String()` — so the resolved key and its obvious
 * encodings are removed before any of that text enters a message, and the remainder is bounded
 * to one line.
 * @module @anago-harness/web-search-credentials/sanitize
 */

/** What every recognized occurrence of a resolved key becomes. */
export const REDACTED = '[REDACTED]'

/** Control characters remapped to a space before whitespace collapses. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]+/gu

/** Runs of whitespace the collapse reduces to one space. */
const WHITESPACE_RUN = /\s+/gu

/**
 * Normalize untrusted text to one line: control characters become a space, every whitespace
 * run collapses to one space, and both ends are trimmed.
 * @param text - the untrusted text.
 * @returns the normalized single-line text, empty when nothing printable remains.
 */
function normalizeDetail(text: string): string {
  return text.replace(CONTROL_CHARACTERS, ' ').replace(WHITESPACE_RUN, ' ').trim()
}

/**
 * The forms of a key an intermediary echo can carry: the value itself, its standard base64
 * encoding with and without padding, and its base64url encoding.
 * @param secret - the resolved key.
 * @returns the distinct non-empty forms, longest first so one scan prefers the longest match.
 */
function secretForms(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8')
  const base64 = bytes.toString('base64')
  const forms = new Set<string>([secret, base64, base64.replace(/=+$/u, ''), bytes.toString('base64url')])
  return [...forms].filter(form => form.length > 0).sort((left, right) => right.length - left.length)
}

/**
 * Escape a literal so it can serve as one alternative of a regular expression.
 * @param literal - the text to escape.
 * @returns the text with every regular-expression metacharacter escaped.
 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Whether a UTF-16 code unit starts a surrogate pair, so a truncation must not end on it.
 * @param code - the code unit at the would-be cut.
 * @returns true for a high surrogate.
 */
function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF
}

/**
 * Replace every occurrence of the resolved key with {@link REDACTED}. The scan recognizes the
 * value itself, its standard base64 encoding with and without padding, and its base64url
 * encoding, and runs once over the text, so a replacement marker is never rescanned. An absent
 * or empty key leaves the text unchanged instead of throwing, because a provider may report a
 * failure before it resolves one.
 * @param text - the untrusted text, such as an exception `String()` or a response body.
 * @param secret - the resolved key for this operation; may be empty or absent.
 * @returns the text with every recognized occurrence replaced by {@link REDACTED}.
 */
export function redactSecret(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0 || text.length === 0) return text
  const pattern = new RegExp(secretForms(secret).map(escapeRegExp).join('|'), 'gu')
  return text.replace(pattern, REDACTED)
}

/**
 * Reduce untrusted text to one line of at most `limit` characters. Control characters are
 * stripped, whitespace runs collapse to one space, and truncation backs up rather than
 * splitting a {@link REDACTED} marker or a surrogate pair, so text that already passed through
 * {@link redactSecret} keeps an intact marker. This function does not search for a key; pass
 * the text through {@link redactSecret} first.
 * @param text - the untrusted text.
 * @param limit - maximum characters in the result; a non-positive value yields the empty string.
 * @returns the bounded single-line text, empty when nothing printable remains.
 */
export function boundedProviderDetail(text: string, limit: number): string {
  const flat = normalizeDetail(text)
  if (limit <= 0) return ''
  if (flat.length <= limit) return flat
  if (limit === 1) return '…'
  let cut = limit - 1
  for (let start = flat.indexOf(REDACTED); start !== -1 && start < cut; start = flat.indexOf(REDACTED, start + 1)) {
    if (cut < start + REDACTED.length) {
      cut = start
      break
    }
  }
  if (cut > 0 && isHighSurrogate(flat.charCodeAt(cut - 1))) cut -= 1
  return `${flat.slice(0, cut).trimEnd()}…`
}
