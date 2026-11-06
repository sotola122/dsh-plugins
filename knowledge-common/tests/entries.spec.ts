/**
 * Entry-format suite (DESIGN §4.1, §10 字数と区切り): the `§` delimiter, the
 * leading HTML comment that is neither counted nor injected, code-point
 * counting, and the canonical key behind duplicate detection.
 * @module knowledge-common/test/entries.test
 */
import { describe, expect, it } from 'vitest'
import {
  countCodePoints,
  documentChars,
  isDelimiterLine,
  isDuplicateEntry,
  normalizeForMatch,
  parseDocument,
  scanText,
  serializeDocument,
} from '../src/index.ts'

describe('isDelimiterLine', () => {
  const cases: ReadonlyArray<readonly [string, boolean]> = [
    ['§', true],
    ['  §  ', true],
    ['\t§', true],
    ['§§', false],
    ['a § b', false],
    ['§ text', false],
    ['text §', false],
    ['', false],
    ['# §', false],
  ]
  for (const [line, expected] of cases) {
    it(`${JSON.stringify(line)} → ${String(expected)}`, () => {
      expect(isDelimiterLine(line)).toBe(expected)
    })
  }

  it('is the same test the scan applies', () => {
    expect(scanText('first\n§\nsecond').rules).toContain('delimiter-line')
    expect(parseDocument('first\n§\nsecond').entries).toEqual(['first', 'second'])
    expect(scanText('first § second').ok).toBe(true)
    expect(parseDocument('first § second').entries).toEqual(['first § second'])
  })
})

describe('parseDocument', () => {
  it('separates entries and keeps the leading comment out of them', () => {
    const document = parseDocument('<!-- Keep this note. -->\nEntry one.\n§\nEntry two.\n')
    expect(document.header).toBe('<!-- Keep this note. -->')
    expect(document.entries).toEqual(['Entry one.', 'Entry two.'])
  })

  it('accepts several leading comments', () => {
    const document = parseDocument('<!-- one -->\n<!-- two -->\nEntry.\n')
    expect(document.header).toBe('<!-- one -->\n<!-- two -->')
    expect(document.entries).toEqual(['Entry.'])
  })

  it('treats an unterminated comment as content', () => {
    const document = parseDocument('<!-- never closed\nEntry.\n')
    expect(document.header).toBeNull()
    expect(document.entries).toEqual(['<!-- never closed\nEntry.'])
  })

  it('drops empty entries and keeps multi-line ones', () => {
    const document = parseDocument('one\n§\n\n§\ntwo\nline\n')
    expect(document.entries).toEqual(['one', 'two\nline'])
  })

  it('normalizes CRLF so the scan does not see a control character', () => {
    const document = parseDocument('Entry one.\r\n§\r\nEntry two.\r\n')
    expect(document.entries).toEqual(['Entry one.', 'Entry two.'])
    for (const entry of document.entries) expect(scanText(entry).ok).toBe(true)
  })

  it('returns nothing for an empty or whitespace-only file', () => {
    expect(parseDocument('')).toEqual({ header: null, entries: [] })
    expect(parseDocument('\n\n  \n')).toEqual({ header: null, entries: [] })
  })
})

describe('serializeDocument', () => {
  it('round-trips through parse', () => {
    const document = parseDocument('<!-- note -->\nEntry one.\n§\nEntry two.\n')
    expect(parseDocument(serializeDocument(document))).toEqual(document)
  })

  it('writes the canonical form', () => {
    expect(serializeDocument({ header: '<!-- note -->', entries: ['one', 'two'] })).toBe(
      '<!-- note -->\n\none\n§\ntwo\n',
    )
    expect(serializeDocument({ header: null, entries: ['one'] })).toBe('one\n')
    expect(serializeDocument({ header: '<!-- note -->', entries: [] })).toBe('<!-- note -->\n')
    expect(serializeDocument({ header: null, entries: [] })).toBe('')
  })

  it('trims entries and drops empty ones', () => {
    expect(serializeDocument({ header: null, entries: ['  one  ', '', 'two'] })).toBe('one\n§\ntwo\n')
  })

  it('is stable when applied twice', () => {
    const once = serializeDocument({ header: null, entries: ['one', 'two\nlines'] })
    expect(serializeDocument(parseDocument(once))).toBe(once)
  })
})

describe('character counting', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(countCodePoints('abc')).toBe(3)
    expect(countCodePoints('𝄞')).toBe(1)
    expect(countCodePoints('日本語')).toBe(3)
    expect(countCodePoints('a𝄞日')).toBe(3)
  })

  it('sums the entries without the header or the delimiters', () => {
    const document = parseDocument('<!-- note -->\none\n§\ntwo\n')
    expect(documentChars(document)).toBe(6)
    expect(documentChars({ header: null, entries: [] })).toBe(0)
  })
})

describe('duplicate keys', () => {
  it('ignores case, whitespace, compatibility forms, and format characters', () => {
    const entries = ['Always run the tests before committing.']
    expect(isDuplicateEntry(entries, 'always   run the tests before committing.')).toBe(true)
    expect(isDuplicateEntry(entries, 'Ａlways run the tests before committing.')).toBe(true)
    expect(isDuplicateEntry(entries, 'Always run\u200B the tests before committing.')).toBe(true)
    expect(isDuplicateEntry(entries, 'Always run the linter before committing.')).toBe(false)
  })

  it('uses the documented key', () => {
    expect(normalizeForMatch('  Ａ  B\u200B ')).toBe('a b')
  })
})
