/**
 * `wiki_lint`'s three checks (DESIGN §6.6, sixth revision).
 *
 * The tool reports only what the design still keeps:
 *
 * | check | what it reports |
 * | --- | --- |
 * | `links` | unresolved `[[slug]]` and `[[global:slug]]` |
 * | `index` | the `index.md` ⟷ page-directory mismatch |
 * | `raw` | a `raw/` source whose `sha256` does not match its body |
 *
 * The page directory is `pages/` for the project wiki and
 * `config.global.pagesDir` for the global one, so a repository that keeps its
 * pages under `concepts/` is linted rather than reported as empty. A link
 * resolves when it names any of the wiki's own referenceable things:
 *
 * - a page, by bare slug (`[[esp32-s31]]`) or path
 *   (`[[concepts/esp32-s31|esp32-s31]]`, `[[pages/alpha]]`);
 * - the catalogue (`[[index#C++|C++]]`);
 * - a `raw/` source, by base name (`[[mcu-rf-update-2026-09-14]]`) or
 *   repository-relative path with or without the extension
 *   (`[[raw/articles/ESP32-S31|ESP32-S31]]`).
 *
 * Matching is case-sensitive, like a file name. A `[[...]]` inside an inline
 * code span or a fenced block is not a link at all, so a C++ page may discuss
 * `[[nodiscard]]` without being reported. `raw/` is not configurable.
 * Two things it deliberately does **not** do: there is no cross-scope
 * `ambiguous` warning when both wikis hold the same slug (an unqualified link
 * resolves inside its own wiki and `global:` in the global one), and orphaned
 * pages, duplicates, and staleness are left to the skill's prose. The raw
 * digest is checked against the **body** — the text after the frontmatter —
 * because the recorded digest lives in that frontmatter.
 * @module @anago-harness/llm-wiki/lint
 */

import { lstat, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { digestMatches, isDigestLike } from '@anago-harness/knowledge-common'
import { describeError } from './errors.ts'
import {
  frontmatterValue,
  indexPath,
  linkTargetSlug,
  maskCodeSpans,
  pagePath,
  pagesDirectory,
  parseWikiLinks,
  rawDirectory,
  slugFromFileName,
  splitFrontmatter,
  WIKI_FILE_EXTENSION,
  WIKI_INDEX_SLUG,
  WIKI_PAGES_DIRECTORY,
  WIKI_RAW_DIRECTORY,
} from './paths.ts'

/** The checks `wiki_lint` can run (DESIGN §6.6). */
export type LintCheck = 'links' | 'index' | 'raw'

/** Every check, in the order the tool runs them. */
export const LINT_CHECKS: readonly LintCheck[] = ['links', 'index', 'raw']

/** Upper bound on returned issues (DESIGN §6.6). */
export const MAX_LINT_ISSUES = 50

/** What a lint issue is about (DESIGN §6.6, sixth revision). */
export type LintIssueKind =
  /** A `[[slug]]` that no page, `index`, or `raw/` source in this wiki resolves. */
  | 'unresolved-link'
  /** A `[[global:slug]]` that the global wiki does not resolve. */
  | 'unresolved-global-link'
  /** A page that `index.md` does not list. */
  | 'index-missing'
  /** An `index.md` entry whose page does not exist. */
  | 'index-stale'
  /** The same slug listed more than once in `index.md`. */
  | 'index-duplicate'
  /** A `raw/` source without a usable `sha256`. */
  | 'raw-digest-missing'
  /** A `raw/` source whose `sha256` does not match its body. */
  | 'raw-digest-mismatch'
  /** A file under the page directory or `raw/` that could not be read. */
  | 'unreadable'

/** One finding (DESIGN §6.6). */
export interface LintIssue {
  /** Which wiki the finding belongs to. */
  readonly scope: 'project' | 'global'
  /** The kind of mismatch. */
  readonly kind: LintIssueKind
  /** Repository-relative path of the file to fix. */
  readonly path: string
  /** One line a person or the model can act on. */
  readonly detail: string
}

/** The whole result of one lint run. */
export interface LintResult {
  /** At most {@link MAX_LINT_ISSUES} findings, in check order. */
  readonly issues: LintIssue[]
  /** One line: what was scanned, what was found, and whether the list was cut. */
  readonly summary: string
}

/** Where one wiki's pages and raw sources live, plus its display path. */
export interface LintTarget {
  /** Which wiki this is. */
  readonly scope: 'project' | 'global'
  /** The wiki root that holds `index.md`, the page directory, and `raw/`. */
  readonly wikiRoot: string
  /** Prefix used in `LintIssue.path`, so a path reads as a person would type it. */
  readonly displayPrefix: string
  /**
   * The page directory name. `pages` by default; the global wiki may configure
   * another single-level name (`config.global.pagesDir`), because an existing
   * knowledge repository may keep its pages under `concepts/`. `raw/` is not
   * configurable.
   */
  readonly pagesDir?: string
  /**
   * How the summary names this wiki. The global wiki's paths are relative to
   * its repository top, so its display prefix is empty and the label would be
   * too; the project wiki leaves this undefined and its prefix is used.
   */
  readonly summaryLabel?: string
}

/** The page directory of one target, defaulting to the project convention. */
function pagesDirOf(target: LintTarget): string {
  return target.pagesDir ?? WIKI_PAGES_DIRECTORY
}

/** Inputs for {@link lintWiki}. */
export interface LintOptions {
  /**
   * Which checks to run; the caller resolves them (an explicit argument, else
   * `config.lint.checks`, else all three).
   */
  readonly checks: readonly LintCheck[]
  /**
   * Slugs the global wiki resolves, for `[[global:slug]]`. Omitted or empty
   * means the global wiki has no page with any slug, which makes every
   * qualified link unresolved — the honest answer when no global wiki is
   * designated (DESIGN §6.6).
   */
  readonly globalSlugs?: ReadonlySet<string>
  /** The global wiki's page directory, for a `[[global:<pagesDir>/slug]]` link. */
  readonly globalPagesDir?: string
  /** Whether a global wiki is configured at all. */
  readonly globalEnabled?: boolean
}

/** A page found on disk. */
interface PageFile {
  /** The slug the file name carries. */
  readonly slug: string
  /** Absolute path. */
  readonly file: string
  /** Repository-relative path, for issues. */
  readonly display: string
  /** The file content. */
  readonly text: string
}

/**
 * Everything one wiki's unqualified `[[...]]` links may resolve to.
 *
 * The sets are built from disk, so a link resolves exactly when the thing it
 * names exists. Matching is case-sensitive, as a file name is.
 */
interface LinkTargets {
  /** Page slugs, i.e. the file names under the page directory without `.md`. */
  readonly pageSlugs: ReadonlySet<string>
  /** `raw/` sources by base name without `.md`, at any depth below `raw/`. */
  readonly rawNames: ReadonlySet<string>
  /** `raw/` sources by repository-relative path (`raw/topic/x`), with and without `.md`. */
  readonly rawPaths: ReadonlySet<string>
  /** Whether `index.md` exists, so `[[index]]` resolves. */
  readonly indexPresent: boolean
}

/**
 * Whether one link target names something in the wiki that contains it.
 *
 * A target may name a page (bare slug or `<pagesDir>/slug`), the catalogue
 * (`index`), or a `raw/` source (base name, or `raw/...` path with or without
 * the extension). A target that names none of them is unresolved; the caller
 * reports it with the link exactly as written.
 * @param target - the target as {@link parseWikiLinks} returned it.
 * @param pagesDir - the page directory of the wiki the link lives in.
 * @param targets - what exists in that wiki.
 * @returns whether the link resolves.
 */
function linkResolves(target: string, pagesDir: string, targets: LinkTargets): boolean {
  if (targets.pageSlugs.has(linkTargetSlug(target, pagesDir))) return true
  if (targets.rawPaths.has(target)) return true
  if (targets.rawNames.has(target)) return true
  return target === WIKI_INDEX_SLUG && targets.indexPresent
}

/**
 * Build the resolution sets for one wiki.
 *
 * `raw/` is walked with the same rules the `raw` check uses (hidden entries and
 * symlinks skipped), so the two checks agree on what a source is. `index.md` is
 * `stat`ed rather than read, because the `links` check needs only whether it
 * exists.
 * @param target - the wiki to inspect.
 * @param pages - the pages already collected for this run.
 * @returns the sets {@link linkResolves} uses.
 */
async function collectLinkTargets(
  target: LintTarget,
  pages: readonly PageFile[],
): Promise<LinkTargets> {
  const files: { file: string; relative: string }[] = []
  await walkRaw(rawDirectory(target.wikiRoot), '', files)
  const rawNames = new Set<string>()
  const rawPaths = new Set<string>()
  for (const { relative } of files) {
    rawNames.add(path.basename(relative, WIKI_FILE_EXTENSION))
    const repositoryPath = `${WIKI_RAW_DIRECTORY}/${relative}`
    rawPaths.add(repositoryPath)
    rawPaths.add(repositoryPath.slice(0, -WIKI_FILE_EXTENSION.length))
  }
  let indexPresent = false
  try {
    indexPresent = (await stat(indexPath(target.wikiRoot))).isFile()
  } catch {
    indexPresent = false
  }
  return {
    pageSlugs: new Set(pages.map(page => page.slug)),
    rawNames,
    rawPaths,
    indexPresent,
  }
}

/**
 * List the entries of one directory, or an empty list when it does not exist.
 * @param directory - the directory to read.
 * @returns the base names, in a stable order.
 */
async function entriesOf(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries.map(entry => entry.name).sort((left, right) => left.localeCompare(right, 'en'))
  } catch {
    return []
  }
}

/**
 * List every `raw/` source below the root, recursing into per-topic
 * directories. `lstat` is the point: a symlink is skipped rather than followed,
 * so a link planted in `raw/` cannot make the check read a file outside the
 * wiki (and cannot make the walk loop). Hidden entries are skipped too.
 * @param directory - the directory to walk.
 * @param relative - path relative to `raw/`, with a trailing slash when non-empty.
 * @param files - the collector.
 */
async function walkRaw(
  directory: string,
  relative: string,
  files: { file: string; relative: string }[],
): Promise<void> {
  for (const name of await entriesOf(directory)) {
    if (name.startsWith('.')) continue
    const file = path.join(directory, name)
    let info
    try {
      info = await lstat(file)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      await walkRaw(file, `${relative}${name}/`, files)
      continue
    }
    if (info.isFile() && name.endsWith(WIKI_FILE_EXTENSION)) {
      files.push({ file, relative: `${relative}${name}` })
    }
  }
}

/** Read the pages of one wiki, reporting files that could not be read. */
async function collectPages(target: LintTarget, issues: LintIssue[]): Promise<PageFile[]> {
  const pagesDir = pagesDirOf(target)
  const directory = pagesDirectory(target.wikiRoot, pagesDir)
  const pages: PageFile[] = []
  for (const name of await entriesOf(directory)) {
    if (name.startsWith('.')) continue
    const display = `${target.displayPrefix}${pagesDir}/${name}`
    const slug = slugFromFileName(name)
    if (slug === null) {
      issues.push({
        scope: target.scope,
        kind: 'unreadable',
        path: display,
        detail: 'the file name is not a usable page slug, so it is not part of the wiki',
      })
      continue
    }
    const file = pagePath(target.wikiRoot, slug, pagesDir)
    try {
      pages.push({ slug, file, display, text: await readFile(file, 'utf8') })
    } catch (error) {
      issues.push({
        scope: target.scope,
        kind: 'unreadable',
        path: display,
        detail: `the page could not be read (${describeError(error)})`,
      })
    }
  }
  return pages
}

/** One unqualified `[[...]]` in `index.md`, with the line it sits on. */
interface IndexLink {
  /** The target as written, after the anchor and the display title are removed. */
  readonly target: string
  /** The page slug the target names, when it names a page. */
  readonly slug: string
  /** The 1-based line number. */
  readonly line: number
}

/** The links `index.md` lists, in file order. */
interface IndexEntries {
  /** Every unqualified link outside code. */
  readonly links: readonly IndexLink[]
  /** Whether `index.md` exists at all. */
  readonly present: boolean
}

/** Record one line number against a slug. */
function addLine(lines: Map<string, number[]>, slug: string, line: number): void {
  const existing = lines.get(slug)
  if (existing === undefined) lines.set(slug, [line])
  else existing.push(line)
}

/**
 * Parse the `[[...]]` links out of `index.md`.
 *
 * The line's text after the link is not checked: the design leaves the wording
 * of the summary to the skill, and a lint that argued about prose would be
 * noise. A target written as a path (`[[concepts/esp32-s31|esp32-s31]]`) names
 * the same page as `[[esp32-s31]]` ({@link linkTargetSlug}). Code is masked over
 * the whole file **before** it is split into lines, so a fenced block in the
 * catalogue cannot contribute an entry either.
 * @param target - the wiki to read.
 * @returns the links with their lines, and whether the file exists.
 */
async function collectIndex(target: LintTarget): Promise<IndexEntries> {
  const links: IndexLink[] = []
  const pagesDir = pagesDirOf(target)
  let text: string
  try {
    text = await readFile(indexPath(target.wikiRoot), 'utf8')
  } catch {
    return { links, present: false }
  }
  for (const [offset, line] of maskCodeSpans(text).split(/\r?\n/gu).entries()) {
    for (const link of parseWikiLinks(line)) {
      if (link.scope !== null) continue
      links.push({
        target: link.target,
        slug: linkTargetSlug(link.target, pagesDir),
        line: offset + 1,
      })
    }
  }
  return { links, present: true }
}

/** Run the `links` check (DESIGN §6.6). */
function checkLinks(
  target: LintTarget,
  pages: readonly PageFile[],
  targets: LinkTargets,
  options: LintOptions,
  issues: LintIssue[],
): void {
  const globalSlugs = options.globalSlugs ?? new Set<string>()
  const pagesDir = pagesDirOf(target)
  const globalPagesDir = options.globalPagesDir ?? WIKI_PAGES_DIRECTORY
  for (const page of pages) {
    for (const link of parseWikiLinks(page.text)) {
      if (link.scope === 'global') {
        if (globalSlugs.has(linkTargetSlug(link.target, globalPagesDir))) continue
        const why =
          options.globalEnabled === true
            ? 'the global wiki has no page with that slug'
            : 'no global wiki is configured, so a global: link cannot resolve yet'
        issues.push({
          scope: target.scope,
          kind: 'unresolved-global-link',
          path: page.display,
          detail: `${link.raw} is unresolved: ${why}`,
        })
        continue
      }
      if (linkResolves(link.target, pagesDir, targets)) continue
      issues.push({
        scope: target.scope,
        kind: 'unresolved-link',
        path: page.display,
        detail: `${link.raw} is unresolved: no page, index, or raw/ source in this wiki matches \`${link.target}\``,
      })
    }
  }
}

/** Run the `index` check (DESIGN §6.6). */
function checkIndex(
  target: LintTarget,
  pages: readonly PageFile[],
  index: IndexEntries,
  targets: LinkTargets,
  issues: LintIssue[],
): void {
  const display = `${target.displayPrefix}${path.basename(indexPath(target.wikiRoot))}`
  const pagesDir = pagesDirOf(target)
  const slugs = new Set(pages.map(page => page.slug))
  /** Catalogue entries that name a page. */
  const listed = new Map<string, number[]>()
  /** Entries whose target is not a page and not anything else in this wiki. */
  const stale = new Map<string, number[]>()
  /** Every entry that should be judged as a catalogue entry, for duplicates. */
  const seen = new Map<string, number[]>()
  for (const entry of index.links) {
    if (slugs.has(entry.slug)) {
      addLine(listed, entry.slug, entry.line)
      addLine(seen, entry.slug, entry.line)
      continue
    }
    // The catalogue may also link a raw/ source or the index itself; those are
    // real targets now, so they are not stale page entries.
    if (linkResolves(entry.target, pagesDir, targets)) continue
    addLine(stale, entry.slug, entry.line)
    addLine(seen, entry.slug, entry.line)
  }
  for (const [slug, lines] of seen) {
    if (lines.length > 1) {
      issues.push({
        scope: target.scope,
        kind: 'index-duplicate',
        path: display,
        detail: `[[${slug}]] is listed ${String(lines.length)} times (lines ${lines.join(', ')}); keep one entry per page`,
      })
    }
  }
  for (const [slug, lines] of stale) {
    issues.push({
      scope: target.scope,
      kind: 'index-stale',
      path: display,
      detail: `line ${String(lines[0])} lists [[${slug}]], but ${pagesDir}/${slug}${WIKI_FILE_EXTENSION} does not exist`,
    })
  }
  for (const page of pages) {
    if (!listed.has(page.slug)) {
      issues.push({
        scope: target.scope,
        kind: 'index-missing',
        path: page.display,
        detail: `the page is not listed in index.md; add \`- [[${page.slug}]] — <one-line summary>\``,
      })
    }
  }
  if (!index.present && pages.length > 0) {
    issues.push({
      scope: target.scope,
      kind: 'index-missing',
      path: display,
      detail: `index.md does not exist while ${String(pages.length)} page(s) do`,
    })
  }
}

/**
 * Count the pages of one wiki without reading them (DESIGN §6.6's notice).
 * @param wikiRoot - the wiki root.
 * @param pagesDir - the page directory name; `pages` by default.
 * @returns the number of usable page files.
 */
export async function countPages(
  wikiRoot: string,
  pagesDir: string = WIKI_PAGES_DIRECTORY,
): Promise<number> {
  const names = await entriesOf(pagesDirectory(wikiRoot, pagesDir))
  return names.filter(name => !name.startsWith('.') && slugFromFileName(name) !== null).length
}

/** Run the `raw` check (DESIGN §6.6). */
async function checkRaw(target: LintTarget, issues: LintIssue[]): Promise<void> {
  const directory = rawDirectory(target.wikiRoot)
  const files: { file: string; relative: string }[] = []
  await walkRaw(directory, '', files)
  for (const { file } of files) {
    const display = `${target.displayPrefix}${path
      .relative(target.wikiRoot, file)
      .split(path.sep)
      .join('/')}`
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      issues.push({
        scope: target.scope,
        kind: 'unreadable',
        path: display,
        detail: `the source could not be read (${describeError(error)})`,
      })
      continue
    }
    const document = splitFrontmatter(text)
    const recorded = frontmatterValue(document.frontmatter, 'sha256')
    if (recorded === null) {
      issues.push({
        scope: target.scope,
        kind: 'raw-digest-missing',
        path: display,
        detail:
          'the frontmatter records no `sha256`, so the source cannot be verified; a raw/ file is immutable, so do not edit it in place — restore the body and add the digest',
      })
      continue
    }
    if (!isDigestLike(recorded)) {
      issues.push({
        scope: target.scope,
        kind: 'raw-digest-missing',
        path: display,
        detail: `\`sha256: ${recorded}\` is not a sha256 digest (64 hex characters)`,
      })
      continue
    }
    if (!digestMatches(recorded, document.body)) {
      issues.push({
        scope: target.scope,
        kind: 'raw-digest-mismatch',
        path: display,
        detail:
          'the recorded sha256 does not match the body, so the source looks hand-edited. raw/ is immutable: restore the body, or add a new dated source and leave this one alone',
      })
    }
  }
}

/**
 * Lint one wiki (DESIGN §6.6).
 *
 * The issue list is cut at {@link MAX_LINT_ISSUES}; the summary always says how
 * many were found, so a cut list is never mistaken for a clean one.
 * @param target - the wiki to check.
 * @param options - which checks to run and what the global wiki resolves.
 * @returns the issues and the summary line.
 */
export async function lintWiki(target: LintTarget, options: LintOptions): Promise<LintResult> {
  const issues: LintIssue[] = []
  const checks = new Set(options.checks)
  let pages: PageFile[] | undefined
  let targets: LinkTargets | undefined
  const readPages = async (): Promise<PageFile[]> => {
    pages ??= await collectPages(target, issues)
    return pages
  }
  const readTargets = async (collected: readonly PageFile[]): Promise<LinkTargets> => {
    targets ??= await collectLinkTargets(target, collected)
    return targets
  }
  if (checks.has('links')) {
    const collected = await readPages()
    checkLinks(target, collected, await readTargets(collected), options, issues)
  }
  if (checks.has('index')) {
    const collected = await readPages()
    checkIndex(target, collected, await collectIndex(target), await readTargets(collected), issues)
  }
  if (checks.has('raw')) {
    await checkRaw(target, issues)
  }
  const total = issues.length
  const cut = issues.slice(0, MAX_LINT_ISSUES)
  const ran = LINT_CHECKS.filter(check => checks.has(check)).join(', ')
  const label = target.summaryLabel ?? target.displayPrefix
  const scanned = `${label}: ${String((pages ?? []).length)} page(s), checks: ${ran === '' ? 'none' : ran}`
  return {
    issues: cut,
    summary:
      total === 0
        ? `${scanned} — no issues`
        : `${scanned} — ${String(total)} issue(s)${total > cut.length ? `, showing the first ${String(cut.length)}` : ''}`,
  }
}
