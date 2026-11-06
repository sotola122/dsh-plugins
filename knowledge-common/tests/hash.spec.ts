/**
 * Digest suite: the sha256 of the source body, the accepted recorded forms, and
 * the malformed-recorded case that must not compare equal.
 * @module knowledge-common/test/hash.test
 */
import { describe, expect, it } from 'vitest'
import { DIGEST_ALGORITHM, digestMatches, isDigestLike, normalizeDigest, sha256Hex } from '../src/index.ts'

const TEXT = 'first line\nsecond line\n'
const DIGEST = sha256Hex(TEXT)

describe('sha256Hex', () => {
  it('hashes UTF-8 bytes with the recorded algorithm', () => {
    expect(DIGEST_ALGORITHM).toBe('sha256')
    expect(DIGEST).toMatch(/^[0-9a-f]{64}$/u)
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('日本語')).toMatch(/^[0-9a-f]{64}$/u)
  })
})

describe('isDigestLike', () => {
  it('accepts a bare or prefixed digest in any case', () => {
    expect(isDigestLike(DIGEST)).toBe(true)
    expect(isDigestLike(`sha256:${DIGEST}`)).toBe(true)
    expect(isDigestLike(`  SHA256:${DIGEST.toUpperCase()}  `)).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isDigestLike('')).toBe(false)
    expect(isDigestLike('abc')).toBe(false)
    expect(isDigestLike(`${DIGEST.slice(1)}g`)).toBe(false)
  })
})

describe('normalizeDigest', () => {
  it('trims, drops the prefix, and lower-cases', () => {
    expect(normalizeDigest(`  SHA256:${DIGEST.toUpperCase()} `)).toBe(DIGEST)
    expect(normalizeDigest(DIGEST)).toBe(DIGEST)
  })
})

describe('digestMatches', () => {
  it('accepts the digest of the same text, prefixed or not', () => {
    expect(digestMatches(DIGEST, TEXT)).toBe(true)
    expect(digestMatches(`sha256:${DIGEST}`, TEXT)).toBe(true)
  })

  it('rejects another body and a recorded value that is not a digest', () => {
    expect(digestMatches(DIGEST, `${TEXT}edited\n`)).toBe(false)
    expect(digestMatches('not-a-digest', TEXT)).toBe(false)
  })
})
