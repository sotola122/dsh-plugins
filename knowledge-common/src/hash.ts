/**
 * Content digests (DESIGN §6.2, §6.6).
 *
 * `raw/` sources carry a `sha256` so `wiki_lint`'s `raw` check can tell a
 * hand-edited source from an untouched one, and the same digest has to be
 * produced by the writer and re-read by the checker: one function here keeps
 * both sides on the same normalization instead of leaving each to its own.
 *
 * The digest is over the source **body** (the text after the frontmatter
 * block), not the whole file: the frontmatter holds the digest itself, so
 * hashing the file would be circular.
 * @module knowledge-common/hash
 */

import { createHash } from 'node:crypto'

/** Hash algorithm of the recorded digests. */
export const DIGEST_ALGORITHM = 'sha256'

/**
 * Whether a string looks like a hex `sha256` digest, with or without the
 * `sha256:` prefix a person may write.
 * @param value - candidate digest.
 * @returns true for 64 hex digits, optionally prefixed.
 */
export function isDigestLike(value: string): boolean {
  return /^(?:sha256:)?[0-9a-f]{64}$/iu.test(value.trim())
}

/**
 * Canonicalize a recorded digest for comparison: trim, drop an optional
 * `sha256:` prefix, and lower-case it.
 * @param value - the digest as written in the file.
 * @returns the bare 64-character lower-case form.
 */
export function normalizeDigest(value: string): string {
  const trimmed = value.trim().replace(/^sha256:/iu, '')
  return trimmed.toLowerCase()
}

/**
 * The `sha256` digest of a string, as UTF-8 bytes.
 * @param text - the text to hash.
 * @returns 64 lower-case hex characters.
 */
export function sha256Hex(text: string): string {
  return createHash(DIGEST_ALGORITHM).update(text, 'utf8').digest('hex')
}

/**
 * Whether a recorded digest matches a text.
 * @param recorded - the digest from the file, prefixed or not.
 * @param text - the text to verify.
 * @returns true when the digest is well formed and equal.
 */
export function digestMatches(recorded: string, text: string): boolean {
  if (!isDigestLike(recorded)) return false
  return normalizeDigest(recorded) === sha256Hex(text)
}
