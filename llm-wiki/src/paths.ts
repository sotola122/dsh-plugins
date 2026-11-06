/**
 * The project wiki's directory convention (DESIGN §6.2).
 *
 * ```text
 * <checkoutRoot>/.dsh/
 * ├── wiki.yml                    # tracked configuration (§6.3)
 * └── wiki/
 *     ├── WIKI.md                 # purpose, scope, glossary, review status (a person maintains it)
 *     ├── index.md                # the catalogue: `- [[slug]] — one-line summary`
 *     ├── raw/<topic>/<YYYY-MM-DD>-<source>.md   # immutable sources
 *     └── pages/<slug>.md         # frontmatter: title, aliases, tags, created, updated, sources
 * ```
 *
 * The project wiki always uses `pages/`. The **global** wiki may name another
 * single-level directory (`config.global.pagesDir`), because an existing
 * knowledge repository may keep its pages under `concepts/`; `raw/`, `index.md`,
 * and the charter keep their names either way. The global charter is the
 * repository's `AGENTS.md` when it has one, and its `WIKI.md` otherwise
 * ({@link WIKI_CHARTER_CANDIDATES}); the plugin creates only the latter, and only
 * when neither exists.
 *
 * The paths here are pure: they join strings and never touch the filesystem, so
 * a unit test can reason about the convention without a repository. Whether the
 * directory may be written is a separate question answered by `./inspect`.
 * @module @anago-harness/llm-wiki/paths
 */

import path from 'node:path'

/** Directory under the checkout root that holds the wiki (DESIGN §6.2). */
export const WIKI_DIRECTORY = path.join('.dsh', 'wiki')

/** The wiki's own configuration file, next to the directory (DESIGN §6.3). */
export const WIKI_SETTINGS_FILE = path.join('.dsh', 'wiki.yml')

/** Name of the human-maintained charter (DESIGN §6.2). */
export const WIKI_CHARTER_FILE = 'WIKI.md'

/**
 * The repository's own agent-instructions file.
 *
 * A wiki repository may already carry one (the user's `~/.dsh/llm-wiki` does),
 * and then it is the charter: the plugin must not create a second one next to
 * it. The project wiki is not affected — it always uses {@link WIKI_CHARTER_FILE}
 * inside `.dsh/wiki`.
 */
export const WIKI_AGENTS_FILE = 'AGENTS.md'

/**
 * The files a **global** wiki recognizes as its charter, in priority order
 * (DESIGN §6.4).
 *
 * `AGENTS.md` wins when both exist, because it is the file an agent is already
 * expected to read; `WIKI.md` is the fallback the skeleton creates when neither
 * exists. Nothing else is inferred: a repository may have `SCHEMA.md` and other
 * instructions files, but the plugin neither writes nor owns them.
 */
export const WIKI_CHARTER_CANDIDATES = [WIKI_AGENTS_FILE, WIKI_CHARTER_FILE] as const

/** One file a global wiki may use as its charter. */
export type WikiCharterFile = (typeof WIKI_CHARTER_CANDIDATES)[number]

/** Name of the catalogue (DESIGN §6.2). */
export const WIKI_INDEX_FILE = 'index.md'

/** The link target that names the catalogue: `[[index]]` (DESIGN §6.2, §6.6). */
export const WIKI_INDEX_SLUG = 'index'

/** Directory of immutable sources (DESIGN §6.2). */
export const WIKI_RAW_DIRECTORY = 'raw'

/** Directory of wiki pages (DESIGN §6.2). */
export const WIKI_PAGES_DIRECTORY = 'pages'

/**
 * What a configured page directory may look like (DESIGN §6.2, §6.4).
 *
 * It is one directory name **relative to the repository top**: no separator, no
 * NUL byte, and no leading dot. The leading dot also refuses `.` and `..`, and
 * a separator refuses an absolute path, so a Profile value can never name a
 * place outside the repository. The three names the convention already fixes
 * next to it — `raw`, `index.md`, `WIKI.md` — are refused too (case-insensitively,
 * because the repository may sit on a case-insensitive filesystem), since a
 * collision would break `raw/`'s immutability or the catalogue. The global wiki
 * is the only wiki whose page directory is configurable; the project wiki keeps
 * `pages/`.
 */
export const PAGES_DIRECTORY_PATTERN = /^(?!\.)(?!(?:raw|index\.md|wiki\.md)$)[^/\\\u0000]+$/iu

/**
 * Whether a string is usable as the page directory of a wiki.
 * @param name - the candidate directory name.
 * @returns true when it is a single, relative, non-hidden directory name that
 * does not collide with `raw/`, `index.md`, or `WIKI.md`.
 */
export function isPagesDirectoryName(name: string): boolean {
  return PAGES_DIRECTORY_PATTERN.test(name)
}

/**
 * Assert that a configured page directory is usable.
 *
 * The schema already refuses an invalid `global.pagesDir`, but the value also
 * reaches a `path.join`, so it is checked again where it is used: a configuration
 * that somehow bypassed the schema must fail loudly instead of joining a path
 * that leaves the repository or collides with `raw/`.
 * @param name - the candidate directory name.
 * @returns the same name, when it is valid.
 * @throws when the name is not a single, relative, non-hidden directory name, or
 * when it is `raw`, `index.md`, or `WIKI.md`.
 */
export function assertPagesDirectory(name: string): string {
  if (!isPagesDirectoryName(name)) {
    throw new Error(
      `\`${name}\` is not a usable page directory: give one directory name relative to the repository top, with no \`/\`, no \`..\`, no leading \`.\`, no absolute path, and no collision with \`${WIKI_RAW_DIRECTORY}\`, \`${WIKI_INDEX_FILE}\`, or \`${WIKI_CHARTER_FILE}\``,
    )
  }
  return name
}

/** File extension every page and source uses. */
export const WIKI_FILE_EXTENSION = '.md'

/** The `predicate` part of a wiki link: `[[slug]]`, `[[global:slug]]`, optionally `|alias`. */
const WIKI_LINK = /\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/gu

/** What a wiki link points at (DESIGN §6.6, sixth revision). */
export interface WikiLink {
  /** The part before the colon: `global` for a `[[global:slug]]`, `null` for an unqualified link. */
  readonly scope: 'global' | null
  /** The target slug, without the scope prefix, anchor, or title. */
  readonly target: string
  /** The link exactly as it appeared, for the issue detail. */
  readonly raw: string
}

/**
 * Whether a string is usable as a page slug.
 *
 * A slug is the file name under `pages/` without `.md`, so it must not contain
 * a path separator, and it must not contain the characters that would break the
 * `[[slug]]` syntax itself. The design leaves the exact grammar to the skill;
 * this check only rejects what cannot work.
 * @param slug - candidate slug.
 * @returns true when the slug can name a page file and be linked.
 */
export function isPageSlug(slug: string): boolean {
  if (slug === '' || slug === '.' || slug === '..') return false
  if (slug.includes('/') || slug.includes('\\')) return false
  if (slug.includes('[') || slug.includes(']') || slug.includes('|')) return false
  if (slug.includes(':')) return false
  if (slug.startsWith('.') || slug.endsWith('.')) return false
  return true
}

/**
 * `<wikiRoot>/<pagesDir>` (DESIGN §6.2).
 *
 * The page directory is `pages` for a project wiki and may be another
 * single-level name for the global wiki (`global.pagesDir`). The name is checked
 * here as well as in the schema, so a `path.join` can never step outside the
 * wiki root.
 * @param wikiRoot - the wiki root (the checkout's `.dsh/wiki` or the global repository top).
 * @param pagesDir - the page directory name; `pages` by default.
 * @returns the absolute page directory.
 * @throws when `pagesDir` is not a single, relative, non-hidden directory name.
 */
export function pagesDirectory(wikiRoot: string, pagesDir: string = WIKI_PAGES_DIRECTORY): string {
  return path.join(wikiRoot, assertPagesDirectory(pagesDir))
}

/**
 * `<wikiRoot>/raw` (DESIGN §6.2).
 * @param wikiRoot - the wiki root.
 * @returns the absolute `raw/` directory.
 */
export function rawDirectory(wikiRoot: string): string {
  return path.join(wikiRoot, WIKI_RAW_DIRECTORY)
}

/**
 * `<wikiRoot>/index.md` (DESIGN §6.2).
 * @param wikiRoot - the wiki root.
 * @returns the absolute catalogue file path.
 */
export function indexPath(wikiRoot: string): string {
  return path.join(wikiRoot, WIKI_INDEX_FILE)
}

/**
 * `<wikiRoot>/WIKI.md` (DESIGN §6.2).
 * @param wikiRoot - the wiki root.
 * @returns the absolute charter file path.
 */
export function charterPath(wikiRoot: string): string {
  return path.join(wikiRoot, WIKI_CHARTER_FILE)
}

/**
 * `<wikiRoot>/<pagesDir>/<slug>.md` (DESIGN §6.2).
 * @param wikiRoot - the wiki root.
 * @param slug - the page slug.
 * @param pagesDir - the page directory name; `pages` by default.
 * @returns the page file path.
 */
export function pagePath(
  wikiRoot: string,
  slug: string,
  pagesDir: string = WIKI_PAGES_DIRECTORY,
): string {
  return path.join(pagesDirectory(wikiRoot, pagesDir), `${slug}${WIKI_FILE_EXTENSION}`)
}

/**
 * The slug a wiki link names, accepting the repository-path form.
 *
 * `parseWikiLinks` returns the target exactly as written, and an
 * Obsidian-style vault may link a page by its path inside the wiki
 * (`[[concepts/esp32-s31|esp32-s31]]`, or `[[pages/alpha]]` in a project wiki).
 * A page slug can never contain `/` ({@link isPageSlug}), so a target that
 * starts with the wiki's page directory and a slash can only name that page: it
 * is reduced to its slug, so the link resolves against the real page instead of
 * being reported as unresolved.
 *
 * The form is accepted for **both** wikis — the project wiki's `pages/` and the
 * global wiki's configured directory. There is no ambiguity, because a slug
 * cannot contain `/`.
 * @param target - the link target as {@link parseWikiLinks} returned it.
 * @param pagesDir - the page directory of the wiki the link lives in.
 * @returns the slug to resolve.
 */
export function linkTargetSlug(target: string, pagesDir: string = WIKI_PAGES_DIRECTORY): string {
  const prefix = `${pagesDir}/`
  return target.startsWith(prefix) ? target.slice(prefix.length) : target
}

/**
 * The slug a page file name carries, or `null` when the name is not a page.
 * @param fileName - a base name from `pages/`.
 * @returns the slug, or `null` for a non-Markdown or hidden entry.
 */
export function slugFromFileName(fileName: string): string | null {
  if (!fileName.endsWith(WIKI_FILE_EXTENSION)) return null
  const slug = fileName.slice(0, -WIKI_FILE_EXTENSION.length)
  return isPageSlug(slug) ? slug : null
}

/**
 * A line that opens a fenced code block.
 *
 * As in `knowledge-common`'s scanner, the fence may be indented and uses either
 * three or more backticks or three or more tildes; the info string after it is
 * not inspected. The closing fence must use the same character and be at least
 * as long, which is how CommonMark pairs the two ({@link FENCE_CLOSE}).
 */
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/u

/** A line that closes a fence: the delimiter alone, optionally indented (CRLF included). */
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*\r?$/u

/** Replace one line's content with spaces, keeping its line ending. */
function blankLine(line: string): string {
  return line.replace(/[^\r]/gu, ' ')
}

/** Whether the line that starts at `from` is empty, so an inline span stops there. */
function blankLineAt(text: string, from: number): boolean {
  let index = from
  while (index < text.length) {
    const character = text[index]
    if (character === ' ' || character === '\t' || character === '\r') {
      index += 1
      continue
    }
    return character === '\n'
  }
  return true
}

/**
 * Blank out fenced code blocks, preserving every line break.
 *
 * A fence is tracked line by line, so an unclosed one hides the rest of the
 * document with it — the same answer a Markdown renderer gives.
 * @param text - Markdown text.
 * @returns the text where every fenced line is spaces, at the same offsets.
 */
function maskFencedCode(text: string): string {
  const lines = text.split('\n')
  let fence: { readonly character: string; readonly length: number } | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (fence !== null) {
      const closing = FENCE_CLOSE.exec(line)
      const delimiter = closing?.[1] ?? ''
      if (delimiter !== '' && delimiter[0] === fence.character && delimiter.length >= fence.length) {
        fence = null
      }
      lines[index] = blankLine(line)
      continue
    }
    const opening = FENCE_OPEN.exec(line)
    if (opening === null) continue
    const delimiter = opening[1] as string
    fence = { character: delimiter[0] as string, length: delimiter.length }
    lines[index] = blankLine(line)
  }
  return lines.join('\n')
}

/**
 * Blank out inline code spans, preserving every line break.
 *
 * A span opens with a run of backticks and closes with a run of **exactly** the
 * same length, so `` `[[a]]` `` and ```` ``[[b]]`` ```` are both code. A span may
 * cross one line break, as CommonMark allows, but not a blank line: an unpaired
 * backtick in prose would otherwise swallow the rest of the paragraph and hide
 * real links. An unmatched run is left alone and is not a link either way.
 * @param text - Markdown text with fenced blocks already blanked.
 * @returns the text where every inline code span is spaces, at the same offsets.
 */
function maskInlineCode(text: string): string {
  const characters = text.split('')
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      const character = characters[index] as string
      if (character !== '\n' && character !== '\r') characters[index] = ' '
    }
  }
  let index = 0
  while (index < text.length) {
    if (text[index] !== '`') {
      index += 1
      continue
    }
    let runEnd = index
    while (text[runEnd] === '`') runEnd += 1
    const length = runEnd - index
    let closing = -1
    let closingEnd = runEnd
    let search = runEnd
    while (search < text.length) {
      if (text[search] === '`') {
        let candidateEnd = search
        while (text[candidateEnd] === '`') candidateEnd += 1
        if (candidateEnd - search === length) {
          closing = search
          closingEnd = candidateEnd
          break
        }
        search = candidateEnd
        continue
      }
      if (text[search] === '\n' && blankLineAt(text, search + 1)) break
      search += 1
    }
    if (closing === -1) {
      index = runEnd
      continue
    }
    blank(index, closingEnd)
    index = closingEnd
  }
  return characters.join('')
}

/**
 * Blank out code, so a `[[...]]` inside it is not read as a wiki link.
 *
 * A C++ page legitimately contains `[[nodiscard]]` in a heading, in prose, and
 * in a code block; under an Obsidian-style convention that is the same syntax
 * as a link, and only the code context tells them apart. The replacement keeps
 * every line break and the text length, so a caller that needs line numbers can
 * split the result exactly as it would split the source.
 * @param text - a page or a source.
 * @returns the same text with every fenced block and inline span replaced by spaces.
 */
export function maskCodeSpans(text: string): string {
  return maskInlineCode(maskFencedCode(text))
}

/**
 * Parse the wiki links of one document (DESIGN §6.6).
 *
 * The design's link grammar is small: `[[slug]]` resolves inside the wiki that
 * contains the link, and `[[global:slug]]` resolves in the global wiki. An
 * anchor (`#section`) and a display title (`|title`) are ignored, because they
 * do not change what has to exist. Code is not a link: a `[[...]]` inside an
 * inline code span or a fenced block is skipped before matching
 * ({@link maskCodeSpans}), so a C++ attribute such as `[[nodiscard]]` stays
 * code. The target is returned as written; a caller that resolves it should
 * pass it through {@link linkTargetSlug} so an Obsidian-style path link
 * (`[[concepts/esp32-s31|x]]`) names the same page.
 * @param text - the document body.
 * @returns every link outside code, in order of appearance.
 */
export function parseWikiLinks(text: string): WikiLink[] {
  const links: WikiLink[] = []
  for (const match of maskCodeSpans(text).matchAll(WIKI_LINK)) {
    const raw = match[0]
    const body = (match[1] as string).trim()
    if (body === '') continue
    const hash = body.indexOf('#')
    const withoutAnchor = hash === -1 ? body : body.slice(0, hash)
    const colon = withoutAnchor.indexOf(':')
    if (colon === -1) {
      const target = withoutAnchor.trim()
      if (target === '') continue
      links.push({ scope: null, target, raw })
      continue
    }
    const prefix = withoutAnchor.slice(0, colon).trim().toLowerCase()
    const target = withoutAnchor.slice(colon + 1).trim()
    if (target === '') continue
    // Any other prefix is a link to another wiki this plugin does not own, so
    // it is treated as an unqualified slug rather than silently accepted.
    links.push(prefix === 'global' ? { scope: 'global', target, raw } : { scope: null, target: withoutAnchor.trim(), raw })
  }
  return links
}

/** Leading YAML frontmatter block at the very top of a file. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u

/** A document split into its frontmatter and its body. */
export interface WikiDocument {
  /** The frontmatter text between the `---` fences, or `null` when there is none. */
  readonly frontmatter: string | null
  /** Everything after the closing fence; the whole text when there is no frontmatter. */
  readonly body: string
}

/**
 * Split a page or source into frontmatter and body.
 *
 * The split is byte-exact for the body, which is what makes it usable as the
 * digest input: `wiki_lint`'s `raw` check hashes exactly what the writer
 * hashed, so recording the digest cannot change the digest.
 * @param text - the file content.
 * @returns the frontmatter text (without the fences) and the body.
 */
export function splitFrontmatter(text: string): WikiDocument {
  const match = FRONTMATTER.exec(text)
  if (match === null) return { frontmatter: null, body: text }
  return { frontmatter: match[1] as string, body: text.slice(match[0].length) }
}

/**
 * Read one scalar key from a frontmatter block without a YAML parser.
 *
 * Only the flat `key: value` shape the convention defines is understood, which
 * is deliberate: the frontmatter is small and the wiki must not fail to lint
 * because a value is unusual.
 * @param frontmatter - the block between the fences, or `null`.
 * @param key - the key to look up.
 * @returns the unquoted value, or `null` when the key is absent or empty.
 */
export function frontmatterValue(frontmatter: string | null, key: string): string | null {
  if (frontmatter === null) return null
  const pattern = new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.*)$`, 'mu')
  const match = pattern.exec(frontmatter)
  if (match === null) return null
  const value = (match[1] as string).trim()
  if (value === '') return null
  return value.replace(/^["'](.*)["']$/u, '$1').trim()
}
