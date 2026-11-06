/**
 * The project wiki's root, its `.dsh/wiki.yml`, and whether it may be written
 * (DESIGN §6.2, §6.3).
 *
 * Two rules shape this module:
 *
 * 1. **The root comes from git, in the current directory.** `git rev-parse
 *    --show-toplevel` is run in `header.cwd` and the worktree it names is the
 *    checkout root; linked worktrees are deliberately **not** unified, because
 *    a committed wiki is per branch (DESIGN §6.2). No git root means no wiki.
 * 2. **Read-only is a containment question, not a sandbox question.** The
 *    wiki is writable only while `<checkoutRoot>/.dsh/wiki` is inside
 *    `header.cwd`. Starting `dsh` in `packages/x` therefore sees the wiki —
 *    reading is never stopped — and may not write it, whatever the sandbox
 *    mode allows (DESIGN §6.2, S18).
 *
 * `.dsh/wiki.yml` is the one file a clone can plant, so its trust boundary is
 * narrow: only `commit` is accepted, every other key warns and is ignored, and
 * anything unparseable means `commit: false` (DESIGN §6.3).
 * @module @anago-harness/llm-wiki/inspect
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  canonicalizeTargetPath,
  checkIgnored,
  createNodeGitRunner,
  gitHelperOptions,
  type GitRoots,
  type GitRunner,
  isPathWithin,
  resolveGitRoots,
} from '@anago-harness/knowledge-common'
import { WIKI_DIRECTORY, WIKI_SETTINGS_FILE } from './paths.ts'
import { describeError } from './errors.ts'

/** How `.dsh/wiki.yml` was understood (DESIGN §6.3). */
export interface WikiSettings {
  /** Whether the wiki is meant to be tracked by git. Default `false`. */
  readonly commit: boolean
  /** Unknown keys, an unreadable file, or a `commit` value that is not a boolean. */
  readonly warnings: readonly string[]
}

/**
 * Repository-relative path the ignore check asks about (DESIGN §6.3).
 *
 * It is a **file inside** the wiki, not the directory: a `.gitignore` that says
 * `!.dsh/wiki/` answers "ignored" for the directory itself (git matches a
 * directory-only pattern against the directory), while the file is what decides
 * whether the wiki is actually committed. `dsh-memory` asks about
 * `.dsh/memory/MEMORY.md` for the same reason.
 */
export const WIKI_IGNORE_PROBE = `${WIKI_DIRECTORY}/index.md`

/** What the ignore check could prove about the wiki directory (DESIGN §6.3). */
export type IgnoreState =
  /** Git reports it ignored (exit 0). */
  | 'ignored'
  /** Git reports it not ignored (exit 1). */
  | 'visible'
  /** Git could not answer (exit 128 and above, or a spawn failure). */
  | 'unknown'

/** The result of asking git whether the wiki directory is ignored. */
export interface IgnoreFinding {
  /** The three-way answer. */
  readonly state: IgnoreState
  /** Why the answer is `unknown`, when it is. */
  readonly detail: string | null
}

/**
 * Parse `<checkoutRoot>/.dsh/wiki.yml` (DESIGN §6.3).
 *
 * The parser is deliberately smaller than YAML: only `version` and `commit`
 * are understood, any other key warns and is ignored, and a file that cannot be
 * read or whose `commit` is not a boolean falls back to `commit: false`. That
 * is the trust boundary — a cloned repository can write this file, so it must
 * not be able to change injection, scanning, protection, paths, or permissions.
 * @param content - the file content, or `null` when the file does not exist.
 * @param source - the file path, used in warnings.
 * @returns the accepted setting and the warnings to report.
 */
export function parseWikiSettings(content: string | null, source = WIKI_SETTINGS_FILE): WikiSettings {
  if (content === null) return { commit: false, warnings: [] }
  const warnings: string[] = []
  const keys = new Set<string>()
  let commit: boolean | null = null
  for (const rawLine of content.replace(/\r\n?/gu, '\n').split('\n')) {
    const line = rawLine.replace(/#.*$/u, '').trim()
    if (line === '') continue
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*):(.*)$/u.exec(line)
    if (match === null) {
      warnings.push(`${source}: ignored the line ${JSON.stringify(rawLine.trim())} (only \`key: value\` lines are understood)`)
      continue
    }
    const key = (match[1] as string).trim()
    const value = (match[2] as string).trim()
    keys.add(key)
    if (key === 'commit') {
      if (/^true$/iu.test(value)) commit = true
      else if (/^false$/iu.test(value)) commit = false
      else {
        commit = false
        warnings.push(
          `${source}: \`commit\` must be true or false, but is ${JSON.stringify(value)}; treated as false`,
        )
      }
    }
  }
  for (const key of keys) {
    if (key !== 'commit' && key !== 'version') {
      warnings.push(`${source}: ignored the unknown key \`${key}\` (only \`commit\` is accepted; §6.3)`)
    }
  }
  return { commit: commit ?? false, warnings }
}

/**
 * A short-lived memo of `rev-parse` answers, keyed by the directory it was run
 * in.
 *
 * The pre-step listener is a hot path — it runs for every proposed step — and
 * one session's checkout root cannot change while it runs, so the answer is
 * reused for {@link WIKI_ROOT_CACHE_TTL_MS}. The full inspection is **not**
 * cached: `.dsh/wiki.yml` and the `.gitignore` state are re-read every time, so
 * an edit made in the editor shows up on the next step.
 */
export interface WikiRootCache {
  /**
   * CWD → the cached answer, why it failed (when it did), and the moment it was
   * taken. The failure detail is cached with the answer so a debug log does not
   * have to re-run git to say why there is no wiki.
   */
  readonly entries: Map<string, WikiRootCacheEntry>
}

/** One cached `rev-parse` answer and the moment it was taken. */
export interface WikiRootCacheEntry {
  /** When the answer was taken, for the TTL. */
  readonly at: number
  /** The roots, or `null` when the directory is not a usable worktree. */
  readonly roots: GitRoots | null
  /** One line saying why there is no root, or `null` on success. */
  readonly detail: string | null
}

/**
 * Cached `rev-parse` answer plus why it failed, when it did.
 *
 * `resolveGitRoots` folds "not a repository", "bare", and "git failed" into
 * `null`; the diagnostic kept here is for the debug log only.
 */
interface RootsAnswer {
  /** The roots, or `null` when the directory is not a usable worktree. */
  readonly roots: GitRoots | null
  /** One line saying why there is no root, or `null` on success. */
  readonly detail: string | null
}

/** How long one `rev-parse` answer is reused (milliseconds). */
export const WIKI_ROOT_CACHE_TTL_MS = 2000

/**
 * Create an empty cache; one lives per plugin instance.
 * @returns a cache with no `rev-parse` answers, for {@link inspectWiki}'s `cache` option.
 */
export function createWikiRootCache(): WikiRootCache {
  return { entries: new Map() }
}

/** Options for {@link inspectWiki}; the git runner is the injection seam. */
export interface InspectOptions {
  /** Directory the session records as its working directory (`header.cwd`). */
  readonly cwd: string
  /** Command runner; the knowledge-common default is `node:child_process`. */
  readonly run?: GitRunner
  /** Cancellation. */
  readonly signal?: AbortSignal
  /** Optional memo for the `rev-parse` answer; see {@link WikiRootCache}. */
  readonly cache?: WikiRootCache
}

/**
 * Resolve the checkout root, through the cache when one was supplied.
 * @param options - cwd, git seam, cancellation, and the optional cache.
 * @returns the roots and, when there are none, one line saying why.
 */
async function rootsFor(options: InspectOptions): Promise<RootsAnswer> {
  const cached = options.cache?.entries.get(options.cwd)
  if (cached !== undefined && Date.now() - cached.at < WIKI_ROOT_CACHE_TTL_MS) {
    if (options.signal?.aborted !== true) return { roots: cached.roots, detail: cached.detail }
  }
  const answer = await runRevParse(options)
  options.cache?.entries.set(options.cwd, { at: Date.now(), roots: answer.roots, detail: answer.detail })
  if (options.cache !== undefined && options.cache.entries.size > 64) {
    const oldest = [...options.cache.entries.entries()]
      .sort((left, right) => left[1].at - right[1].at)[0] as [string, WikiRootCacheEntry]
    options.cache.entries.delete(oldest[0])
  }
  return answer
}

/** Run `rev-parse` once and describe a failure in one line. */
async function runRevParse(options: InspectOptions): Promise<RootsAnswer> {
  const run = options.run ?? defaultRunner
  const top = await run(['rev-parse', '--show-toplevel'], { cwd: options.cwd, ...(options.signal ? { signal: options.signal } : {}) })
  if (top.code !== 0 || top.stdout.trim() === '') {
    return {
      roots: null,
      detail: `git rev-parse --show-toplevel exited ${String(top.code)} in ${options.cwd}${top.stderr.trim() === '' ? '' : `: ${top.stderr.trim()}`}`,
    }
  }
  const roots = await resolveGitRoots(options.cwd, gitHelperOptions(options.run, options.signal))
  return { roots, detail: roots === null ? `${options.cwd} is not a usable git worktree` : null }
}

/** The default runner, for the diagnostic `rev-parse` above. */
const defaultRunner: GitRunner = createNodeGitRunner()

/** A wiki that exists and may be read (DESIGN §6.2). */
export interface WikiRoot {
  /** `rev-parse --show-toplevel` in the session's cwd. */
  readonly checkoutRoot: string
  /** `<checkoutRoot>/.dsh/wiki`. */
  readonly wikiRoot: string
  /** `<checkoutRoot>/.dsh/wiki.yml`. */
  readonly settingsFile: string
}

/** The possible answers about one session's project wiki. */
export type WikiInspection =
  | {
    /** The wiki is present. */
    readonly kind: 'found'
    /** The resolved root. */
    readonly root: WikiRoot
    /** The accepted `.dsh/wiki.yml` values. */
    readonly settings: WikiSettings
    /**
       * Whether `<wikiRoot>` is inside `header.cwd`, i.e. whether `write` and
       * `edit` may touch it (DESIGN §6.2).
       */
    readonly writable: boolean
    /** Git's answer about the wiki directory's ignore state. */
    readonly ignore: IgnoreFinding
    /** Everything worth telling the user, in a stable order. */
    readonly warnings: readonly string[]
  }
  | {
    /** There is no wiki here, or there cannot be one. */
    readonly kind: 'absent'
    /** Why, for the debug log. */
    readonly detail: string
  }

/**
 * Ask git about the wiki directory's ignore state (DESIGN §6.3, 前段の申し送り).
 *
 * `git check-ignore -q` answers 0 (ignored) and 1 (not ignored). A path behind
 * a symlinked parent makes git fail with **exit 128**, which the knowledge-common
 * helper reports as `{ignored: false, code: 128}` — indistinguishable from a
 * real "not ignored" unless the status is inspected. That case is reported as
 * `unknown` here: the plugin warns about what it cannot prove instead of
 * claiming the wiki will be committed.
 * @param root - the checkout root.
 * @param options - git runner and cancellation.
 * @returns the three-way answer.
 */
export async function inspectIgnore(root: string, options: InspectOptions): Promise<IgnoreFinding> {
  const ignored = await checkIgnored(root, WIKI_IGNORE_PROBE, gitHelperOptions(options.run, options.signal))
  if (ignored.code === 0) return { state: 'ignored', detail: null }
  if (ignored.code === 1) return { state: 'visible', detail: null }
  return {
    state: 'unknown',
    detail: `git check-ignore exited ${String(ignored.code)} for ${WIKI_IGNORE_PROBE}, so the ignore state could not be decided`,
  }
}

/**
 * Produce the warnings DESIGN §6.3 asks for by comparing `.dsh/wiki.yml` with
 * what git reports.
 *
 * The plugin does not manage `.gitignore` — `dsh-memory` owns the block (§5.1)
 * — so the only thing it can do here is report an inconsistency:
 *
 * - `commit: true` while the directory is not ignored is the normal state after
 *   `!.dsh/wiki/` was added, or when `dsh-memory` has not run; the message says
 *   which.
 * - `commit: false` while the directory is not ignored means the directory can
 *   be committed by `git add -A`, which the user should know.
 * - An undecidable answer is reported as undecidable, not as not-ignored.
 * @param settings - the parsed `.dsh/wiki.yml`.
 * @param ignore - git's answer.
 * @param wikiDirectory - the repository-relative directory, for the message.
 * @param probe - the path git was asked about; the wiki directory by default.
 * @returns the warnings, in a stable order.
 */
export function settingsWarnings(
  settings: WikiSettings,
  ignore: IgnoreFinding,
  wikiDirectory = WIKI_DIRECTORY,
  probe = WIKI_IGNORE_PROBE,
): string[] {
  if (ignore.state === 'unknown') {
    return [
      `${ignore.detail ?? 'the ignore state is undecidable'}; confirm by hand that ${probe} is handled as intended`,
    ]
  }
  if (settings.commit && ignore.state === 'visible') {
    return [
      `${WIKI_SETTINGS_FILE} sets commit: true and ${probe} is not ignored, which is what a tracked wiki needs; if the managed .gitignore block is missing, add the line \`${unignoreLine(wikiDirectory)}\` (dsh-memory maintains that block)`,
    ]
  }
  if (!settings.commit && ignore.state === 'visible') {
    return [
      `${WIKI_SETTINGS_FILE} does not set commit: true, so the wiki is private, but ${probe} is not ignored and a \`git add -A\` would commit it`,
    ]
  }
  return []
}

/** The `.gitignore` line that un-ignores the wiki directory (DESIGN §3.2, T6). */
function unignoreLine(wikiDirectory: string): string {
  return `!${wikiDirectory.replace(/(?<!\/)$/u, '/')}`
}

/**
 * Inspect one session's project wiki (DESIGN §6.2, §6.3).
 *
 * Reading is always allowed when the directory exists; the containment rule
 * only decides {@link WikiInspection.writable}. A `cwd` without a git worktree,
 * or a checkout root whose `.dsh/wiki` is missing, is `absent` — the plugin
 * then has no tool, no notice, and no guard for that session.
 * @param options - cwd, git runner, and cancellation.
 * @returns the inspection.
 */
export async function inspectWiki(options: InspectOptions): Promise<WikiInspection> {
  let answer: RootsAnswer
  try {
    answer = await rootsFor(options)
  } catch (error) {
    const message = describeError(error)
    return { kind: 'absent', detail: `no git worktree could be resolved from ${options.cwd}: ${message}` }
  }
  if (answer.roots === null) {
    return {
      kind: 'absent',
      detail: `no git worktree could be resolved from ${options.cwd}${answer.detail === null ? '' : ` (${answer.detail})`}`,
    }
  }
  const checkoutRoot = await canonicalizeTargetPath(answer.roots.checkoutRoot)
  const wikiRoot = path.join(checkoutRoot, WIKI_DIRECTORY)
  try {
    const info = await stat(wikiRoot)
    if (!info.isDirectory()) {
      return { kind: 'absent', detail: `${wikiRoot} exists but is not a directory` }
    }
  } catch {
    return { kind: 'absent', detail: `there is no wiki at ${wikiRoot}` }
  }
  const settings = await readWikiSettings(path.join(checkoutRoot, WIKI_SETTINGS_FILE))
  const ignore = await inspectIgnore(checkoutRoot, options)
  const [canonicalWiki, canonicalCwd] = await Promise.all([
    canonicalizeTargetPath(wikiRoot),
    canonicalizeTargetPath(options.cwd),
  ])
  const writable = isPathWithin(canonicalCwd, canonicalWiki)
  const warnings = [...settings.warnings, ...settingsWarnings(settings, ignore)]
  return {
    kind: 'found',
    root: { checkoutRoot, wikiRoot, settingsFile: path.join(checkoutRoot, WIKI_SETTINGS_FILE) },
    settings,
    writable,
    ignore,
    warnings,
  }
}

/**
 * Read `<checkoutRoot>/.dsh/wiki.yml` and parse it (DESIGN §6.3).
 *
 * The search is exactly this one path: no parent directory, no `$DSH_HOME`, and
 * no Profile value is merged in.
 * @param file - the settings file.
 * @returns the accepted setting and the warnings to report.
 */
export async function readWikiSettings(file: string): Promise<WikiSettings> {
  try {
    return parseWikiSettings(await readFile(file, 'utf8'), file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { commit: false, warnings: [] }
    const message = describeError(error)
    return {
      commit: false,
      warnings: [`${file} could not be read (${message}); treated as commit: false`],
    }
  }
}
