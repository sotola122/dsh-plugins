/**
 * Sanitizer suite: key redaction across its plain and base64 forms, the never-throw contract
 * for an absent key, and the bounded single-line reduction that keeps markers intact.
 * @module @anago-harness/web-search-credentials/test/sanitize.spec
 */
import { describe, expect, it } from 'vitest'
import { boundedProviderDetail, REDACTED, redactSecret } from '../src/sanitize.ts'

const SECRET = 'sk-live-9f8e7d6c5b4a'
const SECRET_BASE64 = Buffer.from(SECRET, 'utf8').toString('base64')
const SECRET_BASE64URL = Buffer.from(SECRET, 'utf8').toString('base64url')

describe('redactSecret', () => {
  it('replaces the key where the text contains it', () => {
    expect(redactSecret(`invalid token ${SECRET}`, SECRET)).toBe(`invalid token ${REDACTED}`)
  })

  it('replaces every occurrence, not only the first', () => {
    const text = `${SECRET} then ${SECRET} again ${SECRET}`
    expect(redactSecret(text, SECRET)).toBe(`${REDACTED} then ${REDACTED} again ${REDACTED}`)
  })

  it('leaves text without the key unchanged', () => {
    expect(redactSecret('rate limit exceeded', SECRET)).toBe('rate limit exceeded')
  })

  it('leaves the text unchanged when the key is empty or absent, and never throws', () => {
    expect(redactSecret('anything at all', '')).toBe('anything at all')
    expect(redactSecret('anything at all', undefined)).toBe('anything at all')
    expect(redactSecret('', SECRET)).toBe('')
    expect(redactSecret('', '')).toBe('')
  })

  it('replaces the standard base64 and base64url encodings of the key', () => {
    expect(redactSecret(`header was ${SECRET_BASE64}`, SECRET)).toBe(`header was ${REDACTED}`)
    expect(redactSecret(`header was ${SECRET_BASE64URL}`, SECRET)).toBe(`header was ${REDACTED}`)
  })

  it('treats a key carrying regular-expression metacharacters literally', () => {
    const awkward = 'a+b(c)[d]{e}^$|\\'
    const redacted = redactSecret(`echo ${awkward} end`, awkward)
    expect(redacted).toBe(`echo ${REDACTED} end`)
  })

  it('does not rescan its own replacement marker', () => {
    // `ED` occurs inside `[REDACTED]`; a second pass would nest a marker inside the first.
    expect(redactSecret('ED', 'ED')).toBe(REDACTED)
    expect(redactSecret('ED ED', 'ED')).toBe(`${REDACTED} ${REDACTED}`)
  })
})

describe('boundedProviderDetail', () => {
  it('collapses whitespace runs and trims the ends', () => {
    expect(boundedProviderDetail('  line one\n\n  line two\t', 200)).toBe('line one line two')
  })

  it('strips control characters instead of passing them to the message', () => {
    const bounded = boundedProviderDetail('bell\u0007 nul\u0000 esc\u001B end', 200)
    expect(bounded).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/u)
    expect(bounded).toContain('bell')
    expect(bounded).toContain('end')
  })

  it('truncates overlong input to the limit with an ellipsis', () => {
    const bounded = boundedProviderDetail('x'.repeat(10_000), 200)
    expect(bounded.length).toBe(200)
    expect(bounded.endsWith('…')).toBe(true)
  })

  it('returns nothing for a blank detail or a non-positive limit', () => {
    expect(boundedProviderDetail(' \n\t ', 200)).toBe('')
    expect(boundedProviderDetail('anything', 0)).toBe('')
    expect(boundedProviderDetail('anything', -1)).toBe('')
  })

  it('keeps one character of content for a one-character limit', () => {
    expect(boundedProviderDetail('anything', 1)).toBe('…')
  })

  it('backs up instead of splitting a redaction marker at the cut', () => {
    const text = `${'x'.repeat(195)}${REDACTED}${'y'.repeat(100)}`
    const bounded = boundedProviderDetail(text, 200)
    expect(bounded).toBe(`${'x'.repeat(195)}…`)
    expect(bounded).not.toContain('[REDACT')
  })

  it('does not split a surrogate pair at the cut', () => {
    const bounded = boundedProviderDetail(`${'a'.repeat(198)}😀b`, 200)
    expect(bounded).toBe(`${'a'.repeat(198)}…`)
  })

  it('keeps a redacted key out of the bounded result', () => {
    const text = `${SECRET}${'z'.repeat(5_000)}`
    const bounded = boundedProviderDetail(redactSecret(text, SECRET), 200)
    expect(bounded).not.toContain(SECRET)
    expect(bounded.startsWith(REDACTED)).toBe(true)
    expect(bounded.length).toBe(200)
  })
})
