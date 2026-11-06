/**
 * The frozen snapshot injection (DESIGN §4.2) — the part of this plugin that
 * decides, once per proposed step, whether the model sees the memory files.
 *
 * The listener is registered globally on `agent/pre-step` and runs **after**
 * `next()`, exactly like `dsh-agent-instructions` (S10):
 *
 * 1. `claimed` is the subset of `decision.messages` that is in the original
 *    `messages` **by identity**. `decision.messages.length` is not usable: the
 *    array also carries runtime-context the loop added (S7).
 * 2. The snapshot is **visible** when a `user/message` whose
 *    `source.kind === 'memory'` is either claimed in this batch or still on the
 *    derived surface. A resume restores it, and compaction shadowing its range
 *    removes it — which is precisely when the snapshot must come back (S11).
 * 3. Nothing is inserted for a rejected step, and nothing for step 1 with an
 *    empty claim: that batch is the runtime-context-only warm-up, and inserting
 *    would open a model call the loop deliberately did not open (S7).
 * 4. The insertion point is directly after the last claimed message, so the
 *    snapshot lands before the runtime-context block; with no claimed message
 *    it goes to the front (the mid-turn steering case).
 * 5. A child (`delegationDepth > 0`) reads the **workspace store only**: the
 *    global notes are the main agent's, and a subagent must not inherit them
 *    (N8). Its `.gitignore` preconditions still apply, so the child's snapshot
 *    appears only where the workspace store is genuinely injectable.
 *
 * No failure here may reach the caller: an exception from a pre-step listener
 * ends the turn (S8), so every read is guarded, a failing store is skipped, and
 * only a warning is logged.
 * @module @anago-harness/memory/inject
 */

import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import {
  appendClaimedMessage,
  documentChars,
  parseDocument,
  readTextFileIfExists,
  scanText,
} from '@anago-harness/knowledge-common'
import { cwdOf, delegationDepthOf, type MemoryAgent, presetOf } from './agents.ts'
import { isPresetExcluded, type MemoryConfig } from './config.ts'
import { describeError } from './errors.ts'
import {
  buildSnapshot,
  createSnapshotMessage,
  escapeEntry,
  isMemoryMessage,
  type RenderedStore,
  sectionName,
} from './snapshot.ts'
import { globalStore, type StoreLocation, workspaceLocation } from './store.ts'
import { inspectWorkspace } from './workspace.ts'

/** A logger, narrowed to the two levels this module uses. */
export interface MemoryLogger {
  /** A recoverable problem: the store is skipped and nothing else happens. */
  warn(message: string, ...args: unknown[]): void
  /** Normal, expected conditions, such as "this directory is not a git worktree". */
  debug(message: string, ...args: unknown[]): void
}

/** The pre-step payload this module reads (S6). */
export interface PreStepPayload {
  /** The agent proposing the step. */
  readonly agent: MemoryAgent
  /** Messages removed from the inbox for this step, before later listeners added any. */
  readonly messages: readonly UserMessage[]
  /** The turn that owns the step. */
  readonly turn: number
  /** The step number within the turn; `1` is the first. */
  readonly step: number
  /** The turn's cancellation signal. */
  readonly signal: AbortSignal
}

/** Everything the listener needs beyond the payload. */
export interface InjectionDeps {
  /** Resolved plugin configuration. */
  readonly config: MemoryConfig
  /** Where recoverable problems go. */
  readonly logger: MemoryLogger
  /** Cancellation for the store reads; the turn's signal when there is one. */
  readonly signal?: AbortSignal
}

/** One store's contribution plus the count its heading needs. */
export interface InjectableSection {
  /** The rendered store: kept entries, refused count, and the section name. */
  readonly rendered: RenderedStore
  /** Code points of the entries as they sit on disk, refused ones included. */
  readonly chars: number
}

/**
 * Whether the snapshot is already visible to the model (DESIGN §4.2).
 *
 * Two places count: the batch about to be admitted, and the derived history.
 * The derived history is the surface after every `surfaceOp`, so a compaction
 * that shadowed the snapshot's node makes this return false and the next step
 * re-injects (S11).
 * @param agent - the agent proposing the step.
 * @param messages - the messages the step would admit.
 * @returns true when a memory snapshot is visible.
 * @throws when the session cannot derive its messages; the caller skips injection.
 */
export function isSnapshotVisible(
  agent: MemoryAgent,
  messages: readonly { readonly source: { readonly kind: string } }[],
): boolean {
  if (messages.some(isMemoryMessage)) return true
  return agent.session
    .deriveMessages()
    .some(message => message.role === 'user' && isMemoryMessage(message))
}

/**
 * Read one store for injection: parse, scan every entry, escape what survives
 * (DESIGN §9, §4.2).
 *
 * The scan is the only line of defense for content that reached the file by
 * hand, through `bash`, or through an external agent (N2): a refused entry is
 * dropped and counted, a secret is replaced by `[REDACTED:<kind>]`, and the
 * store is skipped entirely when there is nothing at all to show.
 * @param location - the store to read.
 * @returns the section, or null when the file is absent or empty.
 * @throws when the file cannot be read.
 */
export async function readInjectableStore(
  location: StoreLocation,
): Promise<InjectableSection | null> {
  const content = await readTextFileIfExists(location.path)
  if (content === null) return null
  const document = parseDocument(content)
  const entries: string[] = []
  let refused = 0
  for (const entry of document.entries) {
    const scan = scanText(entry)
    if (!scan.ok) {
      refused += 1
      continue
    }
    entries.push(escapeEntry(scan.text))
  }
  if (entries.length === 0 && refused === 0) return null
  return {
    rendered: { name: sectionName(location), location, entries, refused },
    chars: documentChars(document),
  }
}

/**
 * Collect the stores a step should inject (DESIGN §4.2, N8).
 *
 * A child reads the workspace store only; a top-level agent reads all three in
 * a fixed order (global notes, user profile, workspace notes). Every failure is
 * contained to its own store: a missing file is simply absent, and an
 * unreadable file, an unresolvable git root, or an unusable `.gitignore` each
 * warn and skip that store alone.
 * @param agent - the agent proposing the step.
 * @param deps - configuration, logger, and cancellation.
 * @returns the sections to inject, in order; empty when there is nothing.
 */
export async function collectInjectableSections(
  agent: MemoryAgent,
  deps: InjectionDeps,
): Promise<InjectableSection[]> {
  const child = delegationDepthOf(agent) > 0
  const sections: InjectableSection[] = []
  const limits = deps.config.limits
  if (!child) {
    for (const location of [
      globalStore('memory', limits.memory),
      globalStore('user', limits.user),
    ]) {
      const section = await readSection(location, deps)
      if (section !== null) sections.push(section)
    }
  }
  const workspace = await readWorkspaceSection(agent, deps)
  if (workspace !== null) sections.push(workspace)
  return sections
}

/** Read one global store, containing every failure to that store. */
async function readSection(
  location: StoreLocation,
  deps: InjectionDeps,
): Promise<InjectableSection | null> {
  try {
    return await readInjectableStore(location)
  } catch (error) {
    deps.logger.warn('dsh-memory: skipped %s for the snapshot (%s)', location.path, describeError(error))
    return null
  }
}

/**
 * Read the workspace store, running DESIGN §5.1's preconditions first.
 *
 * The injection path never writes the `.gitignore` block (U3 puts the first
 * creation at the first write), so a missing rule means "not this step". A
 * directory that is not a git worktree is a normal condition and logs at debug
 * level; a tracked file, an unusable block, or an unreadable store is worth a
 * warning.
 * @param agent - the agent proposing the step.
 * @param deps - configuration, logger, and cancellation.
 * @returns the workspace section, or null when the store is not injectable.
 */
async function readWorkspaceSection(
  agent: MemoryAgent,
  deps: InjectionDeps,
): Promise<InjectableSection | null> {
  const cwd = cwdOf(agent)
  if (cwd === undefined) {
    deps.logger.debug('dsh-memory: the session recorded no cwd, so the workspace store is skipped')
    return null
  }
  try {
    const inspection = await inspectWorkspace({
      cwd,
      enabled: deps.config.workspace.enabled,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    })
    if (inspection.kind === 'unavailable') {
      if (inspection.reason === 'no-git') {
        deps.logger.debug('dsh-memory: %s', inspection.detail)
      } else {
        deps.logger.warn('dsh-memory: %s', inspection.detail)
      }
      return null
    }
    if (!inspection.ignored) {
      deps.logger.warn(
        'dsh-memory: %s is not ignored by git, so the workspace store stays out of the snapshot until the first write adds the managed block',
        inspection.store.gitignore,
      )
      return null
    }
    return await readSection(workspaceLocation(inspection.store, deps.config.limits.workspace), deps)
  } catch (error) {
    deps.logger.warn('dsh-memory: skipped the workspace store (%s)', describeError(error))
    return null
  }
}

/**
 * Decide what one step admits (DESIGN §4.2's truth table).
 *
 * The order of the checks is the table's: a rejected step and the empty first
 * batch are decided before anything is read, visibility is decided before the
 * files are read, and the payload comparison closes the "the same snapshot is
 * already in this batch" case that `next()` can produce.
 * @param payload - the proposed step.
 * @param decision - what `next()` produced.
 * @param deps - configuration, logger, and cancellation.
 * @returns the decision, with the snapshot inserted when the table says so.
 */
export async function injectSnapshot(
  payload: PreStepPayload,
  decision: PreStepDecision,
  deps: InjectionDeps,
): Promise<PreStepDecision> {
  if (decision.kind !== 'enter') return decision
  const claimed = decision.messages.filter(message => payload.messages.includes(message))
  if (payload.step === 1 && claimed.length === 0) return decision
  if (isSnapshotVisible(payload.agent, decision.messages)) return decision
  const sections = await collectInjectableSections(payload.agent, deps)
  if (sections.length === 0) return decision
  const message = createSnapshotMessage(buildSnapshot(sections))
  return appendClaimedMessage(payload.messages, decision, message)
}

/**
 * Build the global `agent/pre-step` listener (DESIGN §4.2).
 *
 * The listener never throws: a failure inside {@link injectSnapshot} is logged
 * and the decision is returned unchanged, because a listener exception ends the
 * turn (S8). Cancellation is the one exception — an aborted turn must not be
 * turned into a successful step.
 * @param deps - configuration and logger.
 * @returns the listener to register with `ctx.on('agent/pre-step', listener)`.
 */
export function createPreStepListener(
  deps: InjectionDeps,
): (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision> {
  return async (payload, next) => {
    const decision = await next()
    if (payload.signal.aborted) return decision
    if (isPresetExcluded(deps.config, presetOf(payload.agent))) {
      deps.logger.debug('dsh-memory: the session preset is excluded, so no snapshot is injected')
      return decision
    }
    try {
      return await injectSnapshot(payload, decision, { ...deps, signal: payload.signal })
    } catch (error) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort during the await
      if (payload.signal.aborted) throw error
      deps.logger.warn('dsh-memory: snapshot injection failed (%s)', describeError(error))
      return decision
    }
  }
}
