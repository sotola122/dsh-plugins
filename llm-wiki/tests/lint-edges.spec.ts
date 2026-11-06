/**
 * `wiki_lint` edge cases (DESIGN §6.6): what the two walks skip, the entries the
 * process cannot stat or read, and the summary of a run that was asked to run no
 * check at all.
 *
 * Each condition is a real filesystem state — a hidden name, a directory where a
 * page file is expected, a mode that denies reading — rather than a mocked
 * `node:fs`, because the checks are defined by what `readdir`/`lstat`/`readFile`
 * actually report. The permission cases are skipped for a root process, whose
 * reads cannot be denied.
 * @module @anago-harness/llm-wiki/tests/lint-edges.spec
 */
import { chmod, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { lintWiki, type LintIssue } from '../src/lint.ts'
import {
  cleanupTempDirs,
  scaffoldWiki,
  tempDir,
  wikiDir,
  writeFileAt,
  writeIndex,
  writePage,
  writeRawSource,
} from './support.ts'

afterAll(cleanupTempDirs)

/** Whether permission bits are enforced for this process (a root process bypasses them). */
const rootUser = process.getuid?.() === 0

/** A `LintTarget` for one checkout root. */
function target(root: string) {
  return { scope: 'project' as const, wikiRoot: wikiDir(root), displayPrefix: '.dsh/wiki/' }
}

/** Turn issues into `kind` strings for readable expectations. */
function kinds(issues: readonly LintIssue[]): string[] {
  return issues.map(issue => issue.kind)
}

describe('what the walks skip (DESIGN §6.6)', () => {
  it('ignores hidden names in raw/ and in the page directory', async () => {
    const root = await tempDir('dsh-wiki-hidden-')
    await scaffoldWiki(root)
    await writeFileAt(path.join(wikiDir(root), 'raw', '.gitkeep'), '')
    await writePage(root, { slug: 'alpha' })
    await writeFileAt(path.join(wikiDir(root), 'pages', '.draft.md'), '# Draft\n')
    await writeIndex(root, ['alpha'])
    await writeRawSource(root, { relative: 'raw/topic/2026-10-19-source.md', body: 'the source\n' })
    const result = await lintWiki(target(root), { checks: ['links', 'index', 'raw'] })
    expect(result.issues).toEqual([])
    // Neither hidden entry is a page or a source, so the count stays at one.
    expect(result.summary).toMatch(/1 page\(s\), checks: links, index, raw — no issues/u)
  })

  it.skipIf(rootUser)('skips a raw/ entry it cannot stat', async () => {
    const root = await tempDir('dsh-wiki-lstat-')
    await scaffoldWiki(root)
    // The directory is listable but not traversable, so the name comes back from
    // `readdir` and `lstat` of the entry below it is denied.
    const locked = path.join(wikiDir(root), 'raw', 'locked')
    await writeFileAt(path.join(locked, 'inner.md'), 'unreadable\n')
    await chmod(locked, 0o400)
    try {
      const result = await lintWiki(target(root), { checks: ['links', 'raw'] })
      expect(result.issues).toEqual([])
    } finally {
      await chmod(locked, 0o700)
    }
  })
})

describe('an entry that cannot be read (DESIGN §6.6)', () => {
  it('reports a page it cannot read and keeps the pages it could', async () => {
    const root = await tempDir('dsh-wiki-page-read-')
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha', body: '# Alpha\n\nSee [[alpha]].\n' })
    // A directory where a page file is expected: the name is still a usable
    // slug, so the page is collected and then cannot be read.
    await mkdir(path.join(wikiDir(root), 'pages', 'broken.md'), { recursive: true })
    const result = await lintWiki(target(root), { checks: ['links'] })
    expect(kinds(result.issues)).toEqual(['unreadable'])
    expect(result.issues[0]?.path).toBe('.dsh/wiki/pages/broken.md')
    expect(result.issues[0]?.detail).toMatch(/the page could not be read/u)
  })

  it.skipIf(rootUser)('reports a source it cannot read and keeps the readable ones', async () => {
    const root = await tempDir('dsh-wiki-raw-read-')
    await scaffoldWiki(root)
    await writeRawSource(root, { relative: 'raw/topic/2026-10-19-good.md', body: 'good\n' })
    const locked = path.join(wikiDir(root), 'raw', 'topic', '2026-10-19-locked.md')
    await writeFileAt(locked, 'locked\n')
    await chmod(locked, 0o000)
    try {
      const result = await lintWiki(target(root), { checks: ['raw'] })
      expect(kinds(result.issues)).toEqual(['unreadable'])
      expect(result.issues[0]?.path).toBe('.dsh/wiki/raw/topic/2026-10-19-locked.md')
      expect(result.issues[0]?.detail).toMatch(/the source could not be read/u)
    } finally {
      await chmod(locked, 0o600)
    }
  })
})

describe('the summary line (DESIGN §6.6)', () => {
  it('says that no check ran, and counts no pages', async () => {
    const root = await tempDir('dsh-wiki-no-checks-')
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha' })
    const result = await lintWiki(target(root), { checks: [] })
    expect(result.issues).toEqual([])
    expect(result.summary).toBe('.dsh/wiki/: 0 page(s), checks: none — no issues')
  })
})
