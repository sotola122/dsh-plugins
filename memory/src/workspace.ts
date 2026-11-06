/**
 * The workspace store's root, its three preconditions, and the managed
 * `.gitignore` block (DESIGN §5.1, N1, Q8).
 *
 * The root comes from git, never from a setting: `rev-parse --show-toplevel`
 * for the worktree the session runs in, folded onto the main checkout when the
 * answer's common git directory ends in `.git`, so a linked worktree shares one
 * workspace memory instead of splitting it. **No git root means no workspace
 * store at all** — the sixth revision removed the non-git save mode — so this
 * module reports "unavailable" rather than falling back to a directory under
 * the cwd.
 *
 * Two callers share it:
 *
 * - the **injection path** asks once per pre-step and never writes. A missing
 *   rule, a tracked file, or an unusable block simply means the workspace store
 *   is skipped this step (DESIGN §5.1: 注入時には書かない);
 * - the **tool** asks before every write and may add the block, re-checking
 *   `check-ignore` afterwards because an ignore rule can be defeated by a later
 *   negation. `/memory gitignore` calls the same {@link syncGitignoreBlock}, and
 *   so does an approved staged write — the first real write of the store.
 * @module @anago-harness/memory/workspace
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type AtomicWriteApi,
  canonicalizeTargetPath,
  checkIgnored,
  ensureGitignoreBlock,
  expectedGitignoreLines,
  GitignoreEditError,
  gitHelperOptions,
  inspectGitignoreBlock,
  type GitRoots,
  type GitRunner,
  listTrackedFiles,
  readTextFileIfExists,
  renderGitignoreBlock,
  resolveGitRoots,
} from '@anago-harness/knowledge-common'
import { describeError, type MemoryError, memoryError } from './errors.ts'

/** Directory under the project root that holds the workspace store (Q2). */
export const WORKSPACE_DIRECTORY = path.join('.dsh', 'memory')

/** File name of every memory store. */
export const MEMORY_FILE_NAME = 'MEMORY.md'

/** File name of the global user-profile store. */
export const USER_FILE_NAME = 'USER.md'

/** Repository-relative path the ignore check asks about (DESIGN §5.1 condition 2). */
export const WORKSPACE_RELATIVE_FILE = path.join(WORKSPACE_DIRECTORY, MEMORY_FILE_NAME)

/** Where the workspace store lives, once git has answered. */
export interface WorkspaceStore {
  /**
   * The main checkout's root: the repository's `.gitignore` and the store both
   * live here, so a linked worktree shares them (Q8).
   */
  readonly root: string
  /** The worktree the session's cwd is in (`rev-parse --show-toplevel`). */
  readonly checkoutRoot: string
  /** `<root>/.dsh/memory/MEMORY.md`. */
  readonly file: string
  /** `<root>/.gitignore`, the file the managed block is written to. */
  readonly gitignore: string
  /** Whether the session runs in a linked worktree. */
  readonly worktree: boolean
}

/** Why the workspace store is not usable right now. */
export type WorkspaceUnavailableReason =
  /** `workspace.enabled: false`. */
  | 'disabled'
  /** No git root: not a repository, a bare repository, or git failed (DESIGN §5.1, sixth revision). */
  | 'no-git'
  /** `git ls-files -- .dsh/memory` is not empty (DESIGN §5.1 condition 3). */
  | 'tracked'

/** The result of the three preconditions (DESIGN §5.1). */
export type WorkspaceInspection =
  | { readonly kind: 'ready'; readonly store: WorkspaceStore; readonly ignored: boolean }
  | {
    readonly kind: 'unavailable'
    readonly reason: WorkspaceUnavailableReason
    readonly detail: string
  }

/** Inputs for {@link inspectWorkspace}. */
export interface WorkspaceInspectionOptions {
  /** Directory the session records as its working directory (`header.cwd`). */
  readonly cwd: string
  /** `workspace.enabled`. */
  readonly enabled: boolean
  /** Command runner; the knowledge-common default is `node:child_process`. */
  readonly run?: GitRunner
  /** Cancellation. */
  readonly signal?: AbortSignal
}

/**
 * Run the three preconditions without writing anything (DESIGN §5.1).
 *
 * Order matters: a missing git root outranks everything, and a tracked file
 * outranks the ignore question, because an ignore rule cannot apply to a path
 * git already tracks (`gitignore(5)`).
 * @param options - cwd, the workspace switch, and the git seam.
 * @returns the store when it may be read and written, or why it may not.
 */
export async function inspectWorkspace(
  options: WorkspaceInspectionOptions,
): Promise<WorkspaceInspection> {
  if (!options.enabled) {
    return { kind: 'unavailable', reason: 'disabled', detail: 'workspace.enabled is false' }
  }
  let roots: GitRoots | null
  try {
    roots = await resolveGitRoots(options.cwd, gitHelperOptions(options.run, options.signal))
  } catch (error) {
    return { kind: 'unavailable', reason: 'no-git', detail: describeError(error) }
  }
  if (roots === null) {
    return {
      kind: 'unavailable',
      reason: 'no-git',
      detail: `no git worktree could be resolved from ${options.cwd}`,
    }
  }
  const [root, checkoutRoot] = await Promise.all([
    canonicalizeTargetPath(roots.root),
    canonicalizeTargetPath(roots.checkoutRoot),
  ])
  const store: WorkspaceStore = {
    root,
    checkoutRoot,
    file: path.join(root, WORKSPACE_DIRECTORY, MEMORY_FILE_NAME),
    gitignore: path.join(root, '.gitignore'),
    worktree: roots.worktree,
  }
  const tracked = await listTrackedFiles(
    root,
    WORKSPACE_DIRECTORY,
    gitHelperOptions(options.run, options.signal),
  )
  if (tracked.length > 0) {
    return {
      kind: 'unavailable',
      reason: 'tracked',
      detail: `git already tracks ${String(tracked.length)} file(s) under ${WORKSPACE_DIRECTORY}, and an ignore rule cannot apply to a tracked path`,
    }
  }
  const ignored = await checkIgnored(
    root,
    WORKSPACE_RELATIVE_FILE,
    gitHelperOptions(options.run, options.signal),
  )
  return { kind: 'ready', store, ignored: ignored.ignored }
}

/**
 * Whether `<root>/.dsh/wiki.yml` asks for the project wiki to be tracked
 * (DESIGN §5.1, §6.3). Only `commit: true` is read; a missing file, an
 * unreadable file, and every other value mean "not committed".
 * @param checkoutRoot - the worktree whose `.dsh/wiki.yml` §6.3 defines.
 * @returns true when the wiki is committed.
 */
export async function isWikiCommitted(checkoutRoot: string): Promise<boolean> {
  try {
    const content = await readFile(path.join(checkoutRoot, '.dsh', 'wiki.yml'), 'utf8')
    return /^\s*commit\s*:\s*true\s*(?:#.*)?$/mu.test(content)
  } catch {
    return false
  }
}

/**
 * Decide the managed block's lines for one repository: `.dsh/*` and
 * `!.dsh/wiki.yml` always, `!.dsh/wiki/` when the wiki is committed, and
 * `!.dsh/skills/` when tracked skill files exist (DESIGN §5.1 中身).
 *
 * `wikiCommitted` is read from the main root's and the current worktree's
 * `wiki.yml`, so a wiki started in a linked worktree still un-ignores its own
 * directory in the shared `.gitignore`.
 * @param store - the resolved store, for the roots and the git seam.
 * @param run - optional command runner.
 * @param signal - cancellation.
 * @returns the block's inner lines.
 */
export async function gitignoreLinesFor(
  store: WorkspaceStore,
  run?: GitRunner,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const [mainWiki, checkoutWiki, skills] = await Promise.all([
    isWikiCommitted(store.root),
    store.checkoutRoot === store.root ? Promise.resolve(false) : isWikiCommitted(store.checkoutRoot),
    listTrackedFiles(store.root, path.join('.dsh', 'skills'), gitHelperOptions(run, signal)),
  ])
  return expectedGitignoreLines({
    wikiCommitted: mainWiki || checkoutWiki,
    skillsTracked: skills.length > 0,
  })
}

/**
 * The block a person can paste when the plugin cannot write it.
 * @param lines - the `.gitignore` lines the workspace needs.
 * @returns one sentence introducing the block, then the managed block holding
 * those lines.
 */
export function handWrittenBlock(lines: readonly string[]): string {
  return `Add this block to .gitignore by hand:\n${renderGitignoreBlock(lines)}`.trimEnd()
}

/**
 * The refusal one unusable workspace maps to (DESIGN §5.1).
 *
 * It is a function because two callers need the same mapping: the write path
 * ({@link ensureWorkspaceWritable}) and the staging path, which must refuse a
 * repository that could never be written rather than record an operation that
 * can never be approved.
 * @param reason - why the workspace is unavailable.
 * @param detail - the inspection's own explanation.
 * @returns the error to throw.
 */
export function workspaceUnavailableError(
  reason: WorkspaceUnavailableReason,
  detail: string,
): MemoryError {
  switch (reason) {
    case 'disabled':
    case 'no-git':
      return memoryError(
        'MEMORY_NO_WORKSPACE',
        `${detail}; the workspace store needs a git worktree`,
      )
    case 'tracked':
      return memoryError(
        'MEMORY_TRACKED',
        `${detail}. Run \`git rm --cached -r ${WORKSPACE_DIRECTORY}\` first; the content already committed stays in the repository history`,
      )
  }
}

/** Map a knowledge-common `.gitignore` failure onto the documented code. */
function mapGitignoreFailure(error: unknown, lines: readonly string[]): never {
  if (error instanceof GitignoreEditError) {
    if (error.code === 'GITIGNORE_MALFORMED' || error.code === 'GITIGNORE_CONFLICT') {
      throw memoryError('MEMORY_GITIGNORE_CONFLICT', `${error.message}; the workspace store is disabled`)
    }
    throw memoryError('MEMORY_NO_IGNORE_RULE', `${error.message}. ${handWrittenBlock(lines)}`)
  }
  throw error
}

/** Inputs for {@link ensureWorkspaceWritable}. */
export interface EnsureWritableOptions {
  /** `withFileLock` and `writeFileAtomic` from `@deepseek-ai/dsh-atomic-write`. */
  readonly api: AtomicWriteApi
  /** `workspace.manageGitignore`. */
  readonly manageGitignore: boolean
  /** Writer-lock budget for the `.gitignore` edit. */
  readonly lockWaitMs: number
  /** Command runner; defaults to `node:child_process`. */
  readonly run?: GitRunner
  /** Cancellation. */
  readonly signal?: AbortSignal
}

/** One accepted workspace inspection: the store, and whether git ignores it. */
export type ReadyWorkspace = Extract<WorkspaceInspection, { readonly kind: 'ready' }>

/** What one managed-block comparison did (DESIGN §5.1, `/memory gitignore`). */
export interface GitignoreSyncResult {
  /** Whether the block was written, i.e. created or replaced. */
  readonly edited: boolean
  /** Whether the write created the block, rather than replacing an existing one. */
  readonly created: boolean
  /** The lines the block must hold right now. */
  readonly lines: readonly string[]
  /** Why nothing was written, or `null` when the block was brought up to date. */
  readonly skipped: string | null
}

/**
 * Bring the managed block up to date (DESIGN §5.1, N1).
 *
 * The comparison is the same one the write path makes: the block is created
 * when the store path is not ignored, maintained when the markers are present,
 * and left alone when another rule already ignores the path and the plugin
 * never wrote a block there (U3). The `check-ignore` re-run after a write is
 * part of the function, because a later negation line can still defeat the
 * block.
 * @param inspection - a `ready` inspection of the session's workspace.
 * @param options - atomic-write seam, the manage switch, and cancellation.
 * @returns whether anything was written, and the lines that were expected.
 * @throws MemoryError `MEMORY_NO_IGNORE_RULE`, `MEMORY_GITIGNORE_CONFLICT`, or
 * `MEMORY_LOCK_TIMEOUT`.
 */
export async function syncGitignoreBlock(
  inspection: ReadyWorkspace,
  options: EnsureWritableOptions,
): Promise<GitignoreSyncResult> {
  const { store, ignored } = inspection
  if (options.manageGitignore) {
    const { mustEdit } = await managedBlockState(store, ignored)
    if (!mustEdit) {
      return {
        edited: false,
        created: false,
        lines: [],
        skipped:
          'another rule already ignores the store and this plugin has no block here, so nothing was written',
      }
    }
    const lines = await gitignoreLinesFor(store, options.run, options.signal)
    try {
      const result = await ensureGitignoreBlock(options.api, {
        root: store.root,
        lines,
        lockWaitMs: options.lockWaitMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      const recheck = await checkIgnored(
        store.root,
        WORKSPACE_RELATIVE_FILE,
        gitHelperOptions(options.run, options.signal),
      )
      if (!recheck.ignored) {
        throw memoryError(
          'MEMORY_NO_IGNORE_RULE',
          `${store.gitignore} was updated but git still reports ${WORKSPACE_RELATIVE_FILE} as not ignored. ${handWrittenBlock(lines)}`,
        )
      }
      return { edited: result.changed, created: result.created, lines, skipped: null }
    } catch (error) {
      mapGitignoreFailure(error, lines)
    }
  }
  const lines = await gitignoreLinesFor(store, options.run, options.signal)
  if (ignored) {
    return {
      edited: false,
      created: false,
      lines,
      skipped: 'workspace.manageGitignore is false, so the block is never written',
    }
  }
  throw memoryError(
    'MEMORY_NO_IGNORE_RULE',
    `workspace.manageGitignore is false and ${WORKSPACE_RELATIVE_FILE} is not ignored. ${handWrittenBlock(lines)}`,
  )
}

/**
 * Turn an inspection into a store that may be written, adding the managed
 * block when the rule is missing (DESIGN §5.1, U3: the first write is the
 * moment the block appears).
 *
 * The block is written **before** the memory file, and `check-ignore` runs
 * again afterwards: a later negation line in the same file can still defeat the
 * rule, and then nothing may be written.
 * @param inspection - the result of {@link inspectWorkspace}.
 * @param options - atomic-write seam, the manage switch, and cancellation.
 * @returns the store to write.
 * @throws MemoryError `MEMORY_NO_WORKSPACE`, `MEMORY_TRACKED`,
 * `MEMORY_GITIGNORE_CONFLICT`, `MEMORY_NO_IGNORE_RULE`, or `MEMORY_LOCK_TIMEOUT`.
 */
export async function ensureWorkspaceWritable(
  inspection: WorkspaceInspection,
  options: EnsureWritableOptions,
): Promise<WorkspaceStore> {
  if (inspection.kind === 'unavailable') {
    throw workspaceUnavailableError(inspection.reason, inspection.detail)
  }
  const { store } = inspection
  await syncGitignoreBlock(inspection, options)
  return store
}

/**
 * Whether the managed block must be (re)written before a store write.
 *
 * - the path is not ignored → the block has to exist, so yes;
 * - the markers are present but unusable → yes, so the edit attempt reports
 *   `MEMORY_GITIGNORE_CONFLICT` instead of silently accepting a broken block;
 * - the block is present and the path is ignored by another rule → yes, to keep
 *   the block's conditional lines current;
 * - no markers and another rule already ignores the path → no: the plugin does
 *   not add its block to a repository that never needed it (DESIGN §5.1, U3).
 * @param store - the resolved store.
 * @param ignored - whether git already reports the store path as ignored.
 * @returns whether {@link ensureGitignoreBlock} should run.
 */
async function managedBlockState(
  store: WorkspaceStore,
  ignored: boolean,
): Promise<{ mustEdit: boolean }> {
  try {
    const current = await readTextFileIfExists(store.gitignore)
    const layout = inspectGitignoreBlock(current ?? '')
    return { mustEdit: !ignored || layout.kind !== 'absent' }
  } catch {
    // Unreadable: let the edit attempt report the real failure.
    return { mustEdit: true }
  }
}
