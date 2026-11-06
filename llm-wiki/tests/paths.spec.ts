/**
 * `paths.ts` suite: the wiki's directory convention and its pure helpers.
 *
 * Every case here is an argument, not a temporary directory: the slug grammar,
 * the page/charter/catalogue paths, the repository-path link form, the code
 * masking that keeps a C++ `[[nodiscard]]` out of the link list, and the small
 * frontmatter reader. `pages-dir.spec.ts` owns `global.pagesDir`; this suite
 * covers the rest of the module, including the paths that only a malformed
 * document reaches.
 * @module @anago-harness/llm-wiki/tests/paths.spec
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertPagesDirectory,
  charterPath,
  frontmatterValue,
  indexPath,
  isPageSlug,
  linkTargetSlug,
  maskCodeSpans,
  pagePath,
  pagesDirectory,
  parseWikiLinks,
  rawDirectory,
  slugFromFileName,
  splitFrontmatter,
  WIKI_CHARTER_FILE,
  WIKI_INDEX_FILE,
  WIKI_RAW_DIRECTORY,
} from '../src/paths.ts'

describe('isPageSlug (DESIGN §6.2)', () => {
  it('refuses an empty name, a dot name, a separator, a link character, and a leading or trailing dot', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a[b', 'a]b', 'a|b', 'with:colon', '.hidden', 'trailing.']) {
      expect(isPageSlug(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('accepts the plain single-segment names a page may use', () => {
    // `<` and `>` are not separators or link characters, so the convention
    // accepts the name; the §9 scan is what refuses it later.
    for (const good of ['alpha', 'Alpha-1', 'a b', '<memory-snapshot>', '2026-10-19-pg']) {
      expect(isPageSlug(good), good).toBe(true)
    }
  })
})

describe('the paths under one wiki root (DESIGN §6.2)', () => {
  it('names the charter, the catalogue, raw/, and the page directory', () => {
    expect(charterPath('/checkout/.dsh/wiki')).toBe(path.join('/checkout/.dsh/wiki', WIKI_CHARTER_FILE))
    expect(indexPath('/checkout/.dsh/wiki')).toBe(path.join('/checkout/.dsh/wiki', WIKI_INDEX_FILE))
    expect(rawDirectory('/checkout/.dsh/wiki')).toBe(path.join('/checkout/.dsh/wiki', WIKI_RAW_DIRECTORY))
    expect(pagesDirectory('/checkout/.dsh/wiki')).toBe(path.join('/checkout/.dsh/wiki', 'pages'))
    expect(pagePath('/checkout/.dsh/wiki', 'alpha')).toBe(path.join('/checkout/.dsh/wiki', 'pages', 'alpha.md'))
  })

  it('refuses a page directory that would leave the wiki root', () => {
    expect(assertPagesDirectory('concepts')).toBe('concepts')
    expect(() => pagesDirectory('/repo', '..')).toThrow(/not a usable page directory/u)
    expect(() => pagePath('/repo', 'alpha', 'raw')).toThrow(/not a usable page directory/u)
  })
})

describe('slugFromFileName (DESIGN §6.2)', () => {
  it('returns the slug of a page file and null for every other entry', () => {
    expect(slugFromFileName('alpha.md')).toBe('alpha')
    expect(slugFromFileName('notes.txt')).toBeNull()
    expect(slugFromFileName('.md')).toBeNull()
    expect(slugFromFileName('.hidden.md')).toBeNull()
    expect(slugFromFileName('trailing..md')).toBeNull()
    expect(slugFromFileName('a/b.md')).toBeNull()
  })
})

describe('linkTargetSlug (DESIGN §6.6)', () => {
  it('reduces a repository-path link to the slug and leaves a bare slug alone', () => {
    expect(linkTargetSlug('pages/alpha')).toBe('alpha')
    expect(linkTargetSlug('concepts/esp32', 'concepts')).toBe('esp32')
    expect(linkTargetSlug('alpha')).toBe('alpha')
    // The default directory is `pages`, so another wiki's path form is not reduced.
    expect(linkTargetSlug('concepts/alpha')).toBe('concepts/alpha')
  })
})

describe('code masking (DESIGN §6.5, §6.6)', () => {
  it('blanks a fenced block without moving a line break', () => {
    const text = '# C++\n\n```cpp\n[[nodiscard]]\n```\n\n[[real]]\n'
    expect(maskCodeSpans(text).split('\n')).toHaveLength(text.split('\n').length)
    expect(maskCodeSpans(text)).toHaveLength(text.length)
    expect(parseWikiLinks(text).map(link => link.target)).toEqual(['real'])
  })

  it('blanks an inline span that crosses one line break', () => {
    const text = 'intro `[[a]]\n[[b]]` tail [[real]]'
    const masked = maskCodeSpans(text)
    expect(masked).toHaveLength(text.length)
    expect(masked.split('\n')).toHaveLength(2)
    expect(parseWikiLinks(text).map(link => link.target)).toEqual(['real'])
  })

  it('stops an unmatched run at a blank line, so it cannot swallow the rest', () => {
    const text = 'a `stray\n\n[[real]]'
    expect(parseWikiLinks(text).map(link => link.target)).toEqual(['real'])
  })

  it('treats a whitespace-only line as blank after a stray backtick', () => {
    const text = '`a\n \t\r\n[[real]]'
    expect(parseWikiLinks(text).map(link => link.target)).toEqual(['real'])
  })

  it('stops at the end of the text, and refuses to close a run of a different length', () => {
    expect(parseWikiLinks('a `b\n')).toEqual([])
    expect(parseWikiLinks('`a``b` [[real]]').map(link => link.target)).toEqual(['real'])
  })
})

describe('parseWikiLinks (DESIGN §6.6)', () => {
  it('skips a link whose body or whose target is empty', () => {
    expect(parseWikiLinks('[[   ]]')).toEqual([])
    expect(parseWikiLinks('[[#section]]')).toEqual([])
    expect(parseWikiLinks('[[global:]]')).toEqual([])
  })

  it('treats a prefix that is not global as part of an unqualified slug', () => {
    expect(parseWikiLinks('see [[concept:alpha]]')).toEqual([
      { scope: null, target: 'concept:alpha', raw: '[[concept:alpha]]' },
    ])
  })
})

describe('frontmatter (DESIGN §6.2)', () => {
  it('splits the block from the body and reports a document without one', () => {
    expect(splitFrontmatter('---\ntitle: Alpha\n---\nbody\n')).toEqual({ frontmatter: 'title: Alpha', body: 'body\n' })
    expect(splitFrontmatter('---\n\n---\nbody')).toEqual({ frontmatter: '', body: 'body' })
    expect(splitFrontmatter('no frontmatter\n')).toEqual({ frontmatter: null, body: 'no frontmatter\n' })
  })

  it('reads one scalar key, treating an empty value as absent', () => {
    const frontmatter = 'title: Alpha\nempty:\nquoted: "Beta"\n'
    expect(frontmatterValue(frontmatter, 'title')).toBe('Alpha')
    expect(frontmatterValue(frontmatter, 'quoted')).toBe('Beta')
    expect(frontmatterValue(frontmatter, 'empty')).toBeNull()
    expect(frontmatterValue(frontmatter, 'missing')).toBeNull()
    expect(frontmatterValue(null, 'title')).toBeNull()
  })
})
