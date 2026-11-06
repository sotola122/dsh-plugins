/**
 * The global wiki: the user-designated repository, its six checks, its sidecar,
 * and its skeleton (DESIGN §6.4, U5, D4).
 *
 * The global wiki is the **same** layout as the project wiki
 * (`index.md`・`raw/`・pages・a charter) placed at the top of a repository the
 * user names, with two differences. Its page directory is configurable: an
 * existing knowledge repository may keep its pages under `concepts/` instead of
 * `pages/` (`config.global.pagesDir`, DESIGN §6.4). And its charter may already
 * exist as the repository's `AGENTS.md`, in which case the skeleton must not
 * add a second one: `AGENTS.md` wins over `WIKI.md`, and only a repository with
 * neither gets the `WIKI.md` template ({@link findGlobalCharter}). That
 * placement is what makes `/wiki commit`'s pathspecs repo-relative
 * (`<pagesDir>`, `raw`, `index.md`, `WIKI.md`) and what makes `wiki_write`'s
 * paths root-relative. There is **no default path**: while nothing is
 * designated the global wiki is off, and the tool, the index, the lint, and the
 * notice leave it alone.
 *
 * ```text
 * $DSH_HOME/llm-wiki-state/repo.json   { "path": "…" } | { "disabled": true }   0600
 * <designated repo>/                   the wiki root: AGENTS.md or WIKI.md, index.md, raw/, <pagesDir>/
 * └── .gitignore                       `*.lock` — the writer locks of wiki_write
 * ```
 *
 * **Where the record lives.** The sidecar moved from `$DSH_HOME/llm-wiki` to
 * `$DSH_HOME/llm-wiki-state`: `llm-wiki` is also a plausible clone target for the
 * wiki repository itself, and a sidecar inside that clone appeared in its
 * `git status` as `?? repo.json` (and could have been committed). A usable
 * legacy file is still honoured once — read, then copied to the new path, with
 * the old file left in place — but only when its directory is **outside every
 * git work tree**. Inside one, a `repo.json` cannot be told apart from the
 * repository's own content, so it is ignored rather than guessed at.
 *
 * **Precedence.** The sidecar wins over the Profile's `global.repo`, and
 * `repo unset` writes `{disabled:true}` so a Profile value cannot resurrect the
 * wiki behind the user's back (DESIGN §6.4, §12.3).
 *
 * **Acceptance.** A path is accepted only after the design's ordered checks —
 * leading `~` expanded, absolute, existing, the top of an existing git work tree
 * (or a directory outside every repository, which this plugin then
 * `git init`s), outside `header.cwd` and `$DSH_HOME`, and finally not
 * overlapping the calling session's working directory. A rejection never stops
 * the plugin: it disables the global wiki and says so.
 * @module @anago-harness/llm-wiki/global
 */

import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  canonicalizeTargetPath,
  createNodeGitRunner,
  type GitRunner,
  isPathWithin,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  readTextFileIfExists,
  SHARED_FILE_MODE,
} from '@anago-harness/knowledge-common'
import { cwdOf, type WikiAgent } from './agents.ts'
import { describeError, wikiError } from './errors.ts'
import {
  assertPagesDirectory,
  WIKI_CHARTER_CANDIDATES,
  WIKI_CHARTER_FILE,
  WIKI_INDEX_FILE,
  WIKI_PAGES_DIRECTORY,
  WIKI_RAW_DIRECTORY,
  type WikiCharterFile,
} from './paths.ts'

/** Directory under `$DSH_HOME` that holds the plugin's own state. */
export const GLOBAL_STATE_DIRECTORY = 'llm-wiki-state'

/**
 * The directory the sidecar lived in before the move to
 * {@link GLOBAL_STATE_DIRECTORY}. It is also a plausible clone target for the
 * wiki repository itself, which is why the sidecar moved.
 */
export const LEGACY_GLOBAL_STATE_DIRECTORY = 'llm-wiki'

/** The sidecar that records the designated repository (DESIGN §6.4). */
export const GLOBAL_SIDECAR_FILE = 'repo.json'

/** The `.gitignore` entry the skeleton adds: `wiki_write`'s `<file>.lock` siblings. */
export const GLOBAL_IGNORE_LINE = '*.lock'

/**
 * `$DSH_HOME/llm-wiki-state/repo.json`.
 * @returns the absolute path of the sidecar.
 */
export function globalSidecarPath(): string {
  return dshHomePath(GLOBAL_STATE_DIRECTORY, GLOBAL_SIDECAR_FILE)
}

/**
 * `$DSH_HOME/llm-wiki/repo.json`, the record's pre-migration home.
 * @returns the absolute path of the legacy sidecar.
 */
export function legacyGlobalSidecarPath(): string {
  return dshHomePath(LEGACY_GLOBAL_STATE_DIRECTORY, GLOBAL_SIDECAR_FILE)
}

/**
 * The `$DSH_HOME` the checks compare against; overridable for a test.
 * @returns the resolved harness home: `$DSH_HOME` when set, `~/.dsh` otherwise.
 */
export function resolvedDshHome(): string {
  return dshHomePath()
}

/**
 * Expand a leading `~` or `~/` against the operating-system home (DESIGN §6.4
 * check 1). `~user` is **refused**, not guessed: the design accepts exactly the
 * two prefixes, so another user's home is a typo rather than an intent.
 * @param raw - the configured or typed path.
 * @returns the expanded path, or the reason it cannot be expanded.
 */
export function expandRepoPath(raw: string): { ok: true; path: string } | { ok: false; detail: string } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, detail: 'the path is empty' }
  if (!trimmed.startsWith('~')) return { ok: true, path: trimmed }
  if (trimmed === '~') return { ok: true, path: os.homedir() }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return { ok: true, path: path.join(os.homedir(), trimmed.slice(2)) }
  }
  return {
    ok: false,
    detail: `\`${trimmed}\` starts with ~ but is not \`~\` or \`~/\`; \`~user\` is not expanded`,
  }
}

/** How the designated path was decided (DESIGN §6.4). */
export type GlobalRepoSource = 'sidecar' | 'profile'

/** What the sidecar records. */
export type GlobalSidecarValue =
  /** The user designated this path. */
  | { readonly path: string }
  /** The user turned the global wiki off, whatever the Profile says. */
  | { readonly disabled: true }

/**
 * What {@link readGlobalSidecar} did with a pre-migration sidecar.
 *
 * The outcome is returned rather than logged here, so the state owns the logger
 * and a test can assert the decision. `used` means the value is this call's
 * value whether or not the copy succeeded; the copy is best effort, but the
 * value is not thrown away because the new directory could not be written.
 */
export type LegacySidecarOutcome =
  | {
    /** It was usable, and is this call's value. */
    readonly kind: 'used'
    /** The pre-migration file. */
    readonly from: string
    /** The current sidecar path the value was copied to. */
    readonly to: string
    /** Whether the copy succeeded. */
    readonly copied: boolean
    /** Why the copy failed, when it did. */
    readonly detail: string | null
  }
  | {
    /** It was ignored. */
    readonly kind: 'skipped'
    /** The pre-migration file. */
    readonly from: string
    /**
       * `repository` — its directory is inside a git work tree, so it may be a
       * file of that repository rather than the plugin's record; `unusable` —
       * it could not be read or is not one of the two documented shapes;
       * `unknown` — git could not say whether the directory is in a work tree.
       */
    readonly reason: 'repository' | 'unusable' | 'unknown'
    /** What was found, for the caller's log line. */
    readonly detail: string
  }

/** Reading the sidecar can also fail; the caller decides whether to warn. */
export interface GlobalSidecarReading {
  /** The accepted value, or `null` when there is no sidecar. */
  readonly value: GlobalSidecarValue | null
  /** Why the file could not be used, when it could not. */
  readonly detail: string | null
  /** How a pre-migration sidecar was handled; absent when there was none or the fallback is off. */
  readonly legacy?: LegacySidecarOutcome
}

/**
 * Parse the sidecar's JSON (DESIGN §6.4).
 *
 * Only the two documented shapes are accepted. Anything else is reported as
 * unusable rather than guessed at: a truncated file must not decide which
 * repository is the user's wiki. The caller falls back to the Profile value and
 * warns, which is the same posture `.dsh/wiki.yml` gets (§6.3).
 * @param content - the file content, or `null` when the file does not exist.
 * @returns the value and, when it is unusable, why.
 */
export function parseGlobalSidecar(content: string | null): GlobalSidecarReading {
  if (content === null) return { value: null, detail: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    return { value: null, detail: `it is not JSON (${describeError(error)})` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { value: null, detail: 'it is not a JSON object' }
  }
  const record = parsed as Record<string, unknown>
  if (record.disabled === true) return { value: { disabled: true }, detail: null }
  const value = record.path
  if (typeof value === 'string' && value.trim() !== '') return { value: { path: value }, detail: null }
  return {
    value: null,
    detail: 'it has neither a non-empty `path` nor `disabled: true`',
  }
}

/** Options for {@link readGlobalSidecar}. */
export interface ReadGlobalSidecarOptions {
  /**
   * The pre-migration sidecar to fall back to; {@link legacyGlobalSidecarPath}
   * by default. `null` turns the fallback off.
   */
  readonly legacyFile?: string | null
  /** Command runner for the "is it inside a work tree?" question. */
  readonly run?: GitRunner
  /** Cancellation. */
  readonly signal?: AbortSignal
}

/** Where one directory sits relative to git work trees. */
type WorkTreeAnswer =
  | { readonly kind: 'repository'; readonly top: string }
  | { readonly kind: 'outside' }
  | { readonly kind: 'unknown'; readonly detail: string }

/**
 * Ask git where the work tree around `directory` is (the legacy-file test).
 *
 * Exit 128 is git's answer for "not inside a work tree"; any other failure
 * means the question was not answered, which is not the same as "outside".
 * @param directory - the directory to ask from.
 * @param options - the runner and cancellation.
 * @returns the enclosing work tree, "outside", or why the answer is unknown.
 */
async function workTreeAround(
  directory: string,
  options: ReadGlobalSidecarOptions,
): Promise<WorkTreeAnswer> {
  const run = options.run ?? createNodeGitRunner()
  let result: Awaited<ReturnType<GitRunner>>
  try {
    result = await run(
      ['rev-parse', '--show-toplevel'],
      options.signal === undefined ? { cwd: directory } : { cwd: directory, signal: options.signal },
    )
  } catch (error) {
    if (options.signal?.aborted === true) throw error
    return {
      kind: 'unknown',
      detail: `git rev-parse could not run in ${directory} (${describeError(error)})`,
    }
  }
  if (result.code === 0) {
    const top = result.stdout.trim()
    return { kind: 'repository', top: top === '' ? directory : top }
  }
  if (result.code === 128) return { kind: 'outside' }
  return {
    kind: 'unknown',
    detail: `git rev-parse exited ${String(result.code)} in ${directory}${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim()}`}`,
  }
}

/**
 * Use the pre-migration sidecar when the current one is absent.
 *
 * `$DSH_HOME/llm-wiki` is a plausible clone target for the wiki repository
 * itself, so the old file is read **only after** git says its directory is
 * outside every work tree: inside one, a `repo.json` cannot be told apart from
 * the repository's own content, and reading it could designate an unrelated
 * repository as the wiki. A value that passes is copied to the current path at
 * `0600`; the old file is left exactly as it was, so a person can compare them.
 * @param file - the current sidecar path, which is absent.
 * @param options - the legacy path, the git runner, and cancellation.
 * @returns the value (with the `legacy` outcome), or an empty reading.
 */
async function readLegacySidecar(
  file: string,
  options: ReadGlobalSidecarOptions,
): Promise<GlobalSidecarReading> {
  const legacyFile = options.legacyFile === undefined ? legacyGlobalSidecarPath() : options.legacyFile
  if (legacyFile === null || path.resolve(legacyFile) === path.resolve(file)) {
    return { value: null, detail: null }
  }
  try {
    const info = await stat(legacyFile)
    if (!info.isFile()) return { value: null, detail: null }
  } catch {
    return { value: null, detail: null }
  }
  const where = await workTreeAround(path.dirname(legacyFile), options)
  if (where.kind !== 'outside') {
    return {
      value: null,
      detail: null,
      legacy: {
        kind: 'skipped',
        from: legacyFile,
        reason: where.kind === 'repository' ? 'repository' : 'unknown',
        detail:
          where.kind === 'repository'
            ? `${legacyFile} is inside the git work tree ${where.top}, so it may be a file of that repository rather than the plugin's record`
            : where.detail,
      },
    }
  }
  let content: string
  try {
    content = await readFile(legacyFile, 'utf8')
  } catch (error) {
    return {
      value: null,
      detail: null,
      legacy: {
        kind: 'skipped',
        from: legacyFile,
        reason: 'unusable',
        detail: `${legacyFile} could not be read (${describeError(error)})`,
      },
    }
  }
  const parsed = parseGlobalSidecar(content)
  if (parsed.value === null) {
    return {
      value: null,
      detail: null,
      legacy: {
        kind: 'skipped',
        from: legacyFile,
        reason: 'unusable',
        detail: `${legacyFile}: ${parsed.detail}`,
      },
    }
  }
  try {
    await writeGlobalSidecar(parsed.value, file)
    return {
      value: parsed.value,
      detail: null,
      legacy: { kind: 'used', from: legacyFile, to: file, copied: true, detail: null },
    }
  } catch (error) {
    return {
      value: parsed.value,
      detail: null,
      legacy: {
        kind: 'used',
        from: legacyFile,
        to: file,
        copied: false,
        detail: `${file} could not be written (${describeError(error)})`,
      },
    }
  }
}

/**
 * Read the sidecar, migrating a usable pre-migration one.
 *
 * The current file is authoritative: when it exists, it is used even if it is
 * unusable, and the old path is not consulted. The fallback runs only when the
 * current file is absent, and {@link readLegacySidecar} decides whether the old
 * file may be read at all.
 * @param file - the current sidecar path; {@link globalSidecarPath} by default.
 * @param options - the legacy path, the git runner, and cancellation.
 * @returns the value, why it is unusable, and what the fallback did.
 */
export async function readGlobalSidecar(
  file = globalSidecarPath(),
  options: ReadGlobalSidecarOptions = {},
): Promise<GlobalSidecarReading> {
  let content: string | null
  try {
    content = await readTextFileIfExists(file)
  } catch (error) {
    return { value: null, detail: `${file} could not be read (${describeError(error)})` }
  }
  if (content === null) return await readLegacySidecar(file, options)
  const reading = parseGlobalSidecar(content)
  return reading.detail === null ? reading : { value: null, detail: `${file}: ${reading.detail}` }
}

/**
 * Write the sidecar at `0600` (DESIGN §6.4).
 *
 * `dsh-memory` owns the `updateFileLocked` idiom for files it also reads back
 * under contention; this file has exactly one writer — the user typing
 * `/wiki repo set` — so the directory is created and the file replaced
 * atomically, which is enough to keep a reader from seeing half a JSON object.
 * @param value - what to record.
 * @param file - the sidecar path; overridable for a test.
 */
export async function writeGlobalSidecar(
  value: GlobalSidecarValue,
  file = globalSidecarPath(),
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  await writeFile(file, `${JSON.stringify(value)}\n`, { mode: PRIVATE_FILE_MODE })
}

/** The candidate the checks run on, and where it came from. */
export interface GlobalRepoCandidate {
  /** The raw configured value, before `~` expansion. */
  readonly raw: string
  /** `sidecar` when the user set it through `/wiki`, `profile` when it came from the config. */
  readonly source: GlobalRepoSource
}

/**
 * The effective candidate: the sidecar when it says anything, else the Profile
 * value (DESIGN §6.4).
 * @param profileRepo - `config.global.repo`.
 * @param sidecar - the sidecar's reading.
 * @returns the candidate, `null` when the global wiki is off, or the detail explaining a broken sidecar.
 */
export function resolveGlobalCandidate(
  profileRepo: string,
  sidecar: GlobalSidecarReading,
): { candidate: GlobalRepoCandidate | null; detail: string | null } {
  if (sidecar.value !== null) {
    if ('disabled' in sidecar.value) return { candidate: null, detail: null }
    return { candidate: { raw: sidecar.value.path, source: 'sidecar' }, detail: null }
  }
  if (profileRepo.trim() !== '') {
    return { candidate: { raw: profileRepo, source: 'profile' }, detail: sidecar.detail }
  }
  return { candidate: null, detail: sidecar.detail }
}

/** A repository the checks accepted (DESIGN §6.4). */
export interface GlobalRepo {
  /** The canonical repository top, which is also the wiki root. */
  readonly repoRoot: string
  /** Where the path came from. */
  readonly source: GlobalRepoSource
  /** Whether the directory was outside every repository, so the skeleton must `git init`. */
  readonly needsInit: boolean
}

/** What the checks concluded about the configured path. */
export type GlobalRepoInspection =
  /** Accepted. */
  | { readonly kind: 'found'; readonly repo: GlobalRepo }
  /** Refused; the detail names the check that failed. */
  | { readonly kind: 'rejected'; readonly detail: string }

/** Options for {@link inspectGlobalRepo}. */
export interface InspectGlobalRepoOptions {
  /** The session's working directory; the overlap check is skipped when absent. */
  readonly cwd?: string
  /** `$DSH_HOME`; overridable for a test. */
  readonly dshHome?: string
  /** Command runner; the knowledge-common default is `node:child_process`. */
  readonly run?: GitRunner
  /** Cancellation. */
  readonly signal?: AbortSignal
}

/** How the git top-level question was answered. */
type GitTopAnswer =
  | { readonly kind: 'top'; readonly top: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'bare' }
  | { readonly kind: 'failed'; readonly detail: string }

/** Ask git whether `directory` is the top of a work tree (DESIGN §6.4 check 4). */
async function gitTopOf(directory: string, options: InspectGlobalRepoOptions): Promise<GitTopAnswer> {
  const run = options.run ?? createNodeGitRunner()
  const runOptions = options.signal === undefined ? { cwd: directory } : { cwd: directory, signal: options.signal }
  const top = await run(['rev-parse', '--show-toplevel'], runOptions)
  if (top.code === 0 && top.stdout.trim() !== '') return { kind: 'top', top: top.stdout.trim() }
  const bare = await run(['rev-parse', '--is-bare-repository'], runOptions)
  if (bare.code === 0 && bare.stdout.trim() === 'true') return { kind: 'bare' }
  if (top.code === 128 || bare.code === 128) return { kind: 'none' }
  return {
    kind: 'failed',
    detail: `git rev-parse exited ${String(top.code)} in ${directory}${top.stderr.trim() === '' ? '' : `: ${top.stderr.trim()}`}`,
  }
}

/**
 * Run the design's ordered checks on one path (DESIGN §6.4 checks 1–5).
 *
 * | # | check |
 * | --- | --- |
 * | 1–2 | a leading `~`/`~/` expands; the result must be absolute |
 * | 3 | the path must exist and is `realpath`ed |
 * | 4 | it must be the top of an existing git work tree, or outside every repository (then `git init` is the caller's next step) |
 * | 5 | it must not be `header.cwd` or its parent or child, and must not be `$DSH_HOME` or one of its ancestors |
 *
 * The session's cwd is compared against the design's "most existing ancestor"
 * form (`canonicalizeTargetPath`), because a recorded cwd may already be gone.
 * @param candidate - the raw path and where it came from.
 * @param options - the session cwd, `$DSH_HOME`, the git seam, and cancellation.
 * @returns the accepted repository, or the reason it was refused.
 */
export async function inspectGlobalRepo(
  candidate: GlobalRepoCandidate,
  options: InspectGlobalRepoOptions = {},
): Promise<GlobalRepoInspection> {
  const expanded = expandRepoPath(candidate.raw)
  if (!expanded.ok) return { kind: 'rejected', detail: expanded.detail }
  if (!path.isAbsolute(expanded.path)) {
    return {
      kind: 'rejected',
      detail: `\`${expanded.path}\` is not absolute; give a path from the filesystem root (a relative path is not resolved against the working directory)`,
    }
  }
  let canonical: string
  try {
    canonical = await realpath(expanded.path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      kind: 'rejected',
      detail:
        code === 'ENOENT'
          ? `\`${expanded.path}\` does not exist`
          : `\`${expanded.path}\` could not be resolved (${describeError(error)})`,
    }
  }
  let info
  try {
    info = await stat(canonical)
  } catch (error) {
    /* v8 ignore next -- realpath just succeeded, so stat fails only on a permission or I/O error this call reports as a rejection. */
    return { kind: 'rejected', detail: `\`${canonical}\` could not be inspected (${describeError(error)})` }
  }
  if (!info.isDirectory()) {
    return { kind: 'rejected', detail: `\`${canonical}\` is not a directory` }
  }
  const top = await gitTopOf(canonical, options)
  let needsInit = false
  if (top.kind === 'bare') {
    return {
      kind: 'rejected',
      detail: `\`${canonical}\` is a bare repository; the wiki needs a work tree to hold WIKI.md and its pages`,
    }
  }
  if (top.kind === 'failed') return { kind: 'rejected', detail: top.detail }
  if (top.kind === 'none') {
    needsInit = true
  } else {
    let resolvedTop: string
    try {
      resolvedTop = await realpath(top.top)
    } catch {
      resolvedTop = path.resolve(top.top)
    }
    if (resolvedTop !== canonical) {
      return {
        kind: 'rejected',
        detail: `\`${canonical}\` is inside the git repository \`${resolvedTop}\` but is not its top; name the repository top itself`,
      }
    }
  }
  const dshHome = await canonicalizeTargetPath(options.dshHome ?? resolvedDshHome())
  if (isPathWithin(canonical, dshHome)) {
    return {
      kind: 'rejected',
      detail: `\`${canonical}\` is $DSH_HOME or one of its ancestors; the harness home is not a wiki repository (a child such as $DSH_HOME/wiki is accepted)`,
    }
  }
  if (options.cwd !== undefined) {
    const cwd = await canonicalizeTargetPath(options.cwd)
    if (isPathWithin(canonical, cwd) || isPathWithin(cwd, canonical)) {
      return {
        kind: 'rejected',
        detail: `\`${canonical}\` is the session's working directory (${cwd}) or a parent or child of it, so the global wiki would overlap the project being worked on; run /wiki repo set from a session started outside it`,
      }
    }
  }
  return { kind: 'found', repo: { repoRoot: canonical, source: candidate.source, needsInit } }
}

/**
 * Which file this repository uses as its charter, if any (DESIGN §6.4).
 *
 * {@link WIKI_CHARTER_CANDIDATES} is consulted in order, so `AGENTS.md` wins
 * over `WIKI.md`: a repository that already keeps its agent instructions in one
 * must not get a second charter beside it. `null` means neither exists, which
 * is the only case in which {@link ensureGlobalSkeleton} writes the `WIKI.md`
 * template.
 * @param repoRoot - the wiki root (the designated repository's top).
 * @param exists - how "does it exist" is decided; `stat` is the default.
 * @returns the charter's file name, or `null` when there is none.
 */
export async function findGlobalCharter(
  repoRoot: string,
  exists: (file: string) => Promise<boolean> = pathExists,
): Promise<WikiCharterFile | null> {
  for (const name of WIKI_CHARTER_CANDIDATES) {
    if (await exists(path.join(repoRoot, name))) return name
  }
  return null
}

/**
 * The charter the skeleton writes when the repository has none (DESIGN §6.2).
 *
 * It is only ever written under the name `WIKI.md`, and only when no
 * {@link WIKI_CHARTER_CANDIDATES} file exists, so a repository with its own
 * `AGENTS.md` never gains a second charter. The page directory is a parameter
 * because the file states the convention the reader will follow: a wiki whose
 * pages live under `concepts/` must not be told to write `pages/<slug>.md`.
 * @param pagesDir - the global wiki's page directory name; `pages` by default.
 * @returns the Markdown the skeleton writes.
 * @throws when `pagesDir` is not a usable single directory name.
 */
export function globalCharterTemplate(pagesDir: string = WIKI_PAGES_DIRECTORY): string {
  const directory = assertPagesDirectory(pagesDir)
  return `# Global wiki

This repository is the **global** LLM wiki: knowledge that is not specific to one
project. It follows the wiki convention (\`index.md\`, \`raw/\`,
\`${directory}/\`), and it is written with the \`wiki_write\` tool, not with
\`write\` or \`edit\`.

- Purpose, scope, and glossary: edit this file.
- One page per subject under \`${directory}/<slug>.md\`; the catalogue is \`index.md\`.
- Sources go under \`raw/<topic>/<YYYY-MM-DD>-<source>.md\` and are immutable.
- Committing is a person's action: \`/wiki commit [message]\`. Nothing is pushed.
`
}

/** The default catalogue written when the skeleton is created (DESIGN §6.2). */
export const GLOBAL_INDEX_TEMPLATE = `# Index

One line per page: \`- [[slug]] — one-line summary\`.
`

/** What {@link ensureGlobalSkeleton} did. */
export interface GlobalSkeletonResult {
  /** Whether `git init` ran. */
  readonly initialised: boolean
  /** Paths this call created, in a stable order. */
  readonly created: readonly string[]
  /**
   * The charter this repository uses after the call.
   *
   * It is `AGENTS.md` when the repository already had one (left untouched),
   * `WIKI.md` when one already existed, and `WIKI.md` when this call created the
   * template — so the value is what `/wiki status` and `/wiki repo set` should
   * report, not merely what was found beforehand.
   */
  readonly charter: WikiCharterFile
}

/** Options for {@link ensureGlobalSkeleton}. */
export interface EnsureGlobalSkeletonOptions extends InspectGlobalRepoOptions {
  /** Cancellation of the filesystem work. */
  readonly signal?: AbortSignal
  /** Where "did it exist" is decided; `stat` is the default. */
  readonly exists?: (file: string) => Promise<boolean>
  /**
   * The global wiki's page directory (DESIGN §6.4). `pages` by default; an
   * existing repository that keeps its pages under `concepts/` gets that
   * directory created and never a stray `pages/`.
   */
  readonly pagesDir?: string
}

/** Whether one path exists. */
async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/**
 * Create the skeleton the design lists (DESIGN §6.4 check 6), idempotently.
 *
 * `index.md`, the page directory, and `raw/` are created only when they are
 * missing, so a user's own catalogue is never overwritten, and `.gitignore`
 * gains `*.lock` only when that line is absent. The charter is written **only
 * when the repository has neither `AGENTS.md` nor `WIKI.md`**
 * ({@link findGlobalCharter}): a repository whose agent instructions already
 * live in `AGENTS.md` keeps that file as its charter and gets no second one,
 * and this is why the template follows the configured page directory. A
 * directory that is not yet a repository is `git init`ed **locally** — nothing
 * is fetched, nothing is connected to a remote, and nothing is committed.
 * @param repo - the accepted repository.
 * @param options - the git seam and cancellation.
 * @returns what was created and which charter the repository now has.
 */
export async function ensureGlobalSkeleton(
  repo: GlobalRepo,
  options: EnsureGlobalSkeletonOptions = {},
): Promise<GlobalSkeletonResult> {
  const created: string[] = []
  const exists = options.exists ?? pathExists
  const pagesDir = assertPagesDirectory(options.pagesDir ?? WIKI_PAGES_DIRECTORY)
  // Decided before anything is written: `AGENTS.md` wins over `WIKI.md`, and a
  // repository with either one is left alone.
  const existingCharter = await findGlobalCharter(repo.repoRoot, exists)
  let initialised = false
  if (repo.needsInit) {
    const run = options.run ?? createNodeGitRunner()
    const result = await run(
      ['init', '--quiet'],
      options.signal === undefined ? { cwd: repo.repoRoot } : { cwd: repo.repoRoot, signal: options.signal },
    )
    if (result.code !== 0) {
      throw new Error(
        `git init failed in ${repo.repoRoot} (exit ${String(result.code)}): ${result.stderr.trim()}`,
      )
    }
    initialised = true
    created.push(path.join(repo.repoRoot, '.git'))
  }
  for (const name of [pagesDir, WIKI_RAW_DIRECTORY]) {
    const directory = path.join(repo.repoRoot, name)
    if (await exists(directory)) continue
    await mkdir(directory, { recursive: true, mode: 0o755 })
    created.push(directory)
  }
  if (existingCharter === null) {
    const file = path.join(repo.repoRoot, WIKI_CHARTER_FILE)
    await writeFile(file, globalCharterTemplate(pagesDir), { mode: SHARED_FILE_MODE })
    created.push(file)
  }
  const index = path.join(repo.repoRoot, WIKI_INDEX_FILE)
  if (!(await exists(index))) {
    await writeFile(index, GLOBAL_INDEX_TEMPLATE, { mode: SHARED_FILE_MODE })
    created.push(index)
  }
  const ignore = path.join(repo.repoRoot, '.gitignore')
  const current = await readTextFileIfExists(ignore)
  const lines = (current ?? '').split(/\r?\n/u).map(line => line.trim())
  if (!lines.includes(GLOBAL_IGNORE_LINE)) {
    const prefix = current === null || current === '' ? '' : current.endsWith('\n') ? current : `${current}\n`
    await writeFile(ignore, `${prefix}${GLOBAL_IGNORE_LINE}\n`, { mode: SHARED_FILE_MODE })
    created.push(ignore)
  }
  return { initialised, created, charter: existingCharter ?? WIKI_CHARTER_FILE }
}

/**
 * The refusal text for a global wiki that is off for this session (DESIGN §6.4).
 *
 * A rejected path and a disabled one are different problems — one is a
 * configuration mistake, the other simply means there is no global wiki here —
 * so they carry different codes, and the disabled case names the command that
 * fixes it.
 * @param view - the session's view, which must not be `found`.
 * @returns the message, starting with the stable code.
 */
export function globalDisabledReason(
  view: Exclude<GlobalSessionView, { kind: 'found' }>,
): string {
  return view.kind === 'rejected'
    ? wikiError('WIKI_REPO_REJECTED', `the global wiki repository was refused: ${view.detail}`).message
    : wikiError(
      'WIKI_GLOBAL_DISABLED',
      `there is no global wiki in this session: ${view.detail}. A person designates one with /wiki repo set <path>`,
    ).message
}

/** What the plugin knows about the global wiki right now (DESIGN §6.4). */
export type GlobalRepoView =
  /** The user designated no repository, or disabled it. */
  | { readonly kind: 'disabled'; readonly detail: string }
  /** A path was designated and the checks refused it. */
  | { readonly kind: 'rejected'; readonly detail: string }
  /** The repository is usable. */
  | { readonly kind: 'found'; readonly repo: GlobalRepo }

/** The view for one session: the repository view plus the cwd rule (DESIGN §6.4 check 5). */
export type GlobalSessionView = GlobalRepoView

/** The logger levels this module uses. */
export interface GlobalLogger {
  /** A recoverable problem; the global wiki is disabled or the call refuses. */
  warn(message: string, ...args: unknown[]): void
  /** Normal, expected conditions. */
  debug(message: string, ...args: unknown[]): void
}

/** What {@link createGlobalWikiState} needs. */
export interface GlobalWikiStateDeps {
  /** `config.global.repo`, the Profile's value. */
  readonly profileRepo: () => string
  /**
   * `config.global.pagesDir`, the directory the global wiki keeps its pages in.
   * `pages` by default; read by the lint, the notice, `/wiki`, and the skeleton.
   */
  readonly pagesDir?: string
  /** Where recoverable problems go. */
  readonly logger: GlobalLogger
  /** The current sidecar path; overridable for a test. */
  readonly sidecarFile?: string
  /**
   * The pre-migration sidecar path ({@link legacyGlobalSidecarPath}), or `null`
   * to turn the fallback off. A suite passes a path under its own temporary
   * home, so no test reads the developer's real `$DSH_HOME`.
   */
  readonly legacySidecarFile?: string | null
  /** `$DSH_HOME`; overridable for a test. */
  readonly dshHome?: string
  /** Command runner; overridable for a test. */
  readonly run?: GitRunner
}

/**
 * The plugin's view of the global wiki, shared by the tool, the guard, the
 * lint, the notice, and `/wiki`.
 *
 * The checks that cost a `realpath` and a `rev-parse` (1–4 and the `$DSH_HOME`
 * rule) are memoized until something changes the designation; the cwd rule is
 * memoized per session, because the design runs it once per `agent/created` and
 * a session's cwd never moves. {@link GlobalWikiState.invalidate} is what
 * `/wiki repo set` and `repo unset` call, so the next call re-reads the
 * sidecar.
 */
export interface GlobalWikiState {
  /** The repository view, re-derived after {@link GlobalWikiState.invalidate}. */
  resolve(): Promise<GlobalRepoView>
  /** The same view with this session's cwd rule applied. */
  forAgent(agent: WikiAgent | undefined): Promise<GlobalSessionView>
  /** Forget the memoized repository (the designation changed). */
  invalidate(): void
  /** Warm the view for one agent and surface a Profile rejection once. Never throws. */
  noteAgent(agent: unknown): void
  /**
   * Validate a path, create its skeleton, record it, and invalidate: the whole
   * of `/wiki repo set`. The sidecar write lives here rather than in the
   * command so the path that is validated is the path that is recorded.
   */
  designate(
    raw: string,
    options?: { readonly cwd?: string; readonly signal?: AbortSignal },
  ): Promise<
    | {
      readonly kind: 'found'
      readonly repo: GlobalRepo
      readonly skeleton: GlobalSkeletonResult
      readonly sidecar: string
    }
    | { readonly kind: 'rejected'; readonly detail: string }
  >
  /** Record `{disabled:true}` and invalidate: the whole of `/wiki repo unset`. */
  disable(): Promise<{ readonly sidecar: string; readonly was: GlobalRepoView }>
  /** Where the record lives, for `/wiki status` and the messages. */
  readonly sidecarFile: string
  /**
   * The global wiki's page directory name (`config.global.pagesDir`). It is
   * carried here so the lint, the notice, and `/wiki` do not each have to be
   * handed the configuration, and so the skeleton, the index, and the tools all
   * read the same value.
   */
  readonly pagesDir: string
}

/**
 * Say what happened to a pre-migration sidecar (DESIGN §6.4).
 *
 * A successful migration is normal and stays at `debug`; the old file is left
 * on disk for a person to compare. The skipped cases are `debug` too: the old
 * directory is a best-effort source, and `/wiki status` already says whether a
 * repository is designated. Only a **failed copy** is a warning, because then
 * the old file remains the only record and the user should know.
 * @param logger - where the line goes.
 * @param outcome - what {@link readGlobalSidecar} did, when it did anything.
 */
function reportLegacyOutcome(
  logger: GlobalLogger,
  outcome: LegacySidecarOutcome | undefined,
): void {
  if (outcome === undefined) return
  if (outcome.kind === 'used') {
    if (outcome.copied) {
      logger.debug(
        'dsh-llm-wiki: migrated the legacy global wiki sidecar from %s to %s; the old file was left in place',
        outcome.from,
        outcome.to,
      )
    } else {
      logger.warn(
        'dsh-llm-wiki: the legacy global wiki sidecar %s was used, but copying it to %s failed (%s); the old file is still the only record',
        outcome.from,
        outcome.to,
        outcome.detail,
      )
    }
    return
  }
  logger.debug(
    'dsh-llm-wiki: ignored the legacy global wiki sidecar %s (%s): %s',
    outcome.from,
    outcome.reason,
    outcome.detail,
  )
}

/**
 * Build the state (DESIGN §6.4).
 * @param deps - the Profile's repository and page-directory values, the logger,
 * the sidecar paths, `$DSH_HOME`, and the git runner.
 * @returns the memoized repository views, designation and disable operations,
 * and the resolved sidecar path and page directory.
 */
export function createGlobalWikiState(deps: GlobalWikiStateDeps): GlobalWikiState {
  const sidecarFile = deps.sidecarFile ?? globalSidecarPath()
  // The fallback is consulted only when `sidecarFile` is absent. It resolves
  // against `$DSH_HOME` like the current path, so a suite that overrides the
  // sidecar must override this too (or pass `null`) to stay out of the real home.
  const legacySidecarFile =
    deps.legacySidecarFile === undefined ? legacyGlobalSidecarPath() : deps.legacySidecarFile
  // The schema refuses an unusable directory before this runs; the assertion is
  // the second check, so a value that bypassed the schema cannot make the
  // skeleton, the lint, or the search index join a path outside the repository.
  const pagesDir = assertPagesDirectory(deps.pagesDir ?? WIKI_PAGES_DIRECTORY)
  let generation = 0
  let memo: { readonly generation: number; readonly view: GlobalRepoView } | undefined
  const perAgent = new WeakMap<object, { readonly generation: number; readonly view: GlobalSessionView }>()
  const warned = new Set<string>()

  const runOptions = (): InspectGlobalRepoOptions => ({
    ...(deps.dshHome === undefined ? {} : { dshHome: deps.dshHome }),
    ...(deps.run === undefined ? {} : { run: deps.run }),
  })

  const resolve = async (): Promise<GlobalRepoView> => {
    if (memo !== undefined && memo.generation === generation) return memo.view
    const reading = await readGlobalSidecar(sidecarFile, {
      legacyFile: legacySidecarFile,
      ...(deps.run === undefined ? {} : { run: deps.run }),
    })
    reportLegacyOutcome(deps.logger, reading.legacy)
    const { candidate, detail } = resolveGlobalCandidate(deps.profileRepo(), reading)
    // A sidecar that cannot be used is reported whichever way the fallback went:
    // it is the record `/wiki repo set` wrote, so silently ignoring it would
    // hide a real problem.
    if (detail !== null && !warned.has(detail)) {
      warned.add(detail)
      deps.logger.warn('dsh-llm-wiki: %s', detail)
    }
    let view: GlobalRepoView
    if (candidate === null) {
      view = {
        kind: 'disabled',
        detail: detail ?? 'no global wiki repository is designated (set global.repo or run /wiki repo set <path>)',
      }
    } else {
      const inspection = await inspectGlobalRepo(candidate, runOptions())
      view =
        inspection.kind === 'found'
          ? { kind: 'found', repo: inspection.repo }
          : {
            kind: 'rejected',
            detail: `${inspection.detail} (${candidate.source === 'profile' ? 'from the Profile global.repo' : 'from /wiki repo set'})`,
          }
      if (view.kind === 'rejected' && !warned.has(view.detail)) {
        warned.add(view.detail)
        deps.logger.warn('dsh-llm-wiki: WIKI_REPO_REJECTED: %s', view.detail)
      }
    }
    memo = { generation, view }
    return view
  }

  const forAgent = async (agent: WikiAgent | undefined): Promise<GlobalSessionView> => {
    const view = await resolve()
    if (agent === undefined) {
      return { kind: 'disabled', detail: 'this call has no agent, so the session cannot be checked against the repository' }
    }
    const cached = perAgent.get(agent)
    if (cached !== undefined && cached.generation === generation) return cached.view
    let sessionView: GlobalSessionView = view
    if (view.kind === 'found') {
      const cwd = cwdOf(agent)
      if (cwd === undefined) {
        sessionView = {
          kind: 'disabled',
          detail: 'this session recorded no working directory, so the global wiki is disabled here (DESIGN §6.4 check 5)',
        }
      } else {
        const [canonicalCwd, canonicalRepo] = await Promise.all([
          canonicalizeTargetPath(cwd),
          canonicalizeTargetPath(view.repo.repoRoot),
        ])
        if (isPathWithin(canonicalRepo, canonicalCwd) || isPathWithin(canonicalCwd, canonicalRepo)) {
          sessionView = {
            kind: 'disabled',
            detail: `the global wiki at ${view.repo.repoRoot} overlaps this session's working directory (${canonicalCwd}), so it is disabled here and write/edit are not denied`,
          }
        }
      }
    }
    perAgent.set(agent, { generation, view: sessionView })
    return sessionView
  }

  return {
    sidecarFile,
    pagesDir,
    resolve,
    forAgent,
    invalidate: () => {
      generation += 1
      memo = undefined
    },
    noteAgent: (agent: unknown) => {
      if (agent === undefined || agent === null) return
      void forAgent(agent as WikiAgent).catch((error: unknown) => {
        deps.logger.warn('dsh-llm-wiki: the global wiki could not be inspected (%s)', describeError(error))
      })
    },
    designate: async (raw, options = {}) => {
      const candidate: GlobalRepoCandidate = { raw, source: 'sidecar' }
      const inspection = await inspectGlobalRepo(candidate, {
        ...runOptions(),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      if (inspection.kind === 'rejected') return { kind: 'rejected', detail: inspection.detail }
      const skeleton = await ensureGlobalSkeleton(inspection.repo, {
        ...runOptions(),
        pagesDir,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      await writeGlobalSidecar({ path: inspection.repo.repoRoot }, sidecarFile)
      generation += 1
      memo = undefined
      return { kind: 'found', repo: inspection.repo, skeleton, sidecar: sidecarFile }
    },
    disable: async () => {
      const was = await resolve()
      await writeGlobalSidecar({ disabled: true }, sidecarFile)
      generation += 1
      memo = undefined
      return { sidecar: sidecarFile, was }
    },
  }
}

/** One entry of `git status --porcelain=v1 -z`. */
export interface GitStatusEntry {
  /** The index-side status letter (`' '` when the work tree only changed). */
  readonly index: string
  /** The work-tree-side status letter (`' '` when only the index changed). */
  readonly worktree: string
  /** The repository-relative path. */
  readonly path: string
}

/**
 * Parse `git status --porcelain=v1 -z` (DESIGN §6.6's `/wiki status`).
 *
 * The `-z` form is used because a page name may contain a space; a rename entry
 * carries two NUL-separated paths, and the destination is the one that matters.
 * @param output - the raw stdout.
 * @returns one entry per changed path.
 */
export function parseGitStatus(output: string): GitStatusEntry[] {
  const fields = output.split('\0')
  const entries: GitStatusEntry[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] as string
    if (field.length < 4) continue
    const indexStatus = field.slice(0, 1)
    const worktreeStatus = field.slice(1, 2)
    const path0 = field.slice(3)
    entries.push({ index: indexStatus, worktree: worktreeStatus, path: path0 })
    // A rename/copy entry is followed by the source path in its own NUL field.
    if (indexStatus === 'R' || indexStatus === 'C') index += 1
  }
  return entries
}

/**
 * One line summarizing a repository's working state.
 * @param entries - the changed paths {@link parseGitStatus} found.
 * @returns `clean` for no entries, else the change count and the staged,
 * modified, and untracked counts that are non-zero.
 */
export function summarizeGitStatus(entries: readonly GitStatusEntry[]): string {
  if (entries.length === 0) return 'clean'
  let staged = 0
  let modified = 0
  let untracked = 0
  for (const entry of entries) {
    if (entry.index === '?' && entry.worktree === '?') {
      untracked += 1
      continue
    }
    if (entry.index !== ' ' && entry.index !== '?') staged += 1
    if (entry.worktree !== ' ' && entry.worktree !== '?') modified += 1
  }
  const parts: string[] = [`${String(entries.length)} changed`]
  if (staged > 0) parts.push(`${String(staged)} staged`)
  if (modified > 0) parts.push(`${String(modified)} modified`)
  if (untracked > 0) parts.push(`${String(untracked)} untracked`)
  return parts.join(', ')
}

/**
 * Ask git for the working state of the global wiki (DESIGN §6.6).
 * @param repoRoot - the global wiki repository's top directory, the git working directory.
 * @param options - the command runner and the cancellation signal; the defaults
 * run `git` as a child process and do not cancel.
 * @returns the one-line summary with `detail: null`, or `unknown` with git's
 * exit code and stderr as the detail.
 */
export async function readGitStatus(
  repoRoot: string,
  options: { readonly run?: GitRunner; readonly signal?: AbortSignal } = {},
): Promise<{ readonly summary: string; readonly detail: string | null }> {
  const run = options.run ?? createNodeGitRunner()
  const result = await run(
    ['status', '--porcelain=v1', '-z'],
    options.signal === undefined ? { cwd: repoRoot } : { cwd: repoRoot, signal: options.signal },
  )
  if (result.code !== 0) {
    return {
      summary: 'unknown',
      detail: `git status exited ${String(result.code)}${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim()}`}`,
    }
  }
  return { summary: summarizeGitStatus(parseGitStatus(result.stdout)), detail: null }
}
