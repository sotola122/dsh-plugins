/**
 * The wiki search index (DESIGN §6.5, implementation order 6).
 *
 * One in-process index per wiki root — never persisted, so nothing on disk can
 * break it. The wiki's page directory is the only thing indexed; `raw/` is
 * source material, and a private project wiki (`commit: false`) is indexed
 * exactly like a tracked one, because the model may read it either way. The
 * project wiki's page directory is always `pages/`; the global wiki's is
 * `config.global.pagesDir` (`pages` by default), so a repository that keeps its
 * pages under `concepts/` is searchable without moving a file.
 *
 * What one search does, in order:
 *
 * 1. **stat before reading.** Every page is `lstat`ed first; a file larger than
 *    `search.maxPageBytes` is skipped without ever being opened.
 * 2. **differential refresh.** Only files whose `mtimeMs` or `size` changed are
 *    parsed again, and files that disappeared are dropped. A call within
 *    {@link INDEX_STAT_WINDOW_MS} of the last scan does not even list the
 *    directory (DESIGN §6.5).
 * 3. **analysis.** NFKC + lower-casing, then ASCII alphanumeric runs are words
 *    and a CJK run (Han, Hiragana, Katakana) is cut into character bigrams —
 *    a lone character stays a unigram. Field weights are title and aliases 3,
 *    tags 2, body 1.
 * 4. **ranking.** BM25 with `k1 = 1.2` and `b = 0.75`; ties are broken by slug
 *    so a result is reproducible, and the caller puts `project` before
 *    `global` (DESIGN §6.4).
 * 5. **caps.** `search.maxPages` and `search.maxPostingBytes` per root, with
 *    the newest files kept; whatever the index does not cover is reported as
 *    `truncated` and surfaced by `wiki_lint`.
 *
 * A failure while refreshing throws after the index has been **discarded**, so
 * the next search rebuilds it from scratch (DESIGN §6.5).
 * @module @anago-harness/llm-wiki/search
 */

import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { scanText } from '@anago-harness/knowledge-common'
import type { WikiConfig } from './config.ts'
import { describeError } from './errors.ts'
import {
  frontmatterValue,
  pagesDirectory,
  slugFromFileName,
  splitFrontmatter,
  WIKI_FILE_EXTENSION,
  WIKI_PAGES_DIRECTORY,
} from './paths.ts'

/** Which wiki an index, a hit, or a search belongs to (DESIGN §6.5). */
export type WikiScope = 'project' | 'global'

/** The BM25 term-frequency saturation (DESIGN §6.5). */
export const BM25_K1 = 1.2

/** The BM25 length-normalization factor (DESIGN §6.5). */
export const BM25_B = 0.75

/** Weight of one occurrence in `title` or `aliases` (DESIGN §6.5). */
export const TITLE_WEIGHT = 3

/** Weight of one occurrence in `tags` (DESIGN §6.5). */
export const TAGS_WEIGHT = 2

/** Weight of one occurrence in the body (DESIGN §6.5). */
export const BODY_WEIGHT = 1

/** How many hits one search returns at most (DESIGN §6.5). */
export const MAX_SEARCH_HITS = 8

/** Length of a snippet, in code points (DESIGN §6.5). */
export const SNIPPET_CHARS = 160

/**
 * How long a finished scan is trusted (DESIGN §6.5: a call within two seconds
 * does not even `stat` the pages again).
 */
export const INDEX_STAT_WINDOW_MS = 2000

/**
 * Bytes charged to one distinct posting, on top of the term's own bytes. The
 * cap counts the memory a posting costs — the map entry, its number, and the
 * document-frequency entry — rather than the raw text, because the text of the
 * page was already read before the posting was built.
 */
export const POSTING_ENTRY_BYTES = 16

/** Upper bound on the occurrences collected for one query term, per page. */
export const SNIPPET_OCCURRENCE_LIMIT = 512

/** ASCII alphanumeric code points, after NFKC and lower-casing. */
function isAsciiAlnum(codePoint: number): boolean {
  return (
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    (codePoint >= 0x61 && codePoint <= 0x7a)
  )
}

/**
 * CJK code points: Han, Hiragana, and Katakana.
 *
 * NFKC folds the half-width katakana forms (`U+FF66`–`U+FF9D`) onto the
 * full-width ones, so they need no separate range here, and the compatibility
 * ideographs are included because NFKC leaves many of them alone.
 * @param codePoint - one code point.
 * @returns true when the character takes part in character bigrams.
 */
export function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3040 && codePoint <= 0x309f) || // Hiragana
    (codePoint >= 0x30a0 && codePoint <= 0x30ff) || // Katakana
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Unified Ideographs Extension A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK Unified Ideographs
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK Compatibility Ideographs
    (codePoint >= 0x20000 && codePoint <= 0x2ebef) // Extensions B–F
  )
}

/**
 * Split text into index terms (DESIGN §6.5).
 *
 * NFKC and lower-casing come first, so full-width Latin (`ＡＢＣ`) and a
 * zero-width-joined spelling both land on the same terms. An ASCII
 * alphanumeric run is one word; a CJK run is a sequence of overlapping
 * character **bigrams**; a run of exactly one character is that character on
 * its own, which is what makes a one-character query findable. Everything else
 * (punctuation, whitespace, Cyrillic, emoji) separates runs and is not indexed.
 * @param text - any text: a title, a tag, a body, or a query.
 * @returns the terms, in order of appearance, with duplicates kept.
 */
export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase()
  const terms: string[] = []
  let word = ''
  let run: string[] = []
  const flushWord = (): void => {
    if (word !== '') {
      terms.push(word)
      word = ''
    }
  }
  const flushRun = (): void => {
    if (run.length === 1) terms.push(run[0] as string)
    else {
      for (let index = 0; index + 1 < run.length; index += 1) {
        terms.push(`${run[index] as string}${run[index + 1] as string}`)
      }
    }
    run = []
  }
  for (const character of normalized) {
    const codePoint = character.codePointAt(0) as number
    if (isAsciiAlnum(codePoint)) {
      flushRun()
      word += character
      continue
    }
    if (isCjkCodePoint(codePoint)) {
      flushWord()
      run.push(character)
      continue
    }
    flushWord()
    flushRun()
  }
  flushWord()
  flushRun()
  return terms
}

/**
 * The distinct terms of a query, in first-seen order.
 *
 * A term repeated in the query must not multiply its own score: BM25 ranks a
 * document by *which* query terms it holds, not by how often the user typed
 * them.
 * @param query - the caller's query.
 * @returns the distinct terms.
 */
export function uniqueTerms(query: string): string[] {
  return [...new Set(tokenize(query))]
}

/**
 * Read a frontmatter list: `key: [a, b]`, `key: a, b`, or a `- item` block.
 *
 * The wiki's frontmatter is flat and small, so this deliberately understands
 * less than YAML — the same posture `frontmatterValue` takes for scalars. A key
 * that is absent, or followed by nothing, reads as an empty list.
 * @param frontmatter - the text between the fences, or `null`.
 * @param key - the key to look up.
 * @returns the items, in file order.
 */
export function frontmatterList(frontmatter: string | null, key: string): string[] {
  if (frontmatter === null) return []
  const pattern = new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.*)$`, 'u')
  const items: string[] = []
  let collecting = false
  for (const line of frontmatter.split(/\r?\n/u)) {
    if (!collecting) {
      const match = pattern.exec(line)
      if (match === null) continue
      collecting = true
      const inline = (match[1] as string).trim()
      const body = inline.startsWith('[') && inline.endsWith(']') ? inline.slice(1, -1) : inline
      for (const raw of body.split(',')) {
        items.push(unquote(raw.trim()))
      }
      continue
    }
    const item = /^[ \t]*-[ \t]*(.*)$/u.exec(line)
    if (item === null) break
    items.push(unquote((item[1] as string).trim()))
  }
  return items.filter(item => item !== '')
}

/** Remove one layer of matching quotes from a frontmatter scalar. */
function unquote(value: string): string {
  return value.replace(/^["'](.*)["']$/u, '$1').trim()
}

/** The fields of one page the index weighs (DESIGN §6.5). */
export interface PageFields {
  /** The slug the file name carries. */
  readonly slug: string
  /** `title` from the frontmatter, or the slug when there is none. */
  readonly title: string
  /** `aliases`, weighted with the title. */
  readonly aliases: readonly string[]
  /** `tags`, weighted above the body. */
  readonly tags: readonly string[]
  /** Everything after the frontmatter, used for snippets. */
  readonly body: string
}

/**
 * Read the frontmatter fields the index ranks by (DESIGN §6.2, §6.5).
 * @param slug - the page's slug.
 * @param text - the file's content.
 * @returns the fields.
 */
export function parsePageFields(slug: string, text: string): PageFields {
  const document = splitFrontmatter(text)
  return {
    slug,
    title: frontmatterValue(document.frontmatter, 'title') ?? slug,
    aliases: frontmatterList(document.frontmatter, 'aliases'),
    tags: frontmatterList(document.frontmatter, 'tags'),
    body: document.body,
  }
}

/** One page's weighted term frequencies and weighted length. */
export interface WeightedTerms {
  /** term → title/aliases × 3 + tags × 2 + body × 1. */
  readonly terms: ReadonlyMap<string, number>
  /** The same weights applied to the token counts, which is BM25's `dl`. */
  readonly length: number
}

/**
 * Weigh one page's fields (DESIGN §6.5: title and aliases 3, tags 2, body 1).
 *
 * The weight multiplies every occurrence, and the document length is the sum of
 * the same weighted counts, so BM25's length normalization compares like with
 * like.
 * @param fields - the page's fields.
 * @returns the term frequencies and the weighted length.
 */
export function weighFields(fields: PageFields): WeightedTerms {
  const terms = new Map<string, number>()
  let length = 0
  const add = (text: string, weight: number): void => {
    if (text === '') return
    for (const term of tokenize(text)) {
      terms.set(term, (terms.get(term) ?? 0) + weight)
      length += weight
    }
  }
  add([fields.title, ...fields.aliases].join(' '), TITLE_WEIGHT)
  add(fields.tags.join(' '), TAGS_WEIGHT)
  add(fields.body, BODY_WEIGHT)
  return { terms, length }
}

/**
 * What one page costs the posting budget: its term bytes plus the per-entry
 * overhead (see {@link POSTING_ENTRY_BYTES}).
 * @param terms - the weighted term frequencies.
 * @returns the bytes charged to the root's budget.
 */
export function postingBytesOf(terms: ReadonlyMap<string, number>): number {
  let bytes = 0
  for (const term of terms.keys()) bytes += Buffer.byteLength(term, 'utf8') + POSTING_ENTRY_BYTES
  return bytes
}

/** One page as the index holds it (DESIGN §6.5). */
export interface IndexedPage {
  /** The slug, i.e. the file name without `.md`. */
  readonly slug: string
  /** The absolute path of the page file. */
  readonly file: string
  /** The path as a tool receives it — `.dsh/wiki/pages/<slug>.md` or `<pagesDir>/<slug>.md`. */
  readonly display: string
  /** The mtime the last parse saw, for the differential refresh. */
  readonly mtimeMs: number
  /** The size the last parse saw. */
  readonly size: number
  /** The frontmatter title, or the slug. */
  readonly title: string
  /** The frontmatter aliases. */
  readonly aliases: readonly string[]
  /** The frontmatter tags. */
  readonly tags: readonly string[]
  /** The body, kept for the snippet window. */
  readonly body: string
  /** Weighted term frequencies. */
  readonly terms: ReadonlyMap<string, number>
  /** Weighted token count, BM25's `dl`. */
  readonly length: number
  /** Bytes this page charges to `search.maxPostingBytes`. */
  readonly postingBytes: number
}

/**
 * The inverse document frequency of one term (BM25, the `ln(1 + …)` form).
 * @param documentFrequency - how many indexed pages hold the term.
 * @param documentCount - how many pages are indexed.
 * @returns the idf; always positive, so a page that matches always scores.
 */
export function idf(documentFrequency: number, documentCount: number): number {
  return Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5))
}

/**
 * One term's BM25 contribution to one page.
 * @param termFrequency - the page's weighted frequency for the term.
 * @param documentLength - the page's weighted length.
 * @param averageLength - the mean weighted length of the indexed pages.
 * @param inverseDocumentFrequency - {@link idf} for the term.
 * @returns the contribution; 0 when the page does not hold the term.
 */
export function bm25Term(
  termFrequency: number,
  documentLength: number,
  averageLength: number,
  inverseDocumentFrequency: number,
): number {
  if (termFrequency <= 0) return 0
  const scale = averageLength <= 0 ? 1 : averageLength
  const denominator =
    termFrequency + BM25_K1 * (1 - BM25_B + (BM25_B * documentLength) / scale)
  return (inverseDocumentFrequency * (termFrequency * (BM25_K1 + 1))) / denominator
}

/** One wiki root's index (DESIGN §6.5). Readers must not mutate it. */
export interface WikiIndex {
  /** Which wiki this is. */
  readonly scope: WikiScope
  /** The wiki root: `<checkoutRoot>/.dsh/wiki` or the global repository's top. */
  readonly root: string
  /** Prefix of every `display` path: `.dsh/wiki/` for the project wiki, `''` for the global one. */
  readonly displayPrefix: string
  /** slug → page. */
  readonly pages: ReadonlyMap<string, IndexedPage>
  /** term → how many pages hold it. */
  readonly documentFrequency: ReadonlyMap<string, number>
  /** Σ of every page's weighted length. */
  readonly totalLength: number
  /** Σ of every page's posting bytes. */
  readonly postingBytes: number
  /** Whether some page file is not in the index (a cap or an unreadable file). */
  readonly truncated: boolean
  /** When the index was built from nothing. */
  readonly builtAt: number
  /** When the pages were last listed and `stat`ed. */
  readonly lastScanAt: number
}

/** The same record, mutable, as the cache owns it. */
interface MutableIndex {
  scope: WikiScope
  root: string
  displayPrefix: string
  pages: Map<string, IndexedPage>
  documentFrequency: Map<string, number>
  totalLength: number
  postingBytes: number
  truncated: boolean
  builtAt: number
  lastScanAt: number
}

/** A one-line description of a built index, for `/wiki reindex` and the lint. */
export interface WikiIndexState {
  /** Which wiki this is. */
  readonly scope: WikiScope
  /** The wiki root. */
  readonly root: string
  /** How many pages the index holds. */
  readonly pageCount: number
  /** What the postings cost against `search.maxPostingBytes`. */
  readonly postingBytes: number
  /** Whether the index covers fewer pages than the page directory holds. */
  readonly truncated: boolean
  /** When the index was built from nothing. */
  readonly builtAt: number
  /** When the pages were last listed and `stat`ed. */
  readonly lastScanAt: number
}

/**
 * The one sentence `wiki_lint` and `/wiki reindex` print about a truncated
 * index (DESIGN §6.5: "truncated: true, and lint warns").
 * @param state - a built index's state.
 * @returns the warning, with what to do about it.
 */
export function describeTruncation(state: WikiIndexState): string {
  return `the search index is truncated: it holds only ${String(state.pageCount)} of the pages under ${state.root} (search.maxPages / search.maxPostingBytes keep the newest; the rest are not searched). Raise the limit in the Profile and run /wiki reindex`
}

/** One directory entry of the page directory, as the seam hands it back. */
export interface PageDirectoryEntry {
  /** The base name. */
  readonly name: string
  /** Whether it is a regular file (a symlink reports false). */
  readonly isFile: boolean
  /** Whether it is a symbolic link. */
  readonly isSymbolicLink: boolean
}

/**
 * The three things this module reads from the filesystem.
 *
 * They are injected so a test can prove the two properties that are otherwise
 * invisible: that an oversized page is never read, and that a search within
 * {@link INDEX_STAT_WINDOW_MS} does not list the page directory at all. The
 * default implementations are the plain `node:fs/promises` calls.
 */
export interface WikiSearchIo {
  /** List one page directory (`pages/`, or the global wiki's configured one). */
  readonly listPages?: (directory: string) => Promise<readonly PageDirectoryEntry[]>
  /** Read one page as UTF-8. */
  readonly readPage?: (file: string) => Promise<string>
  /** The clock, for the two-second window. */
  readonly now?: () => number
}

/** One page file found by {@link scanPages}. */
interface PageFile {
  /** The slug the name carries. */
  readonly slug: string
  /** The absolute path. */
  readonly file: string
  /** The path a tool receives. */
  readonly display: string
  /** From `lstat`, so the refresh can compare it. */
  readonly mtimeMs: number
  /** From `lstat`, so an oversized page is caught before it is read. */
  readonly size: number
}

/** What one directory scan found. */
interface PageScan {
  /** The page files that fit `search.maxPageBytes`. */
  readonly files: PageFile[]
  /** Entries that exist under the page directory but are not indexable (too large, not a plain file, unreadable). */
  readonly skipped: number
}

/** Compare two strings in code-unit order, the ordering `sort` expects. */
function compareStrings(left: string, right: string): number {
  return Number(left > right) - Number(left < right)
}

/** Newest first, then by slug, so a truncated index keeps the newest pages. */
function byNewestFirst(left: PageFile, right: PageFile): number {
  if (left.mtimeMs !== right.mtimeMs) return right.mtimeMs - left.mtimeMs
  return compareStrings(left.slug, right.slug)
}

/** The reverse ordering, for eviction and for `/wiki reindex`'s report. */
function byOldestFirst(left: IndexedPage, right: IndexedPage): number {
  if (left.mtimeMs !== right.mtimeMs) return left.mtimeMs - right.mtimeMs
  return compareStrings(left.slug, right.slug)
}

/**
 * The page directory one scope is indexed from (DESIGN §6.2, §6.4).
 *
 * The project wiki always keeps `pages/`; only the global wiki may name another
 * single-level directory (`config.global.pagesDir`), because an existing
 * knowledge repository may hold its pages under `concepts/`.
 * @param config - the resolved plugin configuration.
 * @param scope - which wiki is being indexed.
 * @returns the directory name to scan.
 */
function pagesDirFor(config: WikiConfig, scope: WikiScope): string {
  return scope === 'global' ? config.global.pagesDir : WIKI_PAGES_DIRECTORY
}

/**
 * List and `lstat` the pages of one wiki **before reading any of them**
 * (DESIGN §6.5).
 *
 * A hidden entry, a name that is not a page slug, a symbolic link, and a file
 * larger than `search.maxPageBytes` are all skipped; the link and the size are
 * both decided from `lstat`, so an oversized page is never opened and a link
 * planted in the page directory cannot pull a file from outside the wiki into
 * the index.
 * @param io - the filesystem seam.
 * @param options - the root, the page directory, the display prefix, the size cap, and cancellation.
 * @returns the indexable files and how many entries were skipped.
 */
async function scanPages(
  io: Required<WikiSearchIo>,
  options: {
    readonly root: string
    readonly pagesDir: string
    readonly displayPrefix: string
    readonly maxPageBytes: number
    readonly signal?: AbortSignal
  },
): Promise<PageScan> {
  const directory = pagesDirectory(options.root, options.pagesDir)
  let listed: readonly PageDirectoryEntry[]
  try {
    listed = await io.listPages(directory)
  } catch (error) {
    // No page directory means an empty wiki, not a failure: the wiki may exist
    // with its catalogue and its charter only.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files: [], skipped: 0 }
    throw error
  }
  const names = [...listed].sort((left, right) => compareStrings(left.name, right.name))
  const files: PageFile[] = []
  let skipped = 0
  for (const entry of names) {
    options.signal?.throwIfAborted()
    if (entry.name.startsWith('.')) continue
    const slug = slugFromFileName(entry.name)
    if (slug === null) continue
    if (!entry.isFile || entry.isSymbolicLink) {
      skipped += 1
      continue
    }
    const file = path.join(directory, entry.name)
    let info
    try {
      info = await lstat(file)
    } catch {
      skipped += 1
      continue
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      skipped += 1
      continue
    }
    if (info.size > options.maxPageBytes) {
      skipped += 1
      continue
    }
    files.push({
      slug,
      file,
      display: `${options.displayPrefix}${options.pagesDir}/${entry.name}`,
      mtimeMs: info.mtimeMs,
      size: info.size,
    })
  }
  return { files, skipped }
}

/** Read and analyze one page, or `null` when it cannot be read. */
async function readPage(
  io: Required<WikiSearchIo>,
  file: PageFile,
  logger: WikiSearchLogger,
): Promise<IndexedPage | null> {
  let text: string
  try {
    text = await io.readPage(file.file)
  } catch (error) {
    logger.debug('dsh-llm-wiki: %s could not be read for the search index (%s)', file.file, describeError(error))
    return null
  }
  const fields = parsePageFields(file.slug, text)
  const weighted = weighFields(fields)
  return {
    slug: file.slug,
    file: file.file,
    display: file.display,
    mtimeMs: file.mtimeMs,
    size: file.size,
    title: fields.title,
    aliases: fields.aliases,
    tags: fields.tags,
    body: fields.body,
    terms: weighted.terms,
    length: weighted.length,
    postingBytes: postingBytesOf(weighted.terms),
  }
}

/** Add one page and keep the document frequencies in step. */
function addPage(index: MutableIndex, page: IndexedPage): void {
  index.pages.set(page.slug, page)
  for (const term of page.terms.keys()) {
    index.documentFrequency.set(term, (index.documentFrequency.get(term) ?? 0) + 1)
  }
  index.totalLength += page.length
  index.postingBytes += page.postingBytes
}

/** Remove one page and keep the document frequencies in step. */
function removePage(index: MutableIndex, slug: string): void {
  const page = index.pages.get(slug)
  if (page === undefined) return
  index.pages.delete(slug)
  for (const term of page.terms.keys()) {
    const remaining = (index.documentFrequency.get(term) as number) - 1
    if (remaining <= 0) index.documentFrequency.delete(term)
    else index.documentFrequency.set(term, remaining)
  }
  index.totalLength -= page.length
  index.postingBytes -= page.postingBytes
}

/**
 * Drop the oldest pages until both caps hold (DESIGN §6.5).
 *
 * The rule is "cut off the oldest and keep the newest", so eviction is by
 * mtime; it applies to the whole index rather than only to what this scan
 * added, because the cap is a property of the root, not of one refresh.
 */
function enforceCaps(index: MutableIndex, config: WikiConfig): void {
  while (
    index.pages.size > config.search.maxPages ||
    index.postingBytes > config.search.maxPostingBytes
  ) {
    const oldest = [...index.pages.values()].sort(byOldestFirst)[0]
    if (oldest === undefined) break
    removePage(index, oldest.slug)
  }
}

/** The two ways an index says it does not cover every page. */
function truncationOf(scan: PageScan, unreadable: number, index: MutableIndex): boolean {
  return scan.skipped + unreadable > 0 || index.pages.size < scan.files.length
}

/** Build one root's index from nothing. */
async function buildIndex(
  io: Required<WikiSearchIo>,
  config: WikiConfig,
  logger: WikiSearchLogger,
  scope: WikiScope,
  root: string,
  displayPrefix: string,
  signal?: AbortSignal,
): Promise<MutableIndex> {
  const scan = await scanPages(io, {
    root,
    pagesDir: pagesDirFor(config, scope),
    displayPrefix,
    maxPageBytes: config.search.maxPageBytes,
    ...(signal === undefined ? {} : { signal }),
  })
  const now = io.now()
  const index: MutableIndex = {
    scope,
    root,
    displayPrefix,
    pages: new Map(),
    documentFrequency: new Map(),
    totalLength: 0,
    postingBytes: 0,
    truncated: false,
    builtAt: now,
    lastScanAt: now,
  }
  let unreadable = 0
  for (const file of [...scan.files].sort(byNewestFirst)) {
    if (index.pages.size >= config.search.maxPages) break
    const page = await readPage(io, file, logger)
    if (page === null) {
      unreadable += 1
      continue
    }
    // One page always fits, so a tiny cap still indexes the newest page; the
    // pages after it are what the budget cuts.
    if (index.pages.size > 0 && index.postingBytes + page.postingBytes > config.search.maxPostingBytes) break
    addPage(index, page)
  }
  index.truncated = truncationOf(scan, unreadable, index)
  return index
}

/** Refresh one root's index in place, reading only what changed. */
async function refreshIndex(
  io: Required<WikiSearchIo>,
  config: WikiConfig,
  logger: WikiSearchLogger,
  index: MutableIndex,
  signal?: AbortSignal,
): Promise<void> {
  const scan = await scanPages(io, {
    root: index.root,
    pagesDir: pagesDirFor(config, index.scope),
    displayPrefix: index.displayPrefix,
    maxPageBytes: config.search.maxPageBytes,
    ...(signal === undefined ? {} : { signal }),
  })
  const onDisk = new Map(scan.files.map(file => [file.slug, file]))
  for (const slug of [...index.pages.keys()]) {
    if (!onDisk.has(slug)) removePage(index, slug)
  }
  const stale = scan.files.filter((file) => {
    const known = index.pages.get(file.slug)
    return known === undefined || known.mtimeMs !== file.mtimeMs || known.size !== file.size
  })
  let unreadable = 0
  for (const file of stale.sort(byNewestFirst)) {
    signal?.throwIfAborted()
    const page = await readPage(io, file, logger)
    if (page === null) {
      unreadable += 1
      removePage(index, file.slug)
      continue
    }
    removePage(index, file.slug)
    addPage(index, page)
  }
  enforceCaps(index, config)
  index.lastScanAt = io.now()
  index.truncated = truncationOf(scan, unreadable, index)
}

/** The logger shape this module uses. */
export interface WikiSearchLogger {
  /** A recoverable problem; the search still returns. */
  warn(message: string, ...args: unknown[]): void
  /** Normal conditions worth a trace. */
  debug(message: string, ...args: unknown[]): void
}

/** What {@link createWikiSearchIndex} needs. */
export interface WikiSearchIndexDeps {
  /** Resolved plugin configuration (`search` carries the three caps). */
  readonly config: WikiConfig
  /** Where recoverable problems go. */
  readonly logger: WikiSearchLogger
  /** The filesystem seam; the defaults are the real `node:fs/promises` calls. */
  readonly io?: WikiSearchIo
}

/**
 * The process-wide index cache (DESIGN §6.5).
 *
 * One index per wiki root, rebuilt on the first search, on a plugin reload (a
 * fresh cache), on `/wiki reindex` ({@link WikiSearchIndex.invalidate}), and
 * after an exception during a refresh — which discards the index rather than
 * leaving a half-updated one (DESIGN §6.5).
 */
export interface WikiSearchIndex {
  /**
   * The root's index, built or refreshed as needed. A call within
   * {@link INDEX_STAT_WINDOW_MS} of the last scan returns the index as it is,
   * without touching the filesystem.
   */
  ensure(
    scope: WikiScope,
    root: string,
    displayPrefix: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<WikiIndex>
  /** What an already built index holds, or `null` when this root has none. */
  state(root: string): WikiIndexState | null
  /** Discard one root's index, or every index when no root is named. */
  invalidate(root?: string): void
}

/**
 * Build the cache (DESIGN §6.5).
 * @param deps - the resolved configuration, the logger, and the filesystem seam;
 * the defaults read the real files and the real clock.
 * @returns a cache holding one index per wiki root, refreshed on demand.
 */
export function createWikiSearchIndex(deps: WikiSearchIndexDeps): WikiSearchIndex {
  const io: Required<WikiSearchIo> = {
    listPages:
      deps.io?.listPages ??
      (async directory =>
        (await readdir(directory, { withFileTypes: true })).map(entry => ({
          name: entry.name,
          isFile: entry.isFile(),
          isSymbolicLink: entry.isSymbolicLink(),
        }))),
    readPage: deps.io?.readPage ?? (async file => await readFile(file, 'utf8')),
    now: deps.io?.now ?? (() => Date.now()),
  }
  const entries = new Map<string, MutableIndex>()
  const inFlight = new Map<string, Promise<WikiIndex>>()
  let generation = 0

  /** Build or refresh one root, then cache it unless an invalidate overtook it. */
  const load = async (
    scope: WikiScope,
    root: string,
    displayPrefix: string,
    signal: AbortSignal | undefined,
  ): Promise<WikiIndex> => {
    const startedAt = generation
    const existing = entries.get(root)
    if (existing === undefined) {
      try {
        const built = await buildIndex(io, deps.config, deps.logger, scope, root, displayPrefix, signal)
        if (startedAt === generation) entries.set(root, built)
        deps.logger.debug(
          'dsh-llm-wiki: built the %s search index for %s (%d page(s)%s)',
          scope,
          root,
          built.pages.size,
          built.truncated ? ', truncated' : '',
        )
        return built
      } catch (error) {
        entries.delete(root)
        throw error
      }
    }
    if (io.now() - existing.lastScanAt < INDEX_STAT_WINDOW_MS) return existing
    try {
      await refreshIndex(io, deps.config, deps.logger, existing, signal)
    } catch (error) {
      // A refresh that threw leaves an index of unknown completeness, so it is
      // thrown away and the next search starts over (DESIGN §6.5).
      entries.delete(root)
      deps.logger.warn(
        'dsh-llm-wiki: the search index for %s was discarded after an error (%s); the next search rebuilds it',
        root,
        describeError(error),
      )
      throw error
    }
    return existing
  }

  return {
    ensure(scope, root, displayPrefix, options = {}) {
      // One load per root at a time: two parallel tool calls must not build the
      // same index twice, nor read it while the other is re-parsing a page.
      const running = inFlight.get(root)
      if (running !== undefined) return running
      const work = load(scope, root, displayPrefix, options.signal).finally(() => {
        inFlight.delete(root)
      })
      inFlight.set(root, work)
      return work
    },
    state(root) {
      const index = entries.get(root)
      if (index === undefined) return null
      return {
        scope: index.scope,
        root: index.root,
        pageCount: index.pages.size,
        postingBytes: index.postingBytes,
        truncated: index.truncated,
        builtAt: index.builtAt,
        lastScanAt: index.lastScanAt,
      }
    },
    invalidate(root) {
      // The generation counter makes an in-flight load harmless: it finishes,
      // but it does not put back what this call threw away.
      generation += 1
      if (root === undefined) entries.clear()
      else entries.delete(root)
    },
  }
}

/** One search request (DESIGN §6.5). */
export interface SearchRequest {
  /** The question, in either language. */
  readonly query: string
  /** Only pages carrying every one of these tags. */
  readonly tags?: readonly string[]
  /** How many hits to return; {@link MAX_SEARCH_HITS} is the ceiling. */
  readonly limit?: number
}

/** One ranked page, before the caller renders or scans it. */
export interface IndexHit {
  /** Which wiki the page belongs to. */
  readonly scope: WikiScope
  /** The page as the index holds it. */
  readonly page: IndexedPage
  /** The BM25 score; always greater than zero. */
  readonly score: number
}

/**
 * Normalize one tag for comparison: no leading `#`, NFKC, lower case.
 * @param tag - the tag as the page frontmatter or the query wrote it.
 * @returns the trimmed, `#`-stripped, NFKC-normalized, lower-case tag.
 */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/u, '').normalize('NFKC').toLowerCase()
}

/**
 * Rank one wiki's pages (DESIGN §6.5).
 * @param index - a built index.
 * @param request - the query, the tag filter, and the limit.
 * @returns the hits, highest score first, ties by slug; at most
 * `min(limit ?? 8, 8)` of them.
 */
export function searchIndex(index: WikiIndex, request: SearchRequest): IndexHit[] {
  const terms = uniqueTerms(request.query)
  if (terms.length === 0 || index.pages.size === 0) return []
  const wanted = (request.tags ?? []).map(normalizeTag).filter(tag => tag !== '')
  const averageLength = index.totalLength / index.pages.size
  const limit = Math.max(0, Math.min(request.limit ?? MAX_SEARCH_HITS, MAX_SEARCH_HITS))
  if (limit === 0) return []
  const hits: IndexHit[] = []
  for (const page of index.pages.values()) {
    if (wanted.length > 0) {
      const tags = new Set(page.tags.map(normalizeTag))
      if (!wanted.every(tag => tags.has(tag))) continue
    }
    let score = 0
    for (const term of terms) {
      const documentFrequency = index.documentFrequency.get(term) ?? 0
      if (documentFrequency === 0) continue
      score += bm25Term(
        page.terms.get(term) ?? 0,
        page.length,
        averageLength,
        idf(documentFrequency, index.pages.size),
      )
    }
    if (score > 0) hits.push({ scope: index.scope, page, score })
  }
  hits.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score
    return compareStrings(left.page.slug, right.page.slug)
  })
  return hits.slice(0, limit)
}

/** A body prepared for snippet windows: normalized text and the maps back to the source. */
interface NormalizedBody {
  /** The body with NFKC and lower-casing applied one code point at a time. */
  readonly text: string
  /** For each code point of `text`, its code unit index; ends with `text.length`. */
  readonly cpUnit: number[]
  /** For each code point of `text`, its code unit index in the source body; ends with the source length. */
  readonly cpSource: number[]
}

/** Normalize a body while keeping the maps back to the original text. */
function normalizeBody(body: string): NormalizedBody {
  const parts: string[] = []
  const cpUnit: number[] = []
  const cpSource: number[] = []
  let unit = 0
  let source = 0
  for (const character of body) {
    const normalized = character.normalize('NFKC').toLowerCase()
    parts.push(normalized)
    for (const codePoint of normalized) {
      cpUnit.push(unit)
      cpSource.push(source)
      unit += codePoint.length
    }
    source += character.length
  }
  cpUnit.push(unit)
  cpSource.push(source)
  return { text: parts.join(''), cpUnit, cpSource }
}

/** The first index whose value is at least `value` (binary search). */
function lowerBound(values: readonly number[], value: number): number {
  let low = 0
  let high = Math.max(0, values.length - 1)
  while (low < high) {
    const middle = (low + high) >> 1
    if ((values[middle] as number) < value) low = middle + 1
    else high = middle
  }
  return low
}

/** Where one query term occurs in a body, as code point indices. */
interface Occurrence {
  /** The code point index of the term's first character. */
  readonly start: number
  /** The code point index just past the term's last character. */
  readonly end: number
}

/**
 * Every occurrence of one term in the normalized body.
 *
 * The search runs on the normalized string (fast), and the hit is mapped back
 * through `cpUnit`: a term always starts and ends on a code point boundary,
 * because terms are whole code points.
 */
function findOccurrences(view: NormalizedBody, term: string): Occurrence[] {
  const positions: Occurrence[] = []
  let from = 0
  while (positions.length < SNIPPET_OCCURRENCE_LIMIT) {
    const at = view.text.indexOf(term, from)
    if (at === -1) break
    positions.push({
      start: lowerBound(view.cpUnit, at),
      end: lowerBound(view.cpUnit, at + term.length),
    })
    from = at + 1
  }
  return positions
}

/**
 * Pick the 160-code-point window of a body that holds the most query terms
 * (DESIGN §6.5).
 *
 * Every occurrence is a candidate start, and so is the window that *ends* at an
 * occurrence, because the terms a snippet should show may sit just before the
 * match that triggered it. A term counts only when the window holds all of it —
 * a snippet that cuts a word in half reads as corruption. Ties go to the
 * earliest window, so the result is stable. A body with none of the query terms
 * yields its opening window.
 * @param body - the page body.
 * @param terms - the distinct query terms.
 * @returns at most {@link SNIPPET_CHARS} code points of the body, trimmed.
 */
export function buildSnippet(body: string, terms: readonly string[]): string {
  if (body.trim() === '') return ''
  const view = normalizeBody(body)
  const codePoints = view.cpSource.length - 1
  const wanted = [...new Set(terms.filter(term => term !== ''))]
  const occurrences = wanted.map(term => findOccurrences(view, term))
  const candidates = new Set<number>()
  for (const positions of occurrences) {
    for (const occurrence of positions) {
      candidates.add(occurrence.start)
      candidates.add(Math.max(0, occurrence.end - SNIPPET_CHARS))
    }
  }
  let bestStart = 0
  let bestEnd = Math.min(SNIPPET_CHARS, codePoints)
  let bestCount = -1
  for (const start of [...candidates].sort((left, right) => left - right)) {
    const end = Math.min(start + SNIPPET_CHARS, codePoints)
    const count = occurrences.reduce(
      (sum, positions) =>
        sum + (positions.some(occurrence => occurrence.start >= start && occurrence.end <= end) ? 1 : 0),
      0,
    )
    if (count > bestCount) {
      bestCount = count
      bestStart = start
      bestEnd = end
    }
  }
  return body.slice(view.cpSource[bestStart], view.cpSource[bestEnd]).trim()
}

/** One hit as the tool would return it before §9 scanning. */
export interface RawSearchHit {
  /** Which wiki the page belongs to. */
  readonly scope: WikiScope
  /** The page's slug. */
  readonly slug: string
  /** The path a tool receives. */
  readonly path: string
  /** The page's title. */
  readonly title: string
  /** The page's tags. */
  readonly tags: readonly string[]
  /** The BM25 score. */
  readonly score: number
  /** The snippet window. */
  readonly snippet: string
}

/**
 * One hit as the model receives it (DESIGN §6.5).
 *
 * A field the §9 scan refused is **absent** rather than emptied, and a hit
 * whose `path` was refused is dropped entirely by {@link scanSearchHit}.
 */
export interface SearchHit {
  /** Which wiki the page belongs to. */
  readonly scope: WikiScope
  /** The page's slug. */
  readonly slug: string
  /** The path a tool receives, with any secret redacted. */
  readonly path: string
  /** The title, absent when the scan refused it. */
  readonly title?: string
  /** The tags, absent when the scan refused one of them. */
  readonly tags?: string[]
  /** The BM25 score. */
  readonly score: number
  /** The snippet, absent when the scan refused it. */
  readonly snippet?: string
}

/**
 * Apply the §9 scan to what a hit would return (DESIGN §6.5, §9).
 *
 * The rule is the design's: a secret becomes `[REDACTED:<kind>]` inside the
 * returned string, a field a refusal rule matched is not returned at all, and a
 * `path` that is refused drops the hit. The slug is taken from the **scanned**
 * path rather than from the file name, so a page file named after a secret
 * cannot leak it through `slug` while `path` is redacted. Nothing here writes a
 * file: the page on disk keeps whatever it contained, so a person can still see
 * and fix it.
 * @param hit - the hit as the index produced it.
 * @returns the hit to return, or `null` when its path was refused.
 */
export function scanSearchHit(hit: RawSearchHit): SearchHit | null {
  const scannedPath = scanText(hit.path)
  if (!scannedPath.ok) return null
  const scannedTitle = scanText(hit.title)
  const title = scannedTitle.ok ? scannedTitle.text : undefined
  let tags: string[] | undefined
  if (hit.tags.length > 0) {
    const scans = hit.tags.map(tag => scanText(tag))
    if (scans.every(scan => scan.ok)) tags = scans.map(scan => scan.text)
  }
  const scannedSnippet = scanText(hit.snippet)
  const snippet = scannedSnippet.ok ? scannedSnippet.text : undefined
  return {
    scope: hit.scope,
    slug: path.basename(scannedPath.text, WIKI_FILE_EXTENSION),
    path: scannedPath.text,
    score: hit.score,
    ...(title === undefined ? {} : { title }),
    ...(tags === undefined ? {} : { tags }),
    ...(snippet === undefined ? {} : { snippet }),
  }
}
