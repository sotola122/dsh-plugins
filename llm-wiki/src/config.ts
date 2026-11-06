/**
 * Plugin configuration (DESIGN §6.6, current revision).
 *
 * The schema carries only the keys the design defines. The sixth revision
 * removed `guardRaw` (raw protection is not switchable) and there was never a
 * `language` or `order` key in this package, so the object below is exactly
 * §6.6's:
 *
 * - `notice` — the once-per-session existence notice, with both page counts;
 * - `global.repo` — the Profile's global wiki path. The **sidecar**
 *   `$DSH_HOME/llm-wiki-state/repo.json` takes precedence, so `/wiki repo set`
 *   and `/wiki repo unset` win over this value (DESIGN §6.4, §12.3). The
 *   pre-migration `$DSH_HOME/llm-wiki/repo.json` is read once when the current
 *   file is absent, unless it is inside a git work tree (see `global.ts`);
 * - `global.pagesDir` — the global wiki's page directory, `pages` by default.
 *   An existing knowledge repository may keep its pages under `concepts/`, so
 *   the index, the lint, `wiki_write`, and `/wiki` read this name instead of
 *   assuming `pages/`. It is one directory name relative to the repository top
 *   and cannot leave it; the project wiki is not configurable;
 * - `writeApproval` — `wiki_write`'s own switch, separate from the memory
 *   plugin's (D2). `ask` asks only when the session's effective policy is
 *   `ask`; under `never` it refuses the write with `WIKI_APPROVAL_UNAVAILABLE`
 *   instead of writing unapproved, and nothing is ever staged;
 * - `write` — the per-file caps `wiki_write` applies: one page (and `index.md`
 *   and `WIKI.md`) at `maxPageBytes`, one `raw/` source at `maxRawBytes`.
 *   There is no page-count and no total-bytes cap (sixth revision);
 * - `search` — the in-process index's three bounds (DESIGN §6.5): the pages one
 *   root indexes, the bytes of one page it reads, and the posting bytes of one
 *   root. Over either of the first two, the index keeps the newest pages and
 *   reports `truncated`; T10 is what fixed the defaults;
 * - `lint.checks` — the checks `wiki_lint` and `/wiki lint` run when the caller
 *   names none. The design's default is all three (`links`, `index`, `raw`);
 *   a deployment whose `raw/` sources predate the digest records can leave
 *   `raw` out. An explicit argument still wins over this value.
 *
 * There is deliberately no `guardRaw`: raw protection is unconditional.
 * @module @anago-harness/llm-wiki/config
 */

import z from '@deepseek-ai/schemastery'
import { LINT_CHECKS, type LintCheck } from './lint.ts'
import { PAGES_DIRECTORY_PATTERN, WIKI_PAGES_DIRECTORY } from './paths.ts'

/** Default cap on one wiki page, in bytes (DESIGN §6.4). */
export const DEFAULT_MAX_PAGE_BYTES = 65_536

/** Default cap on one `raw/` source, in bytes (DESIGN §6.4). */
export const DEFAULT_MAX_RAW_BYTES = 262_144

/** Default cap on pages in one search index (DESIGN §6.5; T10 confirms it). */
export const DEFAULT_SEARCH_MAX_PAGES = 5000

/** Default cap on the bytes of one file the search index parses (DESIGN §6.5). */
export const DEFAULT_SEARCH_MAX_PAGE_BYTES = 65_536

/** Default cap on the posting bytes of one search index (DESIGN §6.5). */
export const DEFAULT_SEARCH_MAX_POSTING_BYTES = 67_108_864

/** The global wiki setting (DESIGN §6.4, U5). */
export interface GlobalWikiConfig {
  /**
   * Path to the repository that holds the global wiki, or `''` for "none".
   * `~` and `~/` are expanded; a relative path is refused. The **sidecar**
   * under `$DSH_HOME` is consulted first, so a `/wiki repo set` and
   * `/wiki repo unset` win over this value.
   */
  readonly repo: string
  /**
   * Directory under the repository top that holds the pages, `pages` by
   * default.
   *
   * The global wiki is not always laid out with `pages/`: an existing knowledge
   * repository may keep its pages under `concepts/`. Only the **page** directory
   * moves — `raw/`, `index.md`, and `WIKI.md` stay where the convention puts
   * them — and only the global wiki is configurable; the project wiki keeps
   * `pages/`.
   *
   * The value is one directory name relative to the repository top. The schema
   * refuses `/`, `\`, a NUL byte, an empty value, `.`/`..`, a leading `.`, and
   * the three names the convention fixes (`raw`, `index.md`, `WIKI.md`), so it
   * cannot name a path outside the repository and cannot collide with `raw/`
   * (the repository is the trust boundary, not the Profile).
   */
  readonly pagesDir: string
}

/** Per-file write caps `wiki_write` applies (DESIGN §6.4). */
export interface WikiWriteConfig {
  /** Maximum bytes of one page file (and of `index.md` and `WIKI.md`). */
  readonly maxPageBytes: number
  /** Maximum bytes of one `raw/<topic>/<date>-<source>.md`. */
  readonly maxRawBytes: number
}

/** The lint's default check set. */
export interface WikiLintConfig {
  /**
   * Which checks `wiki_lint` and `/wiki lint` run when the caller omits them.
   *
   * The design's default is all three. The schema refuses an empty list (a
   * lint that checks nothing is never what a deployment means), removes
   * duplicates, and puts the checks in the order the tool runs them
   * ({@link LINT_CHECKS}). An unknown name fails the load rather than being
   * dropped, so a typo cannot silently widen the set back to all three.
   */
  readonly checks: readonly LintCheck[]
}

/** Search index bounds (DESIGN §6.5). */
export interface WikiSearchConfig {
  /** Maximum pages indexed per wiki root. */
  readonly maxPages: number
  /** Maximum bytes of one page the index reads. */
  readonly maxPageBytes: number
  /** Maximum posting bytes per wiki root. */
  readonly maxPostingBytes: number
}

/** Resolved plugin configuration (DESIGN §6.6). */
export interface WikiConfig {
  /** Whether the existence notice is injected at all. */
  readonly notice: boolean
  /** The global wiki setting, which the sidecar may override. */
  readonly global: GlobalWikiConfig
  /** `wiki_write` approval mode (DESIGN §6.4, D2). */
  readonly writeApproval: 'none' | 'ask'
  /** Per-file write caps, read by `wiki_write`. */
  readonly write: WikiWriteConfig
  /** Search index bounds, read by `wiki_search`. */
  readonly search: WikiSearchConfig
  /** The checks `wiki_lint` and `/wiki lint` run when the caller names none. */
  readonly lint: WikiLintConfig
}

/**
 * The plugin config schema. Every default is the design's default, so an empty
 * `config:` block is a fully working deployment.
 */
export const Config = z.object({
  notice: z.boolean().default(true),
  global: z.object({
    repo: z.string().default(''),
    pagesDir: z
      .string()
      .default(WIKI_PAGES_DIRECTORY)
      .pattern(PAGES_DIRECTORY_PATTERN)
      .description(
        'Directory under the global wiki repository top that holds the pages (one relative name; no `/`, no `..`, no leading `.`, not absolute, and not `raw`, `index.md`, or `WIKI.md`). `pages` by default; use `concepts` for a knowledge repository that keeps its pages there.',
      ),
  }),
  writeApproval: z.union(['none', 'ask']).default('none'),
  write: z.object({
    maxPageBytes: z.number().default(DEFAULT_MAX_PAGE_BYTES),
    maxRawBytes: z.number().default(DEFAULT_MAX_RAW_BYTES),
  }),
  search: z.object({
    maxPages: z.number().default(DEFAULT_SEARCH_MAX_PAGES),
    maxPageBytes: z.number().default(DEFAULT_SEARCH_MAX_PAGE_BYTES),
    maxPostingBytes: z.number().default(DEFAULT_SEARCH_MAX_POSTING_BYTES),
  }),
  lint: z.object({
    // The default belongs to the transform, not to the inner array: with the
    // array's own default the missing key would be filled *after* the
    // transform had already skipped it, and `lint: {}` would lose `checks`.
    checks: z
      .transform(
        z.array(z.union(['links', 'index', 'raw'])).min(1),
        checks => LINT_CHECKS.filter(check => checks.includes(check)),
      )
      .default([...LINT_CHECKS])
      .description(
        'Which checks wiki_lint and /wiki lint run when the caller names none: one or more of `links`, `index`, `raw`. All three by default; leave `raw` out for a wiki whose raw/ sources predate the digest records.',
      ),
  }),
})
