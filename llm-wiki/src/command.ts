/**
 * `/wiki` — the human side of the wiki plugin (DESIGN §6.6, S20).
 *
 * - `status`: both roots, both page counts, the global charter this repository
 *   uses (`AGENTS.md` or `WIKI.md`), whether this session may write the project
 *   wiki, `commit`, the global `git status` summary, `writeApproval` with the
 *   effective policy, and the warnings.
 * - `lint [links,index,raw]`: the same check `wiki_lint` runs over **both**
 *   wikis, printed for a person; with no names it runs `lint.checks`.
 * - `repo set <path>`: run DESIGN §6.4's checks on a path, create its skeleton,
 *   and record it in the sidecar.
 * - `repo unset`: record `{disabled:true}`; the repository's files are left
 *   exactly as they are.
 * - `commit [message]`: `git add` and `git commit --only` limited to the page
 *   directory, `raw`, `index.md`, and `WIKI.md`; nothing is pushed.
 * - `reindex`: drop both in-process search indexes and build them again now,
 *   reporting what each covers (DESIGN §6.5).
 *
 * Only `repo set` writes anything, and only the sidecar under `$DSH_HOME` plus
 * the repository's skeleton. `commit` runs `git`, which is the one path by
 * which wiki content enters history — and it is a person who runs it (D4).
 * @module @anago-harness/llm-wiki/command
 */

import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createNodeGitRunner, listTrackedFiles, type GitRunner } from '@anago-harness/knowledge-common'
import { cwdOf, type WikiAgent } from './agents.ts'
import { describeWriteApproval, resolveEffectivePolicy, type ApprovalServiceLike } from './approval.ts'
import type { WikiConfig } from './config.ts'
import { describeError } from './errors.ts'
import { describeTruncation, type WikiSearchIndex } from './search.ts'
import {
  findGlobalCharter,
  globalDisabledReason,
  readGitStatus,
  summarizeGitStatus,
  parseGitStatus,
  type GlobalWikiState,
} from './global.ts'
import { inspectWiki, type WikiInspection } from './inspect.ts'
import { countPages, LINT_CHECKS, type LintCheck } from './lint.ts'
import {
  WIKI_CHARTER_FILE,
  WIKI_DIRECTORY,
  WIKI_INDEX_FILE,
  WIKI_PAGES_DIRECTORY,
  WIKI_RAW_DIRECTORY,
  WIKI_SETTINGS_FILE,
  type WikiCharterFile,
} from './paths.ts'
import { renderWikiLintResult, runWikiLint, type WikiToolDeps } from './tool.ts'

/** The subcommands this plugin implements. */
export const WIKI_SUBCOMMANDS = ['status', 'lint', 'repo', 'commit', 'reindex'] as const

/**
 * The four paths `/wiki commit` is allowed to touch (DESIGN §6.4, D4; sixth
 * revision's finding 1). Nothing else in the repository is added, and
 * `git commit --only` keeps whatever else was staged out of the new commit.
 *
 * The page directory is `pages` by default and `config.global.pagesDir`
 * otherwise, so a repository whose pages live under `concepts/` commits them
 * too. `COMMIT_PATHSPECS` is the default value, kept for the callers that name
 * the convention without a configuration.
 * @param pagesDir - the global wiki's page directory name.
 * @returns the four repository-relative pathspecs.
 */
export function commitPathspecs(pagesDir: string = WIKI_PAGES_DIRECTORY): readonly string[] {
  return [WIKI_CHARTER_FILE, WIKI_INDEX_FILE, pagesDir, WIKI_RAW_DIRECTORY]
}

/** The four pathspecs at the default page directory (DESIGN §6.4, D4). */
export const COMMIT_PATHSPECS: readonly string[] = commitPathspecs()

/** The message `/wiki commit` uses when the user gives none. */
export const DEFAULT_COMMIT_MESSAGE = 'Update wiki'

/** The usage block shown for a missing or unknown subcommand. */
export const WIKI_USAGE = [
  'usage: /wiki <subcommand>',
  '  status                 both wiki roots, page counts, write mode, and warnings',
  '  lint [links,index,raw] the same checks wiki_lint runs (both wikis; no names runs lint.checks)',
  '  repo set <path>        designate the global wiki repository (absolute, ~/… accepted)',
  '  repo unset             turn the global wiki off; its files are left in place',
  '  commit [message]       commit the page directory, raw/, index.md, and WIKI.md in the global wiki',
  '  reindex                rebuild both search indexes now (wiki_search builds them on demand)',
].join('\n')

/** Everything the command needs from the plugin. */
export interface WikiCommandDeps {
  /** Resolved plugin configuration. */
  readonly config: WikiConfig
  /** Where recoverable problems go. */
  readonly logger: WikiToolDeps['logger']
  /** The global wiki's state. */
  readonly global: GlobalWikiState
  /** The search index cache: `reindex` clears it, `repo set`/`repo unset` drop one root. */
  readonly search: WikiSearchIndex
  /** Command runner for `/wiki commit` and the global `git status`. */
  readonly run?: GitRunner
  /**
   * The approval service, resolved per call: it may be registered after this
   * plugin, and a deployment may not have it at all.
   */
  readonly approval?: () => ApprovalServiceLike | undefined
  /**
   * Cancellation of the dispatching UI request. `runWikiCommand` fills this
   * from the invocation; `status` only reads, but a git answer or a directory
   * walk still honours the same signal the UI handed the handler.
   */
  readonly signal?: AbortSignal
}

/**
 * Parse the optional check list of `/wiki lint`.
 * @param args - the raw arguments; each comma-separated name is one check.
 * @param configured - the checks used when no argument is given; every check by default.
 * @returns the selected checks in `LINT_CHECKS` order, or the message to report instead.
 */
export function parseLintChecks(
  args: readonly string[],
  configured: readonly LintCheck[] = LINT_CHECKS,
): { checks: LintCheck[] } | { error: string } {
  if (args.length === 0) return { checks: [...configured] }
  const requested = args
    .flatMap(arg => arg.split(','))
    .map(name => name.trim().toLowerCase())
    .filter(name => name !== '')
  if (requested.length === 0) {
    return { error: `no check given — the checks are ${LINT_CHECKS.join(', ')}` }
  }
  const unknown = requested.filter(name => !(LINT_CHECKS as readonly string[]).includes(name))
  if (unknown.length > 0) {
    return {
      error: `unknown check(s): ${unknown.join(', ')} — the checks are ${LINT_CHECKS.join(', ')}`,
    }
  }
  return { checks: LINT_CHECKS.filter(check => requested.includes(check)) }
}

/** One line describing where the project wiki is, or why there is none. */
function describeProjectWiki(inspection: WikiInspection): string {
  if (inspection.kind !== 'found') {
    return `project wiki: none — ${inspection.detail}`
  }
  return `project wiki: ${inspection.root.wikiRoot}`
}

/**
 * The one line `/wiki status` prints for the charter (DESIGN §6.4).
 *
 * The file name is what {@link findGlobalCharter} found, never a default: a
 * repository may use `AGENTS.md` and must not be told to read a `WIKI.md` that
 * was deliberately never created. The hint names `SCHEMA.md` as conditional,
 * because the plugin neither creates nor requires it.
 * @param charter - the recognized file, or `null` when there is none.
 * @returns the line's value, after `charter: `.
 */
function describeCharter(charter: WikiCharterFile | null): string {
  return charter === null
    ? 'none (neither AGENTS.md nor WIKI.md exists)'
    : `${charter} (read it and index.md before writing; read SCHEMA.md too when the repository has one)`
}

/** `/wiki status` (DESIGN §6.6). */
async function runStatus(
  agent: WikiAgent,
  cwd: string,
  deps: WikiCommandDeps,
): Promise<CommandResult> {
  const inspection = await inspectWiki({
    cwd,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  })
  const lines = [describeProjectWiki(inspection)]
  if (inspection.kind === 'found') {
    const pages = await countPages(inspection.root.wikiRoot)
    lines.push(
      `  pages: ${String(pages)}`,
      `  writable: ${inspection.writable ? `yes (the session runs at ${cwd})` : 'no (read-only: the session\'s cwd is below the checkout root, DESIGN §6.2)'}`,
      `  commit: ${inspection.settings.commit ? `true (${WIKI_SETTINGS_FILE} asks for the wiki to be tracked)` : `false (${WIKI_SETTINGS_FILE} does not set commit: true)`}`,
      `  ignore: ${inspection.ignore.state}${inspection.ignore.detail === null ? '' : ` — ${inspection.ignore.detail}`}`,
    )
    for (const warning of inspection.warnings) lines.push(`  warning: ${warning}`)
  }
  // Two views: the repository itself (what is designated, which `/wiki commit`
  // acts on), and this session's view (whether `wiki_write`, the lint's global
  // scope, the notice, and the write/edit deny apply here).
  const repository = await deps.global.resolve()
  const session = await deps.global.forAgent(agent)
  if (repository.kind === 'found') {
    const pagesDir = deps.config.global.pagesDir
    const pages = await countPages(repository.repo.repoRoot, pagesDir).catch(() => 0)
    const charter = await findGlobalCharter(repository.repo.repoRoot)
    const status = await readGitStatus(repository.repo.repoRoot, {
      ...(deps.run === undefined ? {} : { run: deps.run }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    })
    lines.push(
      `global wiki: ${repository.repo.repoRoot}`,
      `  page directory: ${pagesDir}/ (${pagesDir === WIKI_PAGES_DIRECTORY ? 'the default; set global.pagesDir to change it' : 'the Profile global.pagesDir'})`,
      `  pages: ${String(pages)}`,
      `  charter: ${describeCharter(charter)}`,
      session.kind === 'found'
        ? '  enabled here: yes (the session\'s cwd does not overlap the repository)'
        : `  enabled here: no — ${session.detail}`,
      `  source: ${repository.repo.source === 'sidecar' ? `recorded by /wiki repo set in ${deps.global.sidecarFile}` : 'the Profile global.repo value (no sidecar record)'}`,
      `  git status: ${status.summary}${status.detail === null ? '' : ` — ${status.detail}`}`,
      '  commit: a person runs /wiki commit [message]; the plugin never commits on its own and never pushes',
    )
  } else {
    lines.push(
      repository.kind === 'rejected'
        ? `global wiki: none — WIKI_REPO_REJECTED: ${repository.detail}`
        : `global wiki: none — ${repository.detail}`,
    )
  }
  const service = deps.approval?.()
  const approvalSession = (agent as { readonly session?: unknown }).session
  const policy = resolveEffectivePolicy(service, approvalSession)
  lines.push(
    `  ${describeWriteApproval(deps.config.writeApproval, policy)}`,
    `  approval policy now: ${policy}${service === undefined ? ' (no approval service is loaded, so nothing can be asked)' : ''}`,
    '  global writes: wiki_write only (write/edit are refused below the global repository); project pages are written with write/edit while this session is at or above the checkout root',
    '  skill: the wiki convention is registered as a skill',
  )
  return { kind: 'success', text: lines.join('\n') }
}

/** `/wiki lint` (DESIGN §6.6). */
async function runLint(
  args: readonly string[],
  agent: WikiAgent,
  cwd: string,
  deps: WikiCommandDeps,
): Promise<CommandResult> {
  const parsed = parseLintChecks(args, deps.config.lint.checks)
  if ('error' in parsed) return { kind: 'error', text: parsed.error }
  const value = await runWikiLint({
    cwd,
    scope: 'all',
    checks: parsed.checks,
    logger: deps.logger,
    global: deps.global,
    agent,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  })
  return { kind: 'success', text: renderWikiLintResult(value) }
}

/** `/wiki repo set <path>` (DESIGN §6.4). */
async function runRepoSet(
  args: readonly string[],
  agent: WikiAgent,
  deps: WikiCommandDeps,
): Promise<CommandResult> {
  const raw = args.join(' ').trim()
  if (raw === '') {
    return { kind: 'error', text: `repo set needs a path, for example: /wiki repo set ~/wiki\n${WIKI_USAGE}` }
  }
  const cwd = cwdOf(agent)
  // The designation is about to change, so the index of the repository that was
  // designated until now is stale (DESIGN §6.5's rebuild triggers).
  const before = await deps.global.resolve()
  const accepted = await deps.global.designate(raw, {
    ...(cwd === undefined ? {} : { cwd }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  })
  if (accepted.kind === 'rejected') {
    return {
      kind: 'error',
      text: `WIKI_REPO_REJECTED: ${accepted.detail}. The global wiki is unchanged.`,
    }
  }
  deps.search.invalidate(accepted.repo.repoRoot)
  if (before.kind === 'found') deps.search.invalidate(before.repo.repoRoot)
  let pages = 0
  try {
    pages = await countPages(accepted.repo.repoRoot)
  } catch {
    // A freshly designated repository whose pages cannot be counted still gets its summary.
  }
  // `AGENTS.md` is the repository's own file and is never written; `WIKI.md` is
  // reported as created only when this call wrote the template.
  const charterCreated = accepted.skeleton.created.includes(
    path.join(accepted.repo.repoRoot, WIKI_CHARTER_FILE),
  )
  const lines = [
    `global wiki: ${accepted.repo.repoRoot}`,
    `  pages: ${String(pages)}`,
    `  charter: ${accepted.skeleton.charter} (${charterCreated ? 'created from the template' : 'left in place'})`,
    `  recorded in ${accepted.sidecar} (mode 0600), which takes precedence over the Profile's global.repo`,
    accepted.skeleton.initialised
      ? '  git init: ran (the directory was outside every repository); nothing was fetched, committed, or pushed'
      : '  git init: not needed (the directory is already the top of a git repository)',
  ]
  if (accepted.skeleton.created.length === 0) {
    lines.push('  skeleton: already complete')
  } else {
    lines.push(`  skeleton: created ${accepted.skeleton.created.join(', ')}`)
  }
  lines.push(
    '  note: write/edit are now refused below this repository for non-overlapping sessions; write it with wiki_write, or turn it off with /wiki repo unset',
  )
  return { kind: 'success', text: lines.join('\n') }
}

/** `/wiki repo unset` (DESIGN §6.4). */
async function runRepoUnset(deps: WikiCommandDeps): Promise<CommandResult> {
  const { sidecar, was } = await deps.global.disable()
  // The files stay, but nothing may keep serving them: the index for that root
  // is dropped, and the next designation rebuilds it from disk (DESIGN §6.5).
  if (was.kind === 'found') deps.search.invalidate(was.repo.repoRoot)
  const lines = [
    'global wiki: off',
    `  recorded in ${sidecar} as {"disabled":true}; a Profile value for global.repo no longer enables it`,
    was.kind === 'found'
      ? `  the files under ${was.repo.repoRoot} are untouched (nothing was deleted)`
      : '  there was no enabled repository to leave behind',
    '  wiki_write, the global half of wiki_lint, the notice count, and the write/edit deny are all off again',
  ]
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * Combine what a git command said. `git commit` writes its human message
 * ("nothing to commit") to stdout, and the runner folds a spawn failure's
 * message into stderr, so both are read.
 * @param result - the finished command.
 * @returns one line of whatever was reported.
 */
function gitOutput(result: { readonly stdout: string; readonly stderr: string }): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(part => part !== '').join(' ')
}

/** Whether one path exists on disk. */
async function existsOnDisk(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * `/wiki commit [message]` (DESIGN §6.4, D4, sixth revision's finding 1).
 *
 * `git add` and `git commit --only` are both limited to the wiki paths (the
 * configured page directory, `raw`, `index.md`, and `WIKI.md`).
 * They are run as two commands because `--only` needs at least one pathspec git
 * knows about: a path with no known file (an empty page directory, a `WIKI.md`
 * that was deleted) is dropped from that command's pathspec list rather than
 * making git fail with `did not match any file(s) known to git`.
 */
async function runCommit(args: readonly string[], deps: WikiCommandDeps): Promise<CommandResult> {
  // The **repository** view, not the session's: a person who runs `dsh` inside
  // the wiki repository has the global wiki disabled for the model (DESIGN
  // §6.4 check 5) but is exactly the person who wants to commit it.
  const view = await deps.global.resolve()
  if (view.kind !== 'found') return { kind: 'error', text: globalDisabledReason(view) }
  const repo = view.repo.repoRoot
  // The configured page directory, not a hard-coded `pages`: a repository that
  // keeps its pages under `concepts/` must have them committed too.
  const pathspecs = commitPathspecs(deps.config.global.pagesDir)
  const run = deps.run ?? createNodeGitRunner()
  const runOptions = (): { cwd: string; signal?: AbortSignal } => ({
    cwd: repo,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  })
  /** The paths that have at least one file git knows about. */
  const knownPathspecs = async (): Promise<string[]> => {
    const known: string[] = []
    for (const pathspec of pathspecs) {
      const files = await listTrackedFiles(repo, pathspec, {
        ...(deps.run === undefined ? {} : { run: deps.run }),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      })
      if (files.length > 0) known.push(pathspec)
    }
    return known
  }
  const known = await knownPathspecs()
  const addable: string[] = []
  for (const pathspec of pathspecs) {
    if (known.includes(pathspec) || (await existsOnDisk(path.join(repo, pathspec)))) {
      addable.push(pathspec)
    }
  }
  if (addable.length === 0) {
    return {
      kind: 'error',
      text: `nothing to commit: none of ${pathspecs.join(', ')} exists in ${repo}`,
    }
  }
  const added = await run(['add', '--', ...addable], runOptions())
  if (added.code !== 0) {
    return {
      kind: 'error',
      text: `git add failed (exit ${String(added.code)}): ${gitOutput(added)}`,
    }
  }
  // Re-read after the add: a file that was untracked a moment ago is known now.
  const commitPaths = await knownPathspecs()
  if (commitPaths.length === 0) {
    return { kind: 'error', text: `nothing to commit: no file under ${pathspecs.join(', ')} is known to git in ${repo}` }
  }
  const message = args.join(' ').trim() === '' ? DEFAULT_COMMIT_MESSAGE : args.join(' ').trim()
  const committed = await run(
    ['commit', '--only', '-m', message, '--', ...commitPaths],
    runOptions(),
  )
  if (committed.code !== 0) {
    return {
      kind: 'error',
      text: `git commit failed (exit ${String(committed.code)}): ${gitOutput(committed)}`,
    }
  }
  const head = await run(['log', '-1', '--format=%h %s'], runOptions())
  const status = await run(['status', '--porcelain=v1', '-z'], runOptions())
  const legs = [
    `committed ${head.code === 0 ? head.stdout.trim() : message} in ${repo}`,
    `  paths: ${commitPaths.join(', ')} (git commit --only; other staged files are not included)`,
  ]
  if (status.code === 0) {
    const remaining = summarizeGitStatus(parseGitStatus(status.stdout))
    legs.push(
      remaining === 'clean'
        ? '  working tree now clean'
        : `  still uncommitted (unchanged by this commit): ${remaining}`,
    )
  }
  legs.push('  nothing was pushed')
  return { kind: 'success', text: legs.join('\n') }
}

/**
 * `/wiki reindex` (DESIGN §6.5, §6.6).
 *
 * Both in-process indexes are dropped and built again now, so the next search
 * does not pay for the build and a person can see what the index actually
 * covers. Building is the same `ensure` the tool uses, which keeps the two
 * paths from drifting; the files on disk are only read.
 */
async function runReindex(cwd: string | undefined, deps: WikiCommandDeps): Promise<CommandResult> {
  deps.search.invalidate()
  const lines: string[] = []
  const report = async (
    scope: 'project' | 'global',
    label: string,
    root: string,
    displayPrefix: string,
  ): Promise<void> => {
    const started = Date.now()
    await deps.search.ensure(scope, root, displayPrefix, {
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    })
    const elapsed = Date.now() - started
    const state = deps.search.state(root)
    lines.push(
      `${label}: ${String(state?.pageCount ?? 0)} page(s) indexed in ${String(elapsed)} ms, ${String(state?.postingBytes ?? 0)} posting bytes`,
    )
    if (state?.truncated === true) lines.push(`  ${describeTruncation(state)}`)
  }
  if (cwd === undefined) {
    lines.push('project wiki: skipped — the session recorded no working directory')
  } else {
    const inspection = await inspectWiki({
      cwd,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    })
    if (inspection.kind !== 'found') {
      lines.push(`project wiki: none — ${inspection.detail}`)
    } else {
      await report('project', `project wiki (${inspection.root.wikiRoot})`, inspection.root.wikiRoot, `${WIKI_DIRECTORY}/`)
    }
  }
  const view = await deps.global.resolve()
  if (view.kind !== 'found') {
    lines.push(`global wiki: none — ${globalDisabledReason(view)}`)
  } else {
    await report('global', `global wiki (${view.repo.repoRoot})`, view.repo.repoRoot, '')
  }
  lines.push('', 'the next wiki_search reuses these indexes; files are only read, never rewritten')
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * Run one `/wiki` invocation (DESIGN §6.6).
 * @param invocation - the agent, the raw text after `wiki`, and cancellation.
 * @param deps - configuration, logger, the global state, and the approval lookup.
 * @returns the result the dispatching UI renders.
 */
export async function runWikiCommand(
  invocation: CommandInvocation,
  deps: WikiCommandDeps,
): Promise<CommandResult> {
  const agent: WikiAgent = invocation.agent
  // The dispatching UI owns the signal; every subcommand observes it for its
  // git calls and directory walks.
  const run: WikiCommandDeps = { ...deps, signal: invocation.signal }
  const words = invocation.rawInput.trim().split(/\s+/u).filter(word => word !== '')
  const subcommand = words[0] ?? ''
  const args = words.slice(1)
  const cwd = cwdOf(agent)
  try {
    if (subcommand === 'repo') {
      const action = (args[0] ?? '').toLowerCase()
      if (action === 'set') return await runRepoSet(args.slice(1), agent, run)
      if (action === 'unset') return await runRepoUnset(run)
      return {
        kind: 'error',
        text: `/wiki repo needs \`set <path>\` or \`unset\`\n${WIKI_USAGE}`,
      }
    }
    if (subcommand === 'commit') {
      return await runCommit(args, run)
    }
    if (subcommand === 'reindex') {
      return await runReindex(cwd, run)
    }
    if (subcommand === 'status' || subcommand === 'lint') {
      if (cwd === undefined) {
        return {
          kind: 'error',
          text: `/wiki ${subcommand}: the session recorded no working directory, so there is no wiki to resolve`,
        }
      }
      return subcommand === 'status'
        ? await runStatus(agent, cwd, run)
        : await runLint(args, agent, cwd, run)
    }
    return {
      kind: 'error',
      text: subcommand === '' ? WIKI_USAGE : `unknown subcommand '${subcommand}'\n${WIKI_USAGE}`,
    }
  } catch (error) {
    run.logger.warn('dsh-llm-wiki: /wiki %s failed (%s)', subcommand, describeError(error))
    return { kind: 'error', text: `/wiki ${subcommand} failed: ${describeError(error)}` }
  }
}

/** The command's one-line description, as the discovery UI shows it. */
export const WIKI_COMMAND_DESCRIPTION =
  'Show the LLM wiki status, run its lint checks, rebuild the search index, and commit the global wiki'

/** The input hint the composer shows after `/wiki `. */
export const WIKI_COMMAND_HINT =
  'status | lint [links,index,raw] | reindex | repo set <path> | repo unset | commit [message]'
