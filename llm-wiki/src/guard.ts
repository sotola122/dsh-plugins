/**
 * The wiki's `write`/`edit` protection: the project wiki's `raw/`, and the
 * whole global wiki (DESIGN §6.6, §6.4, §5.2).
 *
 * **Where this sits.** `tools/pre-execute` runs for every tool call, and the
 * policy here looks at the path only when the tool is `write` or `edit`
 * (`$P/dsh-tool-fs/lib/index.js:549,690`). `read` carries a `file_path` too and
 * is deliberately **not** stopped (第六次改訂: パス判定は変更系のツールだけに
 * 掛ける), because reading a source is how the wiki is used.
 *
 * **What it protects.**
 *
 * - project wiki `raw/`: editing an **existing** source
 *   (`WIKI_RAW_IMMUTABLE`); creating a new dated source stays the normal
 *   ingest path.
 * - the global wiki: every `write`/`edit` below the accepted repository
 *   (`WIKI_READ_ONLY`). The global wiki is written with `wiki_write` alone, so
 *   its path rules, raw immutability, size caps, scan, and approval cannot be
 *   bypassed.
 *
 * The second item is §6.4 check 6: the deny is armed only on the path the checks
 * accepted, and a session whose cwd overlaps the repository has the global wiki
 * disabled, so nothing is denied there. The check is §5.2's realpath
 * containment, so `..` and a symlinked parent cannot smuggle a path past it.
 * The remaining race — a path component replaced between this check and the
 * rename — is the acknowledged limit of §5.2 and §6.4.
 *
 * **What it is not.** `bash` can still write either tree; this is a policy for
 * the model's ordinary tools, not a sandbox. Nothing here reads the file's
 * content, so the guard is cheap and cannot fail on a binary file.
 * @module @anago-harness/llm-wiki/guard
 */

import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { canonicalizeTargetPath, isPathWithin, resolveContainedTarget } from '@anago-harness/knowledge-common'
import { cwdOf, type WikiAgent } from './agents.ts'
import { wikiError } from './errors.ts'
import type { GlobalWikiState } from './global.ts'
import { inspectWiki } from './inspect.ts'
import { WIKI_DIRECTORY } from './paths.ts'

/** The tools whose paths this policy inspects (DESIGN §6.6). */
export const GUARDED_TOOLS: readonly string[] = ['write', 'edit']

/**
 * The argument field a mutating filesystem tool carries its path in
 * (`$P/dsh-tool-fs/lib/index.js:552,692`).
 */
export const PATH_ARGUMENT = 'file_path'

/** Everything {@link classifyGuardedPath} needs beyond the path itself. */
export interface GuardDeps {
  /**
   * The session's working directory (`header.cwd`): the checkout root is
   * resolved from here, and it decides which `raw/` belongs to this session.
   */
  readonly cwd?: string
  /**
   * Base for a **relative** tool path. The filesystem tools resolve one
   * against the session's current working directory, which is what
   * `ctx.workingDirectory` returns; {@link guardDecision} passes that directory
   * here and uses the process directory only when the service is absent. It is
   * a parameter so the classification can be staged independently in a test.
   */
  readonly pathBase?: string
  /** Cancellation. */
  readonly signal?: AbortSignal
}

/** Where a guarded path landed. */
export type GuardTarget =
  /** The path is outside this session's project wiki. */
  | { readonly kind: 'outside' }
  /** The path is inside `raw/` but does not exist yet: a new source may be written. */
  | { readonly kind: 'raw-new'; readonly file: string; readonly wikiRoot: string }
  /** The path is an existing file under `raw/` (DESIGN §6.6). */
  | { readonly kind: 'raw-existing'; readonly file: string; readonly wikiRoot: string }

/**
 * Classify one `write`/`edit` path against the project wiki's `raw/`.
 *
 * `cwd` is the session's working directory, so the guard sees exactly the wiki
 * the session would write: a session started in a subdirectory resolves the
 * same checkout root (DESIGN §6.2) and protects the same `raw/`. A relative
 * tool path is resolved against `deps.pathBase`, which {@link guardDecision}
 * takes from the session's current working directory; without that service the
 * filesystem provider's own fallback, the process directory, is used.
 * @param target - the path the tool was given, relative or absolute.
 * @param deps - the session's cwd, the relative-path base, and cancellation.
 * @returns where the path landed.
 */
export async function classifyGuardedPath(
  target: string,
  deps: GuardDeps = {},
): Promise<GuardTarget> {
  if (deps.cwd === undefined) return { kind: 'outside' }
  let inspection
  try {
    inspection = await inspectWiki({
      cwd: deps.cwd,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    })
  } catch {
    // An unresolvable repository means there is no wiki to protect, and a
    // policy must not turn a tool call into a failure.
    return { kind: 'outside' }
  }
  if (inspection.kind !== 'found') return { kind: 'outside' }
  const wikiRoot = inspection.root.wikiRoot
  const raw = path.join(wikiRoot, 'raw')
  const absolute = path.resolve(deps.pathBase ?? process.cwd(), target)
  // `raw/` itself is the one path in the wiki that is outside this rule: it is
  // a directory, not a source file. The leaf is compared **before** the parent
  // so a direct child — whose parent *is* `raw/` — is not mistaken for the
  // directory and allowed through.
  const [canonicalRaw, canonicalTarget] = await Promise.all([
    canonicalizeTargetPath(raw),
    canonicalizeTargetPath(absolute, deps.pathBase),
  ])
  if (canonicalTarget === canonicalRaw) return { kind: 'outside' }
  // The **parent** is what has to be contained, and it is canonicalized the
  // §5.2 way (the deepest existing ancestor is realpath'd). Judging the leaf
  // too would resolve a symlink away: a write through `raw/escape.md` would
  // then be allowed to replace whatever it points at, when it is the link
  // itself that lives under the immutable directory.
  const containedParent = await resolveContainedTarget(raw, path.dirname(absolute), deps.pathBase)
  if (containedParent === null) return { kind: 'outside' }
  const named = path.join(containedParent, path.basename(absolute))
  let info
  try {
    info = await stat(named)
  } catch {
    return { kind: 'raw-new', file: named, wikiRoot }
  }
  if (!info.isFile()) return { kind: 'outside' }
  return { kind: 'raw-existing', file: named, wikiRoot }
}

/**
 * Whether one `write`/`edit` path lands inside the accepted global wiki
 * (DESIGN §6.4 check 6).
 *
 * The repository is only protected while the global wiki is enabled for this
 * session: the caller passes the resolved view, so an overlap with `header.cwd`
 * silently disarms the deny rather than locking the user out of their own
 * project. The containment question is the same §5.2 predicate the raw guard
 * uses, and the leaf may not exist yet, so the parent is what is judged.
 * @param target - the path the tool was given.
 * @param repoRoot - the canonical repository top.
 * @param pathBase - base for a relative path.
 * @returns true when the path is inside the global wiki and must be refused.
 */
export async function isInsideGlobalWiki(
  target: string,
  repoRoot: string,
  pathBase?: string,
): Promise<boolean> {
  const absolute = path.resolve(pathBase ?? process.cwd(), target)
  const [canonicalFile, canonicalRepo] = await Promise.all([
    canonicalizeTargetPath(absolute, pathBase),
    canonicalizeTargetPath(repoRoot),
  ])
  if (!isPathWithin(canonicalRepo, canonicalFile)) return false
  // `write`/`edit` may create the file; the parent must be inside as well, so a
  // symlinked leaf cannot point the write at a file elsewhere.
  const canonicalParent = await canonicalizeTargetPath(path.dirname(absolute), pathBase)
  return isPathWithin(canonicalRepo, canonicalParent)
}

/**
 * The refusal text for one existing raw source (DESIGN §6.6).
 * @param file - the absolute path that was refused.
 * @param wikiRoot - the wiki root, for the display path.
 * @returns the deny reason, starting with the stable code.
 */
export function rawImmutableReason(file: string, wikiRoot: string): string {
  const relative = path.relative(wikiRoot, file).split(path.sep).join('/')
  return wikiError(
    'WIKI_RAW_IMMUTABLE',
    `${WIKI_DIRECTORY}/${relative} already exists and raw/ sources are immutable. Keep the source as it is and record a new one (raw/<topic>/<YYYY-MM-DD>-<source>.md), then point the pages at the new file`,
  ).message
}

/**
 * The refusal text for a `write`/`edit` inside the global wiki (DESIGN §6.4).
 * @param file - the absolute path that was refused.
 * @param repoRoot - the repository top, for the display path.
 * @returns the deny reason, starting with the stable code.
 */
export function globalWikiReason(file: string, repoRoot: string): string {
  const relative = path.relative(repoRoot, file).split(path.sep).join('/')
  return wikiError(
    'WIKI_READ_ONLY',
    `the global LLM wiki at ${repoRoot} is written with the wiki_write tool only, so ${relative} cannot be changed with write/edit. Use wiki_write, which keeps raw/ immutable, applies the size caps and the injection scan, and asks for approval when the configuration says so`,
  ).message
}

/**
 * The part of `ctx.workingDirectory` this policy uses.
 *
 * It is declared structurally so a unit test can supply a fake and so the
 * plugin does not import the service package for a type it only reads.
 */
export interface WorkingDirectoryLike {
  /**
   * The session's current directory, validated and restored when it vanished.
   * @param agent - the calling agent.
   * @param signal - cancellation for the filesystem inspection.
   * @returns the absolute current directory.
   */
  ensure(agent: unknown, signal?: AbortSignal): Promise<string>
}

/** Everything {@link guardDecision} needs beyond the call itself. */
export interface GuardDecisionDeps {
  /**
   * The global wiki's state; omitted means "no global wiki in this deployment",
   * which is what a unit test of the raw guard alone wants.
   */
  readonly global?: GlobalWikiState
  /**
   * The working-directory service (`ctx.workingDirectory`), resolved per call:
   * a deployment may not have it, and the service may be registered after this
   * plugin.
   */
  readonly workingDirectory?: (() => WorkingDirectoryLike | undefined) | undefined
}

/**
 * The `tools/pre-execute` policy (DESIGN §6.4, §6.6).
 *
 * It never throws: a failure while resolving a wiki is treated as "nothing to
 * protect", because a policy error would fail the tool call for the wrong
 * reason. Everything that is not `write`/`edit`, or carries no path, falls
 * straight through to `next()` without touching the filesystem.
 *
 * A relative path is resolved against the session's current directory from
 * `ctx.workingDirectory`, which is the same directory the filesystem tools
 * resolve against; the process directory is the fallback only when the service
 * is absent. An absolute path needs no lookup. If the service cannot resolve
 * the directory, the filesystem tool is about to fail the call for the same
 * reason, so the policy delegates.
 *
 * The global check runs before `next()` and denies outright; every other path
 * delegates. Only one listener of this plugin denies, so a downstream `allow`
 * is never swallowed by a later stage of its own chain.
 * @param exec - the call about to run.
 * @param next - the rest of the policy chain.
 * @param deps - the global wiki's state and the working-directory service.
 * @returns the decision: `deny` for a protected path, otherwise the chain's answer.
 */
export async function guardDecision(
  exec: {
    readonly name: string
    readonly arguments: unknown
    readonly agent?: unknown
    readonly signal?: AbortSignal
  },
  next: () => Promise<PreToolDecision>,
  deps: GuardDecisionDeps = {},
): Promise<PreToolDecision> {
  if (!GUARDED_TOOLS.includes(exec.name)) return await next()
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return await next()
  const raw = (args as Record<string, unknown>)[PATH_ARGUMENT]
  if (typeof raw !== 'string' || raw.trim() === '') return await next()
  const agent = exec.agent as WikiAgent | undefined
  const cwd = agent === undefined ? undefined : cwdOf(agent)
  if (cwd === undefined) return await next()
  let pathBase = process.cwd()
  if (!path.isAbsolute(raw)) {
    const workingDirectory = deps.workingDirectory?.()
    if (agent !== undefined && workingDirectory !== undefined) {
      try {
        pathBase = await workingDirectory.ensure(agent, exec.signal)
      } catch {
        // The filesystem tool resolves the same directory before it writes, so
        // the call fails on its own; the policy adds no second failure.
        return await next()
      }
    }
  }
  if (deps.global !== undefined) {
    try {
      const view = await deps.global.forAgent(agent)
      if (view.kind === 'found') {
        const absolute = path.resolve(pathBase, raw)
        if (await isInsideGlobalWiki(raw, view.repo.repoRoot, pathBase)) {
          return { kind: 'deny', reason: globalWikiReason(absolute, view.repo.repoRoot) }
        }
      }
    } catch {
      // A policy must not fail the call; the tool body and the transcript still
      // show what happened.
    }
  }
  try {
    const target = await classifyGuardedPath(raw, { cwd, pathBase })
    if (target.kind !== 'raw-existing') return await next()
    return { kind: 'deny', reason: rawImmutableReason(target.file, target.wikiRoot) }
  } catch {
    return await next()
  }
}
