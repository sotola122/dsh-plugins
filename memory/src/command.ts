/**
 * `/memory` — the human side of this plugin (DESIGN §4.6, S20).
 *
 * The command is registered globally with `ctx.commands.register`, so it never
 * reaches the model: a person types it in the UI and reads the answer there,
 * while the session log keeps `command/run` and `command/done`.
 *
 * | subcommand | what it does |
 * | --- | --- |
 * | `list` | each store's path, count, usage, pending count, and non-ASCII advisory count, plus the review sidecar |
 * | `show <target>` | the numbered entries, with the advisory marked |
 * | `path` | the three store paths and the pending directories |
 * | `pending` | every staged operation's **full** `text` and `old_text`, wrapped at 80 columns |
 * | `approve <id…\|all>` | the §4.5 re-check, inside the store lock |
 * | `reject <id…\|all>` | delete the staged operations |
 * | `gitignore` | compare the managed block with the expected lines and update it (§5.1) |
 *
 * There is deliberately no `gitignore remove`: the block is maintained, and the
 * way to stop it is `manageGitignore: false` or `workspace.enabled: false`
 * (sixth revision, §5.1). The ids a person types are recorded by
 * `command/run`'s own `recordInput` default, which the design accepts (§4.6).
 * @module @anago-harness/memory/command
 */

import { readFile } from 'node:fs/promises'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  type AtomicWriteApi,
  countCodePoints,
  NON_ASCII_WARN_RATIO,
  scanText,
  sha256Hex,
} from '@anago-harness/knowledge-common'
import { cwdOf, type MemoryAgent } from './agents.ts'
import type { MemoryConfig } from './config.ts'
import { formatCount } from './entries.ts'
import { describeError, isMemoryError, memoryError } from './errors.ts'
import type { MemoryLogger } from './inject.ts'
import {
  ALL_MAX_BYTES,
  ALL_MAX_OPERATIONS,
  approvePending,
  assertAllWithinLimits,
  countOtherWorkspacePending,
  globalPendingDirectory,
  listPending,
  type PendingDirectory,
  type PendingOutcome,
  pendingDirectories,
  pendingRoot,
  rejectPending,
  selectPending,
  workspacePendingDirectory,
  workspacePendingKey,
} from './pending.ts'
import {
  globalStore,
  readStore,
  type MemoryTarget,
  type StoreLocation,
  workspaceLocation,
} from './store.ts'
import {
  ensureWorkspaceWritable,
  inspectWorkspace,
  type ReadyWorkspace,
  syncGitignoreBlock,
} from './workspace.ts'

/** The subcommands this command accepts (DESIGN §4.6, current revision). */
export const MEMORY_SUBCOMMANDS = [
  'list',
  'show',
  'path',
  'pending',
  'approve',
  'reject',
  'gitignore',
] as const

/** One of {@link MEMORY_SUBCOMMANDS}. */
export type MemorySubcommand = (typeof MEMORY_SUBCOMMANDS)[number]

/** The usage block shown for a missing or unknown subcommand. */
export const MEMORY_USAGE = [
  'usage: /memory <subcommand>',
  '  list                          stores, usage, pending counts, review state',
  '  show <memory|user|workspace>  the numbered entries of one store',
  '  path                          the store and pending paths',
  '  pending                       every staged operation, in full',
  '  approve <id…|all>             apply staged operations',
  '  reject <id…|all>              delete staged operations',
  '  gitignore                     bring the managed .gitignore block up to date',
].join('\n')

/** How wide `/memory pending` wraps a staged text (DESIGN §4.6). */
export const DISPLAY_WIDTH = 80

/** Everything the command needs from the plugin. */
export interface MemoryCommandDeps {
  /** Resolved plugin configuration. */
  readonly config: MemoryConfig
  /** Where recoverable problems go. */
  readonly logger: MemoryLogger
  /** `withFileLock` and `writeFileAtomic` from `@deepseek-ai/dsh-atomic-write`. */
  readonly api: AtomicWriteApi
  /** The pending root; defaults to `$DSH_HOME/memories/pending`. */
  readonly pendingRoot?: string
  /** The instant a report is rendered at; defaults to now. */
  readonly now?: () => Date
  /**
   * Cancellation of the dispatching UI request. `runMemoryCommand` fills this
   * from the invocation, so the git reads and the locked store writes observe
   * the same signal the UI handed the handler.
   */
  readonly signal?: AbortSignal
}

/** One git seam argument, omitting what the caller did not supply. */
function signalOption(deps: MemoryCommandDeps): { signal?: AbortSignal } {
  return deps.signal === undefined ? {} : { signal: deps.signal }
}

/** One store as a read-only report describes it. */
interface StoreReport {
  /** Which store. */
  readonly target: MemoryTarget
  /** Its file path; empty when the store cannot be resolved. */
  readonly path: string
  /** Its code-point limit. */
  readonly limit: number
  /** Whether the file exists. */
  readonly exists: boolean
  /** Its entries. */
  readonly entries: readonly string[]
  /** Why the store is unavailable, when it is. */
  readonly unavailable?: string
}

/** Resolve one store for a read-only report. */
async function reportFor(
  target: MemoryTarget,
  agent: MemoryAgent,
  deps: MemoryCommandDeps,
): Promise<StoreReport> {
  if (target !== 'workspace') {
    const limit = target === 'memory' ? deps.config.limits.memory : deps.config.limits.user
    const location = globalStore(target, limit)
    const read = await readStore(location)
    return { target, path: location.path, limit, exists: read.exists, entries: read.document.entries }
  }
  const cwd = cwdOf(agent)
  if (cwd === undefined) {
    return {
      target,
      path: '',
      limit: deps.config.limits.workspace,
      exists: false,
      entries: [],
      unavailable: 'the session recorded no working directory',
    }
  }
  const inspection = await inspectWorkspace({
    cwd,
    enabled: deps.config.workspace.enabled,
    ...signalOption(deps),
  })
  if (inspection.kind === 'unavailable') {
    return {
      target,
      path: '',
      limit: deps.config.limits.workspace,
      exists: false,
      entries: [],
      unavailable: `${inspection.reason}: ${inspection.detail}`,
    }
  }
  const location = workspaceLocation(inspection.store, deps.config.limits.workspace)
  const read = await readStore(location)
  return { target, path: location.path, limit: location.limit, exists: read.exists, entries: read.document.entries }
}

/** The workspace inspection of one invocation, or why there is none. */
async function workspaceOf(
  agent: MemoryAgent,
  deps: MemoryCommandDeps,
): Promise<{ inspection: ReadyWorkspace | null; detail: string }> {
  const cwd = cwdOf(agent)
  if (cwd === undefined) {
    return { inspection: null, detail: 'the session recorded no working directory' }
  }
  const inspection = await inspectWorkspace({
    cwd,
    enabled: deps.config.workspace.enabled,
    ...signalOption(deps),
  })
  if (inspection.kind === 'unavailable') {
    return { inspection: null, detail: `${inspection.reason}: ${inspection.detail}` }
  }
  return { inspection, detail: '' }
}

/** The pending directories this session can address, and its workspace root. */
async function pendingScope(
  agent: MemoryAgent,
  deps: MemoryCommandDeps,
): Promise<{ directories: PendingDirectory[]; workspaceKey: string | null }> {
  const root = deps.pendingRoot ?? pendingRoot()
  const { inspection } = await workspaceOf(agent, deps)
  const workspaceKey = inspection === null ? null : workspacePendingKey(inspection.store.root)
  return {
    directories: pendingDirectories(workspaceKey === null ? {} : { workspaceKey }, root),
    workspaceKey,
  }
}

/** The code points of a store's entries, which is what its limit counts. */
function entriesChars(entries: readonly string[]): number {
  return entries.reduce((total, entry) => total + countCodePoints(entry), 0)
}

/** Count the entries of a store that exceed the non-ASCII advisory (DESIGN §4.6). */
function advisoryCount(entries: readonly string[]): number {
  return entries.filter(entry => scanText(entry).nonAsciiRatio > NON_ASCII_WARN_RATIO).length
}

/**
 * Wrap one block of text at {@link DISPLAY_WIDTH} code points.
 *
 * Breaking is greedy on spaces, and a word longer than the width is cut rather
 * than left to overflow — the point of `/memory pending` is that a person can
 * read a whole entry, so nothing is elided (DESIGN §4.6).
 * @param text - the text to wrap.
 * @param width - the column budget; defaults to 80.
 * @returns the lines, without trailing spaces.
 */
export function wrapDisplay(text: string, width = DISPLAY_WIDTH): string[] {
  const lines: string[] = []
  for (const source of text.split('\n')) {
    const points = Array.from(source)
    if (points.length === 0) {
      lines.push('')
      continue
    }
    let start = 0
    while (start < points.length) {
      let end = Math.min(start + width, points.length)
      if (end < points.length) {
        let space = -1
        for (let index = end; index > start; index -= 1) {
          if (points[index - 1] === ' ') {
            space = index - 1
            break
          }
        }
        if (space > start) end = space
      }
      lines.push(points.slice(start, end).join('').trimEnd())
      start = end
      while (start < points.length && points[start] === ' ') start += 1
    }
  }
  return lines
}

/** Render one staged text under a label, wrapped and with its length. */
function renderStagedText(label: string, text: string): string[] {
  const lines = [`  ${label} (${formatCount(countCodePoints(text))} chars):`]
  for (const line of wrapDisplay(text)) lines.push(`    ${line}`)
  return lines
}

/**
 * How long ago one record was staged, in a compact form.
 * @param createdAt - the ISO instant the record carries.
 * @param now - the instant the report is rendered at.
 * @returns `12s ago`, `3m ago`, `5h ago`, or `2d ago`.
 */
export function formatAge(createdAt: string, now: Date): string {
  const then = Date.parse(createdAt)
  if (Number.isNaN(then)) return 'unknown age'
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000))
  if (seconds < 60) return `${String(seconds)}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${String(hours)}h ago`
  return `${String(Math.round(hours / 24))}d ago`
}

/**
 * The review sidecar of one session (DESIGN §4.7).
 *
 * `./review` writes this file on every attempt; reading it here keeps the
 * command independent of the review's own module, and reports an absent or
 * damaged file as "no review has run" rather than an error.
 */
async function readReviewState(sessionId: string): Promise<{ runs: number; lastOutcome: string | null }> {
  const file = dshHomePath('memories', 'review', `${sha256Hex(sessionId)}.json`)
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as {
      readonly reviewRuns?: unknown
      readonly lastOutcome?: unknown
    }
    return {
      runs: typeof parsed.reviewRuns === 'number' ? parsed.reviewRuns : 0,
      lastOutcome: typeof parsed.lastOutcome === 'string' ? parsed.lastOutcome : null,
    }
  } catch {
    return { runs: 0, lastOutcome: null }
  }
}

/** One store's block in `/memory list`. */
function renderStoreLine(index: number, report: StoreReport, pending: number): string {
  if (report.unavailable !== undefined) {
    return `${String(index)}. ${report.target}: unavailable (${report.unavailable})`
  }
  const chars = entriesChars(report.entries)
  const percent = report.limit <= 0 ? 100 : Math.round((chars / report.limit) * 100)
  return [
    `${String(index)}. ${report.target}  ${report.path}`,
    `   ${formatCount(chars)}/${formatCount(report.limit)} chars (${String(percent)}%), ${String(report.entries.length)} entries, pending ${String(pending)}, non-ASCII advisories ${String(advisoryCount(report.entries))}`,
  ].join('\n')
}

/** `/memory list` (DESIGN §4.6). */
async function runList(agent: MemoryAgent, deps: MemoryCommandDeps): Promise<CommandResult> {
  const root = deps.pendingRoot ?? pendingRoot()
  const scope = await pendingScope(agent, deps)
  const { records, problems } = await listPending(scope.directories)
  const [memory, user, workspace] = await Promise.all([
    reportFor('memory', agent, deps),
    reportFor('user', agent, deps),
    reportFor('workspace', agent, deps),
  ])
  const pendingFor = (target: MemoryTarget): number =>
    records.filter(record => record.op.target === target).length
  const reviewPending = records.filter(record => record.op.source === 'review').length
  const state = await readReviewState(agent.session.id ?? '')
  const lines = [
    `memory stores (pending root: ${root})`,
    renderStoreLine(1, memory, pendingFor('memory')),
    renderStoreLine(2, user, pendingFor('user')),
    renderStoreLine(3, workspace, pendingFor('workspace')),
    `pending: ${String(records.length)} operation(s) — source=tool ${String(records.length - reviewPending)}, source=review ${String(reviewPending)}`,
    `review: enabled ${String(deps.config.review.enabled)}, ${String(state.runs)}/${String(deps.config.review.maxRunsPerSession)} attempt(s), last outcome: ${state.lastOutcome ?? '(none yet)'}`,
  ]
  if (problems.length > 0) {
    lines.push(`unusable pending files: ${String(problems.length)} — see /memory pending`)
  }
  const others = await countOtherWorkspacePending(root, scope.workspaceKey ?? undefined)
  if (others > 0) {
    lines.push(
      `note: ${String(others)} pending operation(s) belong to other repositories; run /memory there to act on them`,
    )
  }
  return { kind: 'success', text: lines.join('\n') }
}

/** `/memory show <target>` (DESIGN §4.6). */
async function runShow(
  args: readonly string[],
  agent: MemoryAgent,
  deps: MemoryCommandDeps,
): Promise<CommandResult> {
  const target = args[0]
  if (target !== 'memory' && target !== 'user' && target !== 'workspace') {
    return { kind: 'error', text: `show needs one of memory, user, workspace\n${MEMORY_USAGE}` }
  }
  const report = await reportFor(target, agent, deps)
  if (report.unavailable !== undefined) {
    return { kind: 'error', text: `MEMORY_NO_WORKSPACE: ${report.unavailable}` }
  }
  const chars = entriesChars(report.entries)
  const lines = [
    `${target}  ${report.path}`,
    `${formatCount(chars)}/${formatCount(report.limit)} chars, ${String(report.entries.length)} entries${report.exists ? '' : ' (the file does not exist yet)'}`,
  ]
  if (report.entries.length === 0) {
    lines.push('(no entries)')
    return { kind: 'success', text: lines.join('\n') }
  }
  for (const [index, entry] of report.entries.entries()) {
    const ratio = scanText(entry).nonAsciiRatio
    const mark = ratio > NON_ASCII_WARN_RATIO ? `  [non-ASCII ${String(Math.round(ratio * 100))}%]` : ''
    lines.push(`${String(index + 1)}. ${entry}${mark}`)
  }
  return { kind: 'success', text: lines.join('\n') }
}

/** `/memory path` (DESIGN §4.6). */
async function runPath(agent: MemoryAgent, deps: MemoryCommandDeps): Promise<CommandResult> {
  const root = deps.pendingRoot ?? pendingRoot()
  const scope = await pendingScope(agent, deps)
  const memory = globalStore('memory', deps.config.limits.memory)
  const user = globalStore('user', deps.config.limits.user)
  const report = await reportFor('workspace', agent, deps)
  return {
    kind: 'success',
    text: [
      `memory     ${memory.path}`,
      `user       ${user.path}`,
      report.unavailable === undefined
        ? `workspace  ${report.path}`
        : `workspace  (unavailable: ${report.unavailable})`,
      `pending    ${root}`,
      `  memory     ${globalPendingDirectory('memory', root)}`,
      `  user       ${globalPendingDirectory('user', root)}`,
      scope.workspaceKey === null
        ? '  workspace  (unavailable: no git worktree)'
        : `  workspace  ${workspacePendingDirectory(scope.workspaceKey, root)}`,
    ].join('\n'),
  }
}

/** `/memory pending` (DESIGN §4.6): every staged operation, in full. */
async function runPending(agent: MemoryAgent, deps: MemoryCommandDeps): Promise<CommandResult> {
  const now = deps.now?.() ?? new Date()
  const root = deps.pendingRoot ?? pendingRoot()
  const scope = await pendingScope(agent, deps)
  const { records, problems } = await listPending(scope.directories)
  if (records.length === 0 && problems.length === 0) {
    const others = await countOtherWorkspacePending(root, scope.workspaceKey ?? undefined)
    return {
      kind: 'success',
      text:
        others === 0
          ? 'No staged operations.'
          : `No staged operations here. ${String(others)} belong to another repository; run /memory there.`,
    }
  }
  const lines: string[] = []
  for (const record of records) {
    const { op } = record
    const chars = countCodePoints(op.text ?? '') + countCodePoints(op.old_text ?? '')
    lines.push(
      `${op.id}  ${op.target}  source=${op.source}  ${formatAge(op.createdAt, now)}  ${op.op}  ${formatCount(chars)} chars`,
    )
    lines.push(`  baseEntry: ${op.baseEntry === undefined ? '(none)' : op.baseEntry}`)
    if (op.old_text !== undefined) lines.push(...renderStagedText('old_text', op.old_text))
    if (op.text !== undefined) lines.push(...renderStagedText('text', op.text))
  }
  if (problems.length > 0) {
    lines.push(`Files that are not usable pending operations (${String(problems.length)}):`)
    for (const problem of problems) lines.push(`  ${problem.file}: ${problem.detail}`)
  }
  lines.push(
    `approve with /memory approve <id…>, or drop with /memory reject <id…>; 'all' applies at most ${String(ALL_MAX_OPERATIONS)} operations and ${formatCount(ALL_MAX_BYTES)} bytes at once.`,
  )
  return { kind: 'success', text: lines.join('\n') }
}

/** Render one approval/rejection outcome. */
function renderOutcome(verb: 'approved' | 'rejected', outcome: PendingOutcome): string {
  if (outcome.ok) return `${verb} ${outcome.id} (${outcome.target})`
  return `${outcome.dropped === true ? 'dropped' : 'kept'} ${outcome.id} (${outcome.target}): ${outcome.message}`
}

/** `/memory approve` and `/memory reject` (DESIGN §4.5, §4.6). */
async function runDecide(
  verb: 'approve' | 'reject',
  args: readonly string[],
  agent: MemoryAgent,
  deps: MemoryCommandDeps,
): Promise<CommandResult> {
  if (args.length === 0) {
    return { kind: 'error', text: `${verb} needs at least one id, or all\n${MEMORY_USAGE}` }
  }
  if (args.includes('all') && args.length > 1) {
    return { kind: 'error', text: '\'all\' cannot be combined with ids' }
  }
  const all = args[0] === 'all'
  const scope = await pendingScope(agent, deps)
  const selection = await selectPending(all ? 'all' : args, scope.directories)
  const lines: string[] = []
  if (verb === 'reject') {
    const outcomes = await rejectPending(selection.records)
    lines.push(...outcomes.map(outcome => renderOutcome('rejected', outcome)))
    for (const id of selection.unknown) lines.push(`MEMORY_PENDING_UNKNOWN: ${id}`)
    for (const problem of selection.problems) lines.push(`MEMORY_PENDING_UNKNOWN: ${problem.detail}`)
    const rejected = outcomes.filter(outcome => outcome.ok).length
    lines.unshift(
      `rejected ${String(rejected)} of ${String(selection.records.length)} selected staged operation(s)`,
    )
    if (rejected === 0 && (selection.unknown.length > 0 || selection.problems.length > 0)) {
      return { kind: 'error', text: lines.join('\n') }
    }
    return { kind: 'success', text: lines.join('\n') }
  }
  // The bounds belong to `all` alone: naming the ids explicitly is how a person
  // approves more than the bound (DESIGN §4.5).
  if (all) {
    try {
      assertAllWithinLimits(selection.records)
    } catch (error) {
      return { kind: 'error', text: describeError(error) }
    }
  }
  const { inspection } = await workspaceOf(agent, deps)
  const locations = new Map<MemoryTarget, StoreLocation>()
  const locationFor = async (target: MemoryTarget): Promise<StoreLocation> => {
    const cached = locations.get(target)
    if (cached !== undefined) return cached
    let location: StoreLocation
    if (target === 'memory') {
      location = globalStore('memory', deps.config.limits.memory)
    } else if (target === 'user') {
      location = globalStore('user', deps.config.limits.user)
    } else {
      if (inspection === null) {
        throw memoryError(
          'MEMORY_NO_WORKSPACE',
          'a staged workspace operation needs the repository it was staged in',
        )
      }
      // The first real write of the workspace store, so this is where the
      // managed `.gitignore` block appears (DESIGN §5.1, U3).
      const store = await ensureWorkspaceWritable(inspection, {
        api: deps.api,
        manageGitignore: deps.config.workspace.manageGitignore,
        lockWaitMs: deps.config.lockWaitMs,
        ...signalOption(deps),
      })
      location = workspaceLocation(store, deps.config.limits.workspace)
    }
    locations.set(target, location)
    return location
  }
  const outcomes = await approvePending(selection.records, {
    locationFor,
    api: deps.api,
    lockWaitMs: deps.config.lockWaitMs,
    logger: deps.logger,
    ...signalOption(deps),
  })
  lines.push(...outcomes.map(outcome => renderOutcome('approved', outcome)))
  for (const id of selection.unknown) lines.push(`MEMORY_PENDING_UNKNOWN: ${id}`)
  for (const problem of selection.problems) lines.push(`MEMORY_PENDING_UNKNOWN: ${problem.detail}`)
  const applied = outcomes.filter(outcome => outcome.ok).length
  lines.unshift(`applied ${String(applied)} of ${String(selection.records.length)} selected staged operation(s)`)
  if (applied === 0 && selection.records.length + selection.unknown.length + selection.problems.length > 0) {
    return { kind: 'error', text: lines.join('\n') }
  }
  return { kind: 'success', text: lines.join('\n') }
}

/** `/memory gitignore` (DESIGN §4.6, §5.1). */
async function runGitignore(
  args: readonly string[],
  agent: MemoryAgent,
  deps: MemoryCommandDeps,
): Promise<CommandResult> {
  if (args.length > 0) {
    return {
      kind: 'error',
      text: [
        `gitignore takes no argument, and there is no \`gitignore ${args[0]}\` (sixth revision): the managed block is maintained rather than removed.`,
        'Stop the block with `workspace.manageGitignore: false`, or stop using the workspace store with `workspace.enabled: false`; to drop an existing block, edit .gitignore by hand.',
      ].join('\n'),
    }
  }
  const { inspection, detail } = await workspaceOf(agent, deps)
  if (inspection === null) {
    return { kind: 'error', text: `MEMORY_NO_WORKSPACE: ${detail}` }
  }
  try {
    const result = await syncGitignoreBlock(inspection, {
      api: deps.api,
      manageGitignore: deps.config.workspace.manageGitignore,
      lockWaitMs: deps.config.lockWaitMs,
      ...signalOption(deps),
    })
    const lines = [
      inspection.store.gitignore,
      result.edited
        ? `${result.created ? 'created' : 'updated'} the managed block`
        : `unchanged: ${result.skipped ?? 'the block already matches the expected lines'}`,
      ...result.lines.map(line => `  ${line}`),
      deps.config.workspace.manageGitignore
        ? 'There is no `gitignore remove`: the block is maintained, and committing .gitignore is left to a person.'
        : 'workspace.manageGitignore is false: set it to true to let the plugin write the block, or set workspace.enabled to false to stop using the workspace store.',
    ]
    return { kind: 'success', text: lines.join('\n') }
  } catch (error) {
    if (isMemoryError(error)) return { kind: 'error', text: error.message }
    throw error
  }
}

/**
 * Run one `/memory` invocation (DESIGN §4.6).
 * @param invocation - the agent, the raw text after `memory`, and cancellation.
 * @param deps - configuration, logger, and the atomic-write seam.
 * @returns the result the dispatching UI renders.
 */
export async function runMemoryCommand(
  invocation: CommandInvocation,
  deps: MemoryCommandDeps,
): Promise<CommandResult> {
  const agent: MemoryAgent = invocation.agent
  // The dispatching UI owns the signal; every git read and locked write below
  // observes it (the same rule S16 states for tool execution).
  const run: MemoryCommandDeps = { ...deps, signal: invocation.signal }
  const words = invocation.rawInput.trim().split(/\s+/u).filter(word => word !== '')
  const subcommand = words[0] ?? ''
  const args = words.slice(1)
  try {
    switch (subcommand) {
      case 'list':
        return await runList(agent, run)
      case 'show':
        return await runShow(args, agent, run)
      case 'path':
        return await runPath(agent, run)
      case 'pending':
        return await runPending(agent, run)
      case 'approve':
        return await runDecide('approve', args, agent, run)
      case 'reject':
        return await runDecide('reject', args, agent, run)
      case 'gitignore':
        return await runGitignore(args, agent, run)
      default:
        return {
          kind: 'error',
          text:
            subcommand === '' ? MEMORY_USAGE : `unknown subcommand '${subcommand}'\n${MEMORY_USAGE}`,
        }
    }
  } catch (error) {
    if (isMemoryError(error)) return { kind: 'error', text: error.message }
    run.logger.warn('dsh-memory: /memory %s failed (%s)', subcommand, describeError(error))
    return { kind: 'error', text: `/memory ${subcommand} failed: ${describeError(error)}` }
  }
}

/** The command's one-line description, as the discovery UI shows it. */
export const MEMORY_COMMAND_DESCRIPTION =
  'Inspect the persistent memory stores and approve or reject staged writes'

/** The input hint the composer shows after `/memory `. */
export const MEMORY_COMMAND_HINT =
  'list | show <memory|user|workspace> | path | pending | approve <id…|all> | reject <id…|all> | gitignore'
