/**
 * Git helpers for the workspace store and the wiki (DESIGN §5.1, §6.2, §6.4):
 * the checkout root, the main-worktree root, the ignore check, and the tracked
 * file list. Every function takes an optional {@link GitRunner}, so a consumer
 * with a `ctx.subprocess` can supply its own and the unit tests can use the
 * default one against a throwaway repository.
 * @module knowledge-common/git
 */

import path from 'node:path'
import { createNodeGitRunner, type GitRunner, type GitRunOptions } from './process.ts'

/** The roots of one repository, as DESIGN §5.1 defines them. */
export interface GitRoots {
  /**
   * The root of the worktree the caller is in (`rev-parse --show-toplevel`).
   * The wiki uses this one, because a committed wiki is per branch (DESIGN §6.2).
   */
  readonly checkoutRoot: string
  /**
   * The main worktree's root: `checkoutRoot` itself, or the parent of the shared
   * git directory when the caller is in a linked worktree (DESIGN §5.1, Q8).
   * The workspace memory store uses this one, so a worktree does not split it.
   */
  readonly root: string
  /** Whether `checkoutRoot` is a linked worktree rather than the main checkout. */
  readonly worktree: boolean
}

/** How a git helper runs its commands. */
export interface GitHelperOptions {
  /** Command runner; defaults to {@link createNodeGitRunner}. */
  readonly run?: GitRunner
  /** Cancels the commands. */
  readonly signal?: AbortSignal
}

/** The result of one `check-ignore` question. */
export interface IgnoreCheck {
  /** True when git reports the path as ignored (exit status 0). */
  readonly ignored: boolean
  /** The exit status: 0 ignored, 1 not ignored, anything else a git failure. */
  readonly code: number
}

/**
 * Project one caller's git seam arguments into {@link GitHelperOptions},
 * omitting what it did not supply.
 * @param run - the caller's git runner, when it supplies one.
 * @param signal - the caller's cancellation, when it supplies one.
 * @returns the helper options, with absent fields left absent.
 */
export function gitHelperOptions(run?: GitRunner, signal?: AbortSignal): GitHelperOptions {
  return {
    ...(run === undefined ? {} : { run }),
    ...(signal === undefined ? {} : { signal }),
  }
}

/** The runner a helper uses when the caller supplies none. */
const defaultRunner: GitRunner = createNodeGitRunner()

/** Build the run options for one command. */
function optionsFor(cwd: string, signal: AbortSignal | undefined): GitRunOptions {
  return signal === undefined ? { cwd } : { cwd, signal }
}

/**
 * Resolve the repository roots of `cwd` (DESIGN §5.1).
 *
 * `null` means the workspace store is off: not a repository, a bare repository,
 * or git failed. The `--git-common-dir` answer is used only when it ends in
 * `.git`, which is how a linked worktree is folded onto the main checkout;
 * anything else (a `--separate-git-dir` layout, or a git too old for
 * `--path-format`) keeps the checkout root.
 * @param cwd - the directory to resolve from, normally `header.cwd`.
 * @param options - runner and cancellation.
 * @returns the roots, or `null` when there is no usable worktree.
 */
export async function resolveGitRoots(
  cwd: string,
  options: GitHelperOptions = {},
): Promise<GitRoots | null> {
  const run = options.run ?? defaultRunner
  const top = await run(['rev-parse', '--show-toplevel'], optionsFor(cwd, options.signal))
  if (top.code !== 0) return null
  const checkoutRoot = top.stdout.trim()
  if (checkoutRoot === '') return null
  const bare = await run(['rev-parse', '--is-bare-repository'], optionsFor(cwd, options.signal))
  if (bare.code === 0 && bare.stdout.trim() === 'true') return null
  const common = await run(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    optionsFor(cwd, options.signal),
  )
  let root = checkoutRoot
  if (common.code === 0) {
    const commonDir = common.stdout.trim().replace(/[/\\]+$/u, '')
    // `--path-format=absolute` makes this an absolute directory, so its parent
    // exists and is distinct from it whenever the answer ends in `.git`.
    if (commonDir.endsWith('.git')) root = path.dirname(commonDir)
  }
  const resolvedCheckout = path.resolve(checkoutRoot)
  const resolvedRoot = path.resolve(root)
  return { checkoutRoot: resolvedCheckout, root: resolvedRoot, worktree: resolvedRoot !== resolvedCheckout }
}

/**
 * Ask git whether one repository-relative path is ignored (DESIGN §5.1,
 * condition 2). The rule may come from any `.gitignore`, `info/exclude`, or the
 * user's global configuration; only the answer matters.
 * @param root - the working directory to ask from.
 * @param relativePath - a path relative to `root`.
 * @param options - runner and cancellation.
 * @returns whether it is ignored, and the exit status behind that answer.
 */
export async function checkIgnored(
  root: string,
  relativePath: string,
  options: GitHelperOptions = {},
): Promise<IgnoreCheck> {
  const run = options.run ?? defaultRunner
  const result = await run(['check-ignore', '-q', '--', relativePath], optionsFor(root, options.signal))
  return { ignored: result.code === 0, code: result.code }
}

/**
 * List the files git tracks under one path (DESIGN §5.1, condition 3). The
 * caller only asks whether the list is empty; the paths are returned
 * repository-relative, separated by `-z` so an unusual name cannot be split.
 * @param root - the working directory to ask from.
 * @param pathspec - a repository-relative path or pathspec; omitted lists everything.
 * @param options - runner and cancellation.
 * @returns the tracked paths, in git's order.
 */
export async function listTrackedFiles(
  root: string,
  pathspec?: string,
  options: GitHelperOptions = {},
): Promise<readonly string[]> {
  const run = options.run ?? defaultRunner
  const args = pathspec === undefined ? ['ls-files', '-z'] : ['ls-files', '-z', '--', pathspec]
  const result = await run(args, optionsFor(root, options.signal))
  if (result.code !== 0) return []
  return result.stdout.split('\0').filter(entry => entry !== '')
}
