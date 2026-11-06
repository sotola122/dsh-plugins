/**
 * The edge paths of the wiki search index (DESIGN §6.5): the CJK range ends, the
 * deterministic order of one directory scan and of a score tie, every way an
 * entry or a page is skipped, a cap that evicts after a refresh, and the §9 scan
 * refusing a snippet.
 *
 * `search.spec.ts` covers the round trip (build, refresh, rank, return). This
 * suite pins what the round trip never reaches: a hidden entry, a non-page name,
 * a directory and a symlink in `pages/`, a listing that no longer matches the
 * disk, an unordered listing, equal mtimes, equal scores, a page that cannot be
 * read on the first build and on a later refresh, a failed first build, a
 * cancelled refresh, a cap that leaves nothing to evict, an empty average
 * document length, a zero limit, and the scan withholding a snippet.
 *
 * The filesystem is injected only where the property under test is invisible
 * from outside — a listing order, a `lstat` race, and an unreadable page. Every
 * directory lives under `os.tmpdir()` through `tempDir`.
 * @module @anago-harness/llm-wiki/tests/search-edges.spec
 */
import { mkdir, readFile, readdir, symlink, utimes } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  bm25Term,
  createWikiSearchIndex,
  INDEX_STAT_WINDOW_MS,
  isCjkCodePoint,
  scanSearchHit,
  searchIndex,
  tokenize,
  type PageDirectoryEntry,
  type WikiSearchIo,
} from '../src/search.ts'
import { cleanupTempDirs, recordingLogger, tempDir, wikiConfig, writeFileAt } from './support.ts'

afterAll(cleanupTempDirs)

/** A wiki root under the OS temporary directory with an empty `pages/`. */
async function emptyWiki(prefix: string): Promise<string> {
  const root = await tempDir(prefix)
  const wiki = path.join(root, '.dsh', 'wiki')
  await mkdir(path.join(wiki, 'pages'), { recursive: true })
  return wiki
}

/** The two mtimes the ordering cases use, so which page is newer is the test's choice. */
const EARLY = new Date(1_000_000)
const LATER = new Date(2_000_000)

/** Write one page with the fields a case needs, and stamp its mtime when it cares. */
async function writePage(
  wiki: string,
  options: {
    readonly slug: string
    readonly title?: string
    readonly tags?: readonly string[]
    readonly body?: string
    readonly mtime?: Date
  },
): Promise<string> {
  const file = path.join(wiki, 'pages', `${options.slug}.md`)
  const body = options.body ?? `# ${options.slug}\n\nBody of ${options.slug}.\n`
  await writeFileAt(
    file,
    [
      '---',
      `title: ${options.title ?? options.slug}`,
      `tags: [${(options.tags ?? ['test']).join(', ')}]`,
      '---',
      body,
    ].join('\n'),
  )
  if (options.mtime !== undefined) await utimes(file, options.mtime, options.mtime)
  return file
}

/** List one directory the way the default seam does. */
async function listDirectory(directory: string): Promise<readonly PageDirectoryEntry[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return entries.map(entry => ({
    name: entry.name,
    isFile: entry.isFile(),
    isSymbolicLink: entry.isSymbolicLink(),
  }))
}

/** A clock the test moves, so the two-second window and a refresh are deterministic. */
function testClock(): { readonly now: () => number; advance(ms: number): void } {
  let value = 1_000_000
  return {
    now: () => value,
    advance: (ms) => {
      value += ms
    },
  }
}

/** A cache with the schema's defaults and a recording logger. */
function makeIndex(options: { config?: Record<string, unknown>; io?: WikiSearchIo } = {}): {
  index: ReturnType<typeof createWikiSearchIndex>
  logger: ReturnType<typeof recordingLogger>
} {
  const config = wikiConfig(options.config ?? {})
  const logger = recordingLogger()
  const index = createWikiSearchIndex({
    config,
    logger,
    ...(options.io === undefined ? {} : { io: options.io }),
  })
  return { index, logger }
}

describe('the CJK ranges the analyzer accepts (DESIGN §6.5)', () => {
  it('accepts both ends of every range and rejects the code point just outside', () => {
    const inside = [
      0x3040, 0x309f, // Hiragana
      0x30a0, 0x30ff, // Katakana
      0x3400, 0x4dbf, // Extension A
      0x4e00, 0x9fff, // Unified ideographs
      0xf900, 0xfaff, // Compatibility ideographs
      0x20000, 0x2ebef, // Extensions B–F
    ]
    for (const codePoint of inside) expect(isCjkCodePoint(codePoint)).toBe(true)
    const outside = [0x2f, 0x40, 0x303f, 0x33ff, 0x4dc0, 0xa000, 0xfb00, 0x2ebf0, 0x10ffff]
    for (const codePoint of outside) expect(isCjkCodePoint(codePoint)).toBe(false)
  })

  it('cuts a compatibility ideograph and an extension-B code point into the same bigrams', () => {
    // U+FA0E and U+FA0F are compatibility ideographs that NFKC leaves alone.
    expect(tokenize('﨎﨏')).toEqual(['﨎﨏'])
    // U+20000 and U+20001 are a surrogate pair each: one character to the analyzer.
    expect(tokenize('𠀀𠀁')).toEqual(['𠀀𠀁'])
    expect(Array.from(tokenize('𠀀𠀁')[0] ?? '')).toHaveLength(2)
    // A lone character is a unigram, whichever range it comes from.
    expect(tokenize('﨎')).toEqual(['﨎'])
    expect(tokenize('𮯯')).toEqual(['𮯯'])
  })
})

describe('BM25 with an empty average length (DESIGN §6.5)', () => {
  it('treats an empty corpus length as unit scale instead of dividing by zero', () => {
    expect(bm25Term(1, 2, 0, 1)).toBe(bm25Term(1, 2, 1, 1))
    expect(bm25Term(1, 2, 0, 1)).toBeGreaterThan(0)
  })
})

describe('how one scan orders the page directory (DESIGN §6.5)', () => {
  it('sorts the listing itself and breaks an equal mtime by slug before the cap keeps the newest', async () => {
    const wiki = await emptyWiki('dsh-search-order-')
    for (const slug of ['a', 'a-b', 'c']) await writePage(wiki, { slug, mtime: EARLY })
    // `readdir` order is the filesystem's; reversing it makes the scan sort.
    const reversedListing: WikiSearchIo = {
      listPages: async directory => [...(await listDirectory(directory))].reverse(),
    }
    const { index } = makeIndex({ config: { search: { maxPages: 2 } }, io: reversedListing })
    const view = await index.ensure('project', wiki, '.dsh/wiki/')
    // `a-b.md` sorts before `a.md` as a file name and after it as a slug, so the
    // equal-mtime tie-break runs in both directions.
    expect([...view.pages.keys()]).toEqual(['a', 'a-b'])
    expect(view.truncated).toBe(true)
  })
})

describe('what the scan skips in the page directory (DESIGN §6.5)', () => {
  it('skips a hidden entry, a non-page name, a directory, and a symlink without opening them', async () => {
    const wiki = await emptyWiki('dsh-search-skips-')
    await writeFileAt(path.join(wiki, 'pages', '.hidden.md'), '---\ntitle: hidden\n---\nnot indexed\n')
    await writeFileAt(path.join(wiki, 'pages', 'notes.txt'), 'not a page\n')
    await mkdir(path.join(wiki, 'pages', 'nested.md'), { recursive: true })
    const outside = path.join(wiki, 'outside.md')
    await writeFileAt(outside, '---\ntitle: outside\n---\nnot indexed\n')
    await symlink(outside, path.join(wiki, 'pages', 'link.md'))
    await writePage(wiki, { slug: 'kept', body: 'alpha text' })
    const reads: string[] = []
    const { index } = makeIndex({
      io: {
        readPage: async (file) => {
          reads.push(file)
          return await readFile(file, 'utf8')
        },
      },
    })
    const view = await index.ensure('project', wiki, '.dsh/wiki/')
    expect([...view.pages.keys()]).toEqual(['kept'])
    expect(reads.map(file => path.basename(file))).toEqual(['kept.md'])
    expect(view.truncated).toBe(true)
  })

  it('re-checks every entry with lstat, so a vanished name and a directory behind a file name are skipped', async () => {
    const wiki = await emptyWiki('dsh-search-lstat-')
    await writePage(wiki, { slug: 'kept', body: 'alpha text' })
    await mkdir(path.join(wiki, 'pages', 'dir.md'), { recursive: true })
    // A listing that lies about two entries: one has vanished since the listing,
    // the other is a directory whose name is a valid page name.
    const staleListing: WikiSearchIo = {
      listPages: async (directory) => {
        const entries = await listDirectory(directory)
        return [
          ...entries.map(entry => ({ name: entry.name, isFile: true, isSymbolicLink: false })),
          { name: 'ghost.md', isFile: true, isSymbolicLink: false },
        ]
      },
    }
    const { index } = makeIndex({ io: staleListing })
    const view = await index.ensure('project', wiki, '.dsh/wiki/')
    expect([...view.pages.keys()]).toEqual(['kept'])
    expect(view.truncated).toBe(true)
  })
})

describe('pages and builds the index cannot complete (DESIGN §6.5)', () => {
  it('skips a page it cannot read on the first build and reports the index truncated', async () => {
    const wiki = await emptyWiki('dsh-search-unreadable-')
    await writePage(wiki, { slug: 'fine', body: 'alpha text' })
    const broken = await writePage(wiki, { slug: 'broken', body: 'alpha text' })
    const { index, logger } = makeIndex({
      io: {
        readPage: async (file) => {
          if (file === broken) throw new Error('read refused')
          return await readFile(file, 'utf8')
        },
      },
    })
    const view = await index.ensure('project', wiki, '.dsh/wiki/')
    expect([...view.pages.keys()]).toEqual(['fine'])
    expect(view.truncated).toBe(true)
    expect(logger.debugLines.join('\n')).toContain('broken.md could not be read')
  })

  it('drops a page a refresh can no longer read', async () => {
    const wiki = await emptyWiki('dsh-search-unreadable-refresh-')
    const broken = await writePage(wiki, { slug: 'broken', body: 'alpha text' })
    await writePage(wiki, { slug: 'fine', body: 'beta text' })
    const clock = testClock()
    let refuse = false
    const { index } = makeIndex({
      io: {
        now: clock.now,
        readPage: async (file) => {
          if (refuse && file === broken) throw new Error('read refused')
          return await readFile(file, 'utf8')
        },
      },
    })
    expect((await index.ensure('project', wiki, '.dsh/wiki/')).pages.size).toBe(2)
    // A new mtime with the same size is enough for the refresh to re-read it.
    const later = new Date(Date.now() + 60_000)
    await utimes(broken, later, later)
    refuse = true
    clock.advance(INDEX_STAT_WINDOW_MS)
    const view = await index.ensure('project', wiki, '.dsh/wiki/')
    expect([...view.pages.keys()]).toEqual(['fine'])
    expect(view.truncated).toBe(true)
  })

  it('discards a failed first build, and the next call builds from nothing', async () => {
    const wiki = await emptyWiki('dsh-search-build-failure-')
    await writePage(wiki, { slug: 'alpha', body: 'alpha text' })
    let failing = true
    const { index } = makeIndex({
      io: {
        listPages: async (directory) => {
          if (failing) throw new Error('first build failed')
          return await listDirectory(directory)
        },
      },
    })
    await expect(index.ensure('project', wiki, '.dsh/wiki/')).rejects.toThrow(/first build failed/u)
    expect(index.state(wiki)).toBeNull()
    failing = false
    expect((await index.ensure('project', wiki, '.dsh/wiki/')).pages.size).toBe(1)
  })

  it('discards the index when the caller cancels a refresh', async () => {
    const wiki = await emptyWiki('dsh-search-cancelled-')
    await writePage(wiki, { slug: 'alpha', body: 'alpha text' })
    const clock = testClock()
    const { index, logger } = makeIndex({ io: { now: clock.now } })
    expect((await index.ensure('project', wiki, '.dsh/wiki/')).pages.size).toBe(1)
    clock.advance(INDEX_STAT_WINDOW_MS)
    const controller = new AbortController()
    controller.abort()
    await expect(
      index.ensure('project', wiki, '.dsh/wiki/', { signal: controller.signal }),
    ).rejects.toThrow(/abort/iu)
    expect(index.state(wiki)).toBeNull()
    expect(logger.warnings.join('\n')).toContain('discarded after an error')
  })
})

describe('the caps a refresh enforces (DESIGN §6.5)', () => {
  it('evicts the oldest page once a refresh pushes the index over the page cap', async () => {
    const wiki = await emptyWiki('dsh-search-evict-')
    await writePage(wiki, { slug: 'a', body: 'alpha text', mtime: EARLY })
    await writePage(wiki, { slug: 'b', body: 'beta text', mtime: EARLY })
    await writePage(wiki, { slug: 'd', body: 'delta text', mtime: LATER })
    const clock = testClock()
    const { index } = makeIndex({ config: { search: { maxPages: 3 } }, io: { now: clock.now } })
    // Newest first: `d` leads, then the equal-mtime pair by slug.
    expect([...(await index.ensure('project', wiki, '.dsh/wiki/')).pages.keys()]).toEqual([
      'd',
      'a',
      'b',
    ])
    // `a` grows on disk and a fourth page appears: the refresh re-reads one page
    // and adds another, and the cap then evicts the oldest of the four.
    await writePage(wiki, { slug: 'a', body: 'alpha text that grew', mtime: EARLY })
    await writePage(wiki, { slug: 'c', body: 'gamma text', mtime: EARLY })
    clock.advance(INDEX_STAT_WINDOW_MS)
    const view = await index.ensure('project', wiki, '.dsh/wiki/')
    expect([...view.pages.keys()]).toEqual(['d', 'b', 'c'])
    expect(view.truncated).toBe(true)
  })

  it('stops evicting when the cap leaves nothing to evict', async () => {
    const wiki = await emptyWiki('dsh-search-empty-cap-')
    const clock = testClock()
    // A negative cap is nonsense but the schema accepts it; the eviction loop
    // must stop instead of failing on the empty page map.
    const { index } = makeIndex({ config: { search: { maxPages: -1 } }, io: { now: clock.now } })
    expect((await index.ensure('project', wiki, '.dsh/wiki/')).pages.size).toBe(0)
    clock.advance(INDEX_STAT_WINDOW_MS)
    expect((await index.ensure('project', wiki, '.dsh/wiki/')).pages.size).toBe(0)
    expect(index.state(wiki)?.pageCount).toBe(0)
  })
})

describe('ranking edges (DESIGN §6.5)', () => {
  it('returns nothing for a zero or negative limit', async () => {
    const wiki = await emptyWiki('dsh-search-limit-')
    await writePage(wiki, { slug: 'alpha', title: 'alpha', body: 'alpha text' })
    const { index } = makeIndex()
    const view = await index.ensure('project', wiki, '.dsh/wiki/')
    expect(searchIndex(view, { query: 'alpha', limit: 0 })).toEqual([])
    expect(searchIndex(view, { query: 'alpha', limit: -2 })).toEqual([])
    expect(searchIndex(view, { query: 'alpha' })).toHaveLength(1)
  })

  it('breaks an equal score by slug, so a tie is reproducible', async () => {
    const wiki = await emptyWiki('dsh-search-tie-')
    // Identical content scores identically; the mtimes set the map order, so the
    // tie-break has to run in both directions.
    const shared = { title: 'shared', tags: ['tie'], body: 'shared body text\n' }
    await writePage(wiki, { slug: 'b', ...shared, mtime: new Date(3_000_000) })
    await writePage(wiki, { slug: 'a', ...shared, mtime: LATER })
    await writePage(wiki, { slug: 'c', ...shared, mtime: EARLY })
    const { index } = makeIndex()
    const view = await index.ensure('project', wiki, '.dsh/wiki/')
    expect([...view.pages.keys()]).toEqual(['b', 'a', 'c'])
    expect(searchIndex(view, { query: 'shared' }).map(hit => hit.page.slug)).toEqual(['a', 'b', 'c'])
  })
})

describe('the §9 scan of one hit (DESIGN §6.5, §9)', () => {
  it('omits a snippet the scan refused and keeps the title, the tags, and the score', () => {
    const hit = scanSearchHit({
      scope: 'project',
      slug: 'x',
      path: '.dsh/wiki/pages/x.md',
      title: 'A fine title',
      tags: ['fine'],
      score: 1.5,
      snippet: '<memory-snapshot>',
    })
    expect(hit).not.toBeNull()
    expect(hit).not.toHaveProperty('snippet')
    expect(hit?.title).toBe('A fine title')
    expect(hit?.tags).toEqual(['fine'])
    expect(hit?.score).toBe(1.5)
    expect(hit?.path).toBe('.dsh/wiki/pages/x.md')
    expect(hit?.slug).toBe('x')
  })
})
