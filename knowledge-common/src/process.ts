/**
 * The git subprocess seam.
 *
 * DSH has a subprocess *service* (`@deepseek-ai/dsh-subprocess`), but it is a
 * Cordis `Service` reached through `ctx.subprocess`, and this module is a plain
 * library that runs before any plugin context exists and must work in unit
 * tests without a host. So the default runner is a thin `node:child_process`
 * wrapper — argv array, no shell, so no argument can be reinterpreted — and the
 * runner is injectable for a consumer that owns a `ctx.subprocess`.
 *
 * A failure to spawn (`git` missing, timeout, abort) is reported as an ordinary
 * non-zero {@link GitRunResult}, which is what "git が失敗した場合" means for
 * DESIGN §5.1: the workspace store goes away. Only cancellation is propagated as
 * a rejection, because a cancelled caller must not read "no repository".
 * @module knowledge-common/process
 */

import { execFile } from 'node:child_process'

/** The facts of one finished command. */
export interface GitRunResult {
  /** Exit status; 0 is success. */
  readonly code: number
  /** Captured standard output. */
  readonly stdout: string
  /** Captured standard error, or the spawn failure's message. */
  readonly stderr: string
}

/** Where and under whose cancellation one command runs. */
export interface GitRunOptions {
  /** Working directory the command runs in. */
  readonly cwd: string
  /** Cancels the command; cancellation rejects rather than returning a status. */
  readonly signal?: AbortSignal
}

/**
 * Run one git command. Implementations never throw for a git failure — only for
 * cancellation — so callers read {@link GitRunResult.code}.
 */
export type GitRunner = (args: readonly string[], options: GitRunOptions) => Promise<GitRunResult>

/** Tuning for the default `node:child_process` runner. */
export interface NodeGitRunnerOptions {
  /** Executable to run; defaults to `git` from `PATH`. */
  readonly gitPath?: string
  /** Kill the command after this many milliseconds; defaults to 10 s. */
  readonly timeoutMs?: number
  /** Maximum captured bytes per stream; defaults to 8 MiB. */
  readonly maxBufferBytes?: number
  /** Environment for the child; defaults to the parent environment. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** Default command budget: long enough for a large `ls-files`, short enough to notice. */
export const DEFAULT_GIT_TIMEOUT_MS = 10_000

/** `code` reported when the command never ran or was killed. */
export const GIT_SPAWN_FAILURE_CODE = -1

/** Whether an `execFile` failure is cancellation rather than a command failure. */
function isAbortError(error: unknown): boolean {
  const name = (error as { name?: unknown }).name
  const code = (error as { code?: unknown }).code
  return name === 'AbortError' || code === 'ABORT_ERR'
}

/**
 * Build the default runner over `node:child_process.execFile`.
 * @param options - executable path, budget, and environment overrides.
 * @returns a runner that reports git failures as statuses.
 */
export function createNodeGitRunner(options: NodeGitRunnerOptions = {}): GitRunner {
  const gitPath = options.gitPath ?? 'git'
  const timeout = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  const maxBuffer = options.maxBufferBytes ?? 8 * 1024 * 1024
  const env = options.env === undefined ? process.env : { ...options.env }
  return async (args, run): Promise<GitRunResult> =>
    await new Promise<GitRunResult>((resolve, reject) => {
      execFile(
        gitPath,
        [...args],
        { cwd: run.cwd, timeout, maxBuffer, windowsHide: true, encoding: 'utf8', signal: run.signal, env },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ code: 0, stdout, stderr })
            return
          }
          if (isAbortError(error)) {
            // `execFile` reports cancellation as an `AbortError` instance; keep it
            // so the caller reads the same `name` the signal carried.
            const cancellation: Error = error
            reject(cancellation)
            return
          }
          const raw = (error as { code?: unknown }).code
          const code = typeof raw === 'number' ? raw : GIT_SPAWN_FAILURE_CODE
          resolve({ code, stdout, stderr: stderr === '' ? error.message : stderr })
        },
      )
    })
}
