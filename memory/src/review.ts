/**
 * The turn-end review (DESIGN §4.7, sixth revision).
 *
 * After a conversation the plugin asks a small auxiliary model call whether
 * anything in it belongs in memory. The trigger is the drain point the design
 * settled on:
 *
 * ```text
 * turn/end (completed)  ──count──▶  accumulation  ──agent/status = idle──▶  1 attempt
 * ```
 *
 * - **Counting** is by completed turns, not by idle occurrences: `idle` is
 *   emitted for other reasons too, and `runMaintenance` would hold later input
 *   (S24). A turn that ended `aborted`, `error`, `max-tokens`, or `blocked`
 *   never counts.
 * - **Persistence** is the sidecar `$DSH_HOME/memories/review/<sha256(id)>.json`
 *   with `{reviewRuns, consumedCompleted, fullNotified, lastOutcome}` (the file
 *   `/memory list` already reads). `reviewRuns` is **attempts**, failures
 *   included: it is incremented and written **before** the stream call, so a
 *   round that dies mid-call still spent one of the session's four.
 * - **Non-blocking**: the listener returns immediately and the review runs on
 *   its own; nothing here touches the running turn's signal. Cancellation is a
 *   dedicated `AbortController`, aborted by `timeoutMs`, by `agent/disposed`,
 *   and by the plugin's disposer. One review runs per **plugin instance** at a
 *   time, and the disposer aborts and awaits it before the fiber is disposed.
 * - **Model-visible ⟺ logged**: immediately before dispatch, the exact request
 *   (route, system, messages, token cap, and reasoning effort) is appended as
 *   the log-only `memory/review-request` event. The response is not logged.
 * - **Always staged** (U2): a proposal that passes the `memory` tool's own
 *   validation is recorded as pending operations with `source: 'review'`, which
 *   `/memory approve` applies. Nothing is written directly.
 * - **Failures are quiet**: a timeout, a stream error, unparseable output, or a
 *   refused operation discards that round with a warning line and no retry.
 *
 * What the design asks for beyond this module: §4.7 folds the whole log in a
 * host-only session projection (`memoryReviewTurns`) so the completed count is
 * absolute. This implementation accumulates the same `turn/end` events on
 * `session/event` instead, and keeps the *consumed* count absolute through the
 * sidecar (`reviewRuns` and `consumedCompleted` cross a resume exactly as the
 * design specifies). The reason is the package's declared peer set (§3.1): it
 * has no `dsh-session-projection`, and the only other way to fold a resumed log
 * is the deprecated `eventAt` family (S24, `作法`). The residual difference is
 * bounded and one-directional: completed turns from before this process started
 * are not re-counted, so a resumed session needs up to `everyTurns` fresh turns
 * where the projection would have drained the old remainder immediately.
 * @module @anago-harness/memory/review
 */

import path from 'node:path'
import { type ContextFormed, createUserMessage, type GenerateOptions, type LlmCallConfig, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  type AtomicWriteApi,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  type SecretKind,
  countCodePoints,
  escapeFrameTagClosers,
  readTextFileIfExists,
  sha256Hex,
} from '@anago-harness/knowledge-common'
import { cwdOf, delegationDepthOf, presetOf } from './agents.ts'
import { isPresetExcluded, type MemoryConfig } from './config.ts'
import { type MemoryOperation, applyOperations, assertWithinLimit } from './entries.ts'
import { describeError, isMemoryError } from './errors.ts'
import type { MemoryLogger } from './inject.ts'
import {
  countPending,
  globalPendingDirectory,
  pendingRoot,
  stageOperations,
  workspacePendingDirectory,
  workspacePendingKey,
} from './pending.ts'
import {
  buildReviewInput,
  describeFinding,
  type MemoryReviewRequestEventData,
  type ReviewAgent,
  type ReviewSession,
  type ReviewStoreView,
} from './review-input.ts'
import { globalStore, readStore, type MemoryTarget, workspaceLocation } from './store.ts'
import { inspectWorkspace } from './workspace.ts'

export type { MemoryReviewRequestEventData }

/** `MessageSourceMap` entry for everything this module produces (S14). */
export interface MemoryReviewSource {
  /** Producer identity: the review's request message and its notices. */
  readonly kind: 'memory-review'
  /** A notice carries its one-line account; a request message carries none. */
  readonly form: 'notice'
  /** The model-facing line, for readers that show the notice from metadata. */
  readonly summary: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'memory-review': { readonly kind: 'memory-review' } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Log-only pre-dispatch record of one turn-end review model request. It
     * never enters the model surface and has no replay effect; the response is
     * not recorded here, and staged operations live in the pending files.
     */
    'memory/review-request': MemoryReviewRequestEventData
  }
}

/** Directory under `$DSH_HOME/memories` that holds the review sidecars. */
export const REVIEW_DIRECTORY_NAME = 'review'

/** The `system` of one review call, verbatim from DESIGN §4.7. */
export const REVIEW_SYSTEM =
  'Propose memory updates as one JSON object, with no code fence. Operations are English and self-contained, at most 4.'

/** The most operations one review may propose (DESIGN §4.7). */
export const MAX_REVIEW_OPERATIONS = 4

/** The longest notice summary this producer emits (S14's bound). */
export const REVIEW_NOTICE_MAX_LENGTH = 120

/** The one call shape the review makes (S22). */
export interface ReviewLlm {
  /**
   * Resolve one call against the current adapter registration.
   * @param config - the conversation's route plus the output-token cap.
   * @param signal - cancellation of the preparation.
   * @returns the registration-bound call.
   */
  prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<ReviewPreparedCall>
}

/** A prepared review call: its frozen config and the bound dispatch. */
export interface ReviewPreparedCall {
  /** Detached config that must be spread into {@link ReviewPreparedCall.stream}. */
  readonly config: LlmCallConfig
  /**
   * Dispatch the prepared call once.
   * @param options - `{...config, messages, system, signal}` (DESIGN §4.7).
   * @returns the raw chunk stream.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** One reason the review gave up, with the code `lastOutcome` records. */
export class ReviewError extends Error {
  /** A short, stable code: `REVIEW_*`, or a `MEMORY_*` refusal from validation. */
  readonly code: string
  /**
   * @param code - the stable code.
   * @param message - the human-readable detail.
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ReviewError'
    this.code = code
  }
}

/** The sidecar written for one session (DESIGN §4.7). */
export interface ReviewStateFile {
  /** Attempts so far, failures included. */
  readonly reviewRuns: number
  /** Completed turns already consumed by an attempt. */
  readonly consumedCompleted: number
  /** Whether the "all stores are full" notice has been shown since room appeared. */
  readonly fullNotified: boolean
  /** The last round's short outcome, or null before the first one. */
  readonly lastOutcome: string | null
}

/** The sidecar's value before any review has run. */
export const EMPTY_REVIEW_STATE: ReviewStateFile = {
  reviewRuns: 0,
  consumedCompleted: 0,
  fullNotified: false,
  lastOutcome: null,
}

/**
 * `$DSH_HOME/memories/review`.
 * @returns the absolute root holding every session's review sidecar.
 */
export function reviewRoot(): string {
  return dshHomePath('memories', REVIEW_DIRECTORY_NAME)
}

/**
 * The sidecar of one session (DESIGN §4.7).
 *
 * Session ids can contain whitespace, so the file name is the digest of the id
 * rather than the id; `/memory list` reads the same path.
 * @param sessionId - the session identity.
 * @param root - the sidecar root; overridable for a test.
 * @returns the absolute path.
 */
export function reviewSidecarPath(sessionId: string, root = reviewRoot()): string {
  return path.join(root, `${sha256Hex(sessionId)}.json`)
}

/**
 * Parse one sidecar, tolerating anything a hand edit or an older version left.
 * @param text - the file's content.
 * @returns the recognised fields, with every missing one defaulted.
 */
export function parseReviewState(text: string): ReviewStateFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ...EMPTY_REVIEW_STATE }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...EMPTY_REVIEW_STATE }
  }
  const record = parsed as Record<string, unknown>
  const count = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
  return {
    reviewRuns: count(record.reviewRuns),
    consumedCompleted: count(record.consumedCompleted),
    fullNotified: record.fullNotified === true,
    lastOutcome: typeof record.lastOutcome === 'string' ? record.lastOutcome : null,
  }
}

/**
 * Read one sidecar; absence and damage both read as "no review has run".
 * @param file - the sidecar path.
 * @returns the state.
 */
export async function readReviewStateFile(file: string): Promise<ReviewStateFile> {
  const content = await readTextFileIfExists(file)
  return content === null ? { ...EMPTY_REVIEW_STATE } : parseReviewState(content)
}

/**
 * Write one sidecar through the atomic seam (`0600`, parents `0700`).
 * @param file - the sidecar path.
 * @param state - the complete next value.
 * @param api - `writeFileAtomic` from `@deepseek-ai/dsh-atomic-write`.
 */
export async function writeReviewStateFile(
  file: string,
  state: ReviewStateFile,
  api: AtomicWriteApi,
): Promise<void> {
  await api.writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
    dirMode: PRIVATE_DIRECTORY_MODE,
  })
}

/** One operation the review proposes, with the store it addresses. */
export interface ReviewOperation {
  /** Which store the operation addresses. */
  readonly target: MemoryTarget
  /** The entry-level operation, in the `memory` tool's own vocabulary. */
  readonly operation: MemoryOperation
}

/**
 * Strip one code fence that wraps the whole output (DESIGN §4.7).
 * @param text - the concatenated `text-delta` payload.
 * @returns the body, fenced or not.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const firstBreak = trimmed.indexOf('\n')
  if (firstBreak === -1) return trimmed
  const opening = /^(`{3,}|~{3,})/u.exec(trimmed)
  if (opening === null) return trimmed
  const marker = opening[1] as string
  const closing = new RegExp(`^${marker[0]}{${String(marker.length)},}$`, 'u')
  const lastBreak = trimmed.lastIndexOf('\n')
  if (!closing.test(trimmed.slice(lastBreak + 1).trim())) return trimmed
  return trimmed.slice(firstBreak + 1, lastBreak).trim()
}

/**
 * Parse one review response (DESIGN §4.7).
 *
 * The shape is closed and deliberately smaller than the tool's: `{"operations":
 * […]}` and nothing else, at most {@link MAX_REVIEW_OPERATIONS} entries. The
 * deep rules — the §9 scan, the delimiter line, duplicates, `old_text`
 * uniqueness, and the store limit — are **not** re-implemented here; they are
 * applied by the same `applyOperations`/`assertWithinLimit` pair the `memory`
 * tool runs, so a proposal cannot be accepted by one path and refused by the
 * other.
 * @param text - the concatenated `text-delta` payload.
 * @returns the proposed operations, in output order.
 * @throws ReviewError `REVIEW_INVALID_OUTPUT` for anything else.
 */
export function parseReviewOutput(text: string): ReviewOperation[] {
  const body = stripCodeFence(text)
  if (body === '') {
    throw new ReviewError('REVIEW_INVALID_OUTPUT', 'the model returned no text')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    throw new ReviewError('REVIEW_INVALID_OUTPUT', `the output is not JSON (${describeError(error)})`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ReviewError('REVIEW_INVALID_OUTPUT', 'the output is not a JSON object')
  }
  const record = parsed as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'operations') {
      throw new ReviewError('REVIEW_INVALID_OUTPUT', `the JSON carries the unknown key ${JSON.stringify(key)}`)
    }
  }
  const operations = record.operations
  if (!Array.isArray(operations)) {
    throw new ReviewError('REVIEW_INVALID_OUTPUT', '`operations` must be an array')
  }
  if (operations.length > MAX_REVIEW_OPERATIONS) {
    throw new ReviewError(
      'REVIEW_INVALID_OUTPUT',
      `${String(operations.length)} operations were proposed; at most ${String(MAX_REVIEW_OPERATIONS)} are accepted`,
    )
  }
  return operations.map((operation, position) => parseReviewOperation(operation, position))
}

/** The allowed keys of one proposed operation. */
const REVIEW_OPERATION_KEYS: ReadonlySet<string> = new Set(['op', 'target', 'text', 'old_text'])

/** Validate one proposed operation's shape and vocabulary. */
function parseReviewOperation(raw: unknown, position: number): ReviewOperation {
  const at = `operations[${String(position)}]`
  const refuse: (detail: string) => never = (detail) => {
    throw new ReviewError('REVIEW_INVALID_OUTPUT', `${at} ${detail}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) refuse('is not an object')
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!REVIEW_OPERATION_KEYS.has(key)) refuse(`carries the unknown key ${JSON.stringify(key)}`)
  }
  const target = record.target
  if (target !== 'memory' && target !== 'user' && target !== 'workspace') {
    refuse('needs target memory, user, or workspace')
  }
  const op = record.op
  if (op !== 'add' && op !== 'patch' && op !== 'remove') refuse('needs op add, patch, or remove')
  const text = record.text
  const oldText = record.old_text
  if (text !== undefined && typeof text !== 'string') refuse('has a non-string text')
  if (oldText !== undefined && typeof oldText !== 'string') refuse('has a non-string old_text')
  return {
    target,
    operation: {
      op,
      ...(text === undefined ? {} : { text }),
      ...(oldText === undefined ? {} : { old_text: oldText }),
    },
  }
}

/** One store the review can read, and where its staged operations would go. */
export interface ReviewStore extends ReviewStoreView {
  /** The pending directory of this store. */
  readonly pending: string
}

/** The stores of one review round, in prompt order. */
export interface ReviewScope {
  /** Every store this session can address; `workspace` only inside a git root. */
  readonly stores: readonly ReviewStore[]
}

/** What one staged review produced. */
export interface ReviewStaged {
  /** The pending ids, in operation order. */
  readonly ids: string[]
  /** Secret kinds the entry scan replaced. */
  readonly redacted: readonly SecretKind[]
}

/** Everything the runner needs from the plugin. */
export interface ReviewDeps {
  /** Resolved plugin configuration. */
  readonly config: MemoryConfig
  /** Where recoverable problems go. */
  readonly logger: MemoryLogger
  /** `writeFileAtomic` from `@deepseek-ai/dsh-atomic-write`, for the sidecar. */
  readonly api: AtomicWriteApi
  /** The LLM service, resolved per round; absent means the review cannot run. */
  readonly llm: () => ReviewLlm | undefined
  /**
   * Whether this process is a headless one-shot run, read at each decision
   * (DESIGN §4.7, T15). The plugin supplies the live service check; omitting
   * it means the caller cannot tell and the run counts as interactive.
   */
  readonly isHeadless?: () => boolean
  /** The sidecar root; defaults to `$DSH_HOME/memories/review`. */
  readonly reviewRoot?: string
  /** The pending root; defaults to `$DSH_HOME/memories/pending`. */
  readonly pendingRoot?: string
}

/** The review's three event seams, as the plugin wires them (DESIGN §4.7). */
export interface ReviewRunner {
  /**
   * `session/event`: count one completed turn.
   * @param session - the session the event belongs to.
   * @param event - the committed event.
   */
  observe(session: ReviewSession, event: unknown): void
  /**
   * `agent/status` → `idle`: the drain point (DESIGN §4.7).
   *
   * The plugin must not await this in the listener — the point of the design is
   * that the turn is not held. It never rejects.
   * @param agent - the agent that just went idle.
   */
  drain(agent: ReviewAgent): Promise<void>
  /**
   * `agent/disposed`: abort the round this agent started (DESIGN §4.7).
   * @param agent - the agent being disposed.
   */
  dispose(agent: ReviewAgent): void
  /**
   * Plugin unload: stop accepting rounds, abort the in-flight one, and await
   * its settlement, including the staging and sidecar writes after the call.
   * @returns a promise that settles after the in-flight round has finished.
   */
  stop(): Promise<void>
}

/** One in-flight review owned by a single plugin instance. */
interface ActiveReview {
  /** The agent whose conversation is being reviewed. */
  readonly agent: ReviewAgent
  /** Cancellation of this round's preparation and stream. */
  readonly controller: AbortController
  /** Resolves once the round, including its final writes, has settled. */
  readonly settled: Promise<void>
  /** Mark the round settled; called from the round's `finally`. */
  readonly settle: () => void
}

/** Per-session accumulation and the sidecar fields it carries (DESIGN §4.7). */
interface SessionCounters {
  /** Completed turns observed since the last attempt started. */
  turns: number
  /** Whether the sidecar has been read into this record. */
  loaded: boolean
  /** Attempts so far, failures included. */
  runs: number
  /** Completed turns already consumed, as the sidecar records them. */
  consumedCompleted: number
  /** Whether the full-store notice has been shown since room last appeared. */
  fullNotified: boolean
  /** The previous round's short outcome. */
  lastOutcome: string | null
}

/**
 * Bound a notice summary to what a `form:'notice'` message keeps (S14).
 * @param summary - the summary text; internal whitespace collapses to one space.
 * @returns the summary on one line, truncated with `…` at the notice length limit.
 */
export function boundReviewSummary(summary: string): string {
  const one = escapeFrameTagClosers(summary.replace(/\s+/gu, ' ').trim())
  if (one.length <= REVIEW_NOTICE_MAX_LENGTH) return one
  return `${one.slice(0, REVIEW_NOTICE_MAX_LENGTH - 1).trimEnd()}…`
}

/**
 * The route of the conversation's own calls (DESIGN §4.7).
 *
 * `agent.options` first, then the recorded `request/header` (S24). There is no
 * `review.provider`/`review.model`: the sixth revision removed them so the
 * review cannot be routed anywhere the conversation does not already go.
 * @param agent - the agent that went idle.
 * @returns the route, or null when the conversation has none yet.
 */
export function reviewRoute(agent: ReviewAgent): { provider: string; model: string } | null {
  const options = agent.options
  if (
    typeof options?.provider === 'string' &&
    options.provider !== '' &&
    typeof options.model === 'string' &&
    options.model !== ''
  ) {
    return { provider: options.provider, model: options.model }
  }
  const config = agent.session.requestHeader?.()?.config
  if (
    config !== undefined &&
    typeof config.provider === 'string' &&
    config.provider !== '' &&
    typeof config.model === 'string' &&
    config.model !== ''
  ) {
    return { provider: config.provider, model: config.model }
  }
  return null
}

/**
 * Build the review runner (DESIGN §4.7).
 * @param deps - configuration, logger, the atomic seam, and the LLM lookup.
 * @returns the event seams and the unload `stop` seam the plugin registers.
 */
export function createReviewRunner(deps: ReviewDeps): ReviewRunner {
  const counters = new Map<string, SessionCounters>()
  /** Whether this runner's plugin has been disposed. */
  let stopped = false
  /** The one in-flight review of this plugin instance. */
  let activeReview: ActiveReview | null = null

  /** The counters of one session, created empty. */
  const countersFor = (sessionId: string): SessionCounters => {
    const existing = counters.get(sessionId)
    if (existing !== undefined) return existing
    const created: SessionCounters = {
      turns: 0,
      loaded: false,
      runs: 0,
      consumedCompleted: 0,
      fullNotified: false,
      lastOutcome: null,
    }
    counters.set(sessionId, created)
    return created
  }

  /** Where this round's sidecar lives. */
  const sidecarFor = (sessionId: string): string =>
    reviewSidecarPath(sessionId, deps.reviewRoot ?? reviewRoot())

  /** Read the sidecar into the counters, once per session. */
  const loadCounters = async (state: SessionCounters, file: string): Promise<void> => {
    if (state.loaded) return
    const stored = await readReviewStateFile(file)
    state.runs = stored.reviewRuns
    state.consumedCompleted = stored.consumedCompleted
    state.fullNotified = stored.fullNotified
    state.lastOutcome = stored.lastOutcome
    state.loaded = true
  }

  /** Write the counters back, reporting a failure instead of throwing. */
  const persist = async (state: SessionCounters, file: string, strict: boolean): Promise<boolean> => {
    const value: ReviewStateFile = {
      reviewRuns: state.runs,
      consumedCompleted: state.consumedCompleted,
      fullNotified: state.fullNotified,
      lastOutcome: state.lastOutcome,
    }
    try {
      await writeReviewStateFile(file, value, deps.api)
      return true
    } catch (error) {
      deps.logger.warn('dsh-memory: the review sidecar %s could not be written (%s)', file, describeError(error))
      if (strict) throw error
      return false
    }
  }

  /** Queue the model-facing notice without waking the driver (DESIGN §4.7). */
  const notify = (agent: ReviewAgent, summary: string): void => {
    if (agent.inject === undefined) return
    try {
      const bounded = boundReviewSummary(summary)
      const source: MemoryReviewSource = { kind: 'memory-review', form: 'notice', summary: bounded }
      agent.inject(
        createUserMessage({
          content: [{ type: 'text', text: bounded }],
          source,
        }),
      )
    } catch (error) {
      deps.logger.warn('dsh-memory: the review notice could not be queued (%s)', describeError(error))
    }
  }

  /** Read every store this session can address (DESIGN §4.7). */
  const resolveScope = async (agent: ReviewAgent): Promise<ReviewScope> => {
    const limits = deps.config.limits
    const root = deps.pendingRoot ?? pendingRoot()
    const stores: ReviewStore[] = []
    for (const target of ['memory', 'user'] as const) {
      const location = globalStore(target, target === 'memory' ? limits.memory : limits.user)
      const read = await readStore(location)
      stores.push({
        target,
        location,
        document: read.document,
        pending: globalPendingDirectory(target, root),
      })
    }
    const cwd = cwdOf(agent)
    if (cwd !== undefined && deps.config.workspace.enabled) {
      const inspection = await inspectWorkspace({ cwd, enabled: deps.config.workspace.enabled })
      if (inspection.kind === 'ready') {
        const location = workspaceLocation(inspection.store, limits.workspace)
        const read = await readStore(location)
        stores.push({
          target: 'workspace',
          location,
          document: read.document,
          pending: workspacePendingDirectory(workspacePendingKey(inspection.store.root), root),
        })
      } else {
        deps.logger.debug('dsh-memory: no workspace store for the review (%s)', inspection.detail)
      }
    }
    return { stores }
  }

  /**
   * Validate and stage one round (DESIGN §4.7, §4.5).
   *
   * Every group is validated against its store **before** anything is staged,
   * because the design discards the whole round when one element fails. The
   * staging itself is per operation, like every other staged write: a failure
   * between the groups leaves the earlier ones recorded, which the user can
   * read and reject.
   */
  const stageRound = async (
    operations: readonly ReviewOperation[],
    scope: ReviewScope,
    sessionId: string,
  ): Promise<ReviewStaged> => {
    const groups = new Map<MemoryTarget, MemoryOperation[]>()
    for (const { target, operation } of operations) {
      const group = groups.get(target)
      if (group === undefined) groups.set(target, [operation])
      else group.push(operation)
    }
    const planned: { store: ReviewStore; operations: MemoryOperation[] }[] = []
    for (const [target, group] of groups) {
      const store = scope.stores.find(candidate => candidate.target === target)
      if (store === undefined) {
        throw new ReviewError(
          'MEMORY_NO_WORKSPACE',
          `the review proposed a ${target} operation, but this session has no such store`,
        )
      }
      const applied = applyOperations(store.document.entries, group)
      assertWithinLimit({ header: store.document.header, entries: applied.entries }, store.location.limit)
      planned.push({ store, operations: group })
    }
    const ids: string[] = []
    const redacted: SecretKind[] = []
    for (const group of planned) {
      const outcome = await stageOperations({
        target: group.store.target,
        directory: group.store.pending,
        sessionId,
        source: 'review',
        operations: group.operations,
        document: group.store.document,
        limit: group.store.location.limit,
        maxPerStore: deps.config.pending.maxPerStore,
      })
      ids.push(...outcome.ids)
      for (const kind of outcome.redacted) if (!redacted.includes(kind)) redacted.push(kind)
    }
    return { ids, redacted }
  }

  /** One round, from the sidecar read to the notice (DESIGN §4.7). */
  const runRound = async (
    agent: ReviewAgent,
    sessionId: string,
    state: SessionCounters,
    active: ActiveReview,
  ): Promise<void> => {
    const review = deps.config.review
    const file = sidecarFor(sessionId)
    await loadCounters(state, file)
    if (state.runs >= review.maxRunsPerSession) {
      deps.logger.debug(
        'dsh-memory: the review has used %s of %s attempt(s); the accumulation stays',
        String(state.runs),
        String(review.maxRunsPerSession),
      )
      return
    }
    const scope = await resolveScope(agent)
    // A store nobody can write to is a reason not to spend a call (DESIGN §4.7).
    const counts = await Promise.all(scope.stores.map(store => countPending(store.pending)))
    const full = counts.length > 0 && counts.every(count => count >= deps.config.pending.maxPerStore)
    if (full) {
      if (!state.fullNotified) {
        state.fullNotified = true
        await persist(state, file, false)
        notify(
          agent,
          `Turn-end review paused: every memory store is full (${String(deps.config.pending.maxPerStore)} staged). Use /memory approve or /memory reject.`,
        )
      }
      deps.logger.warn(
        'dsh-memory: the review skipped a round because every writable store is full (%s operation(s))',
        String(counts.reduce((total, count) => total + count, 0)),
      )
      return
    }
    if (state.fullNotified) {
      state.fullNotified = false
      await persist(state, file, false)
    }
    const route = reviewRoute(agent)
    if (route === null) {
      deps.logger.warn('dsh-memory: the review skipped a round because the conversation has no route yet')
      return
    }
    const built = buildReviewInput({
      agent,
      stores: scope.stores,
      maxInputBytes: review.maxInputBytes,
    })
    if (built.kind === 'refused') {
      deps.logger.warn(
        'dsh-memory: the review skipped a round because the §9 scan refused the excerpt (%s)',
        built.findings.map(describeFinding).join(', '),
      )
      return
    }
    if (built.kind === 'oversize') {
      deps.logger.warn(
        'dsh-memory: the review skipped a round because the newest message is %s bytes and maxInputBytes is %s',
        String(built.bytes),
        String(review.maxInputBytes),
      )
      return
    }
    if (built.kind === 'empty') {
      deps.logger.debug('dsh-memory: the review found no user or assistant text to review')
      return
    }
    const llm = deps.llm()
    if (llm === undefined) {
      deps.logger.warn('dsh-memory: the review skipped a round because no LLM service is registered')
      return
    }
    // The attempt is recorded **before** the call, so a round that dies inside
    // it still counts against the session's budget (DESIGN §4.7).
    state.runs += 1
    try {
      await persist(state, file, true)
    } catch {
      state.runs -= 1
      deps.logger.warn('dsh-memory: the review did not call the model because its attempt could not be recorded')
      return
    }
    const signal = active.controller.signal
    let output = ''
    let failure: unknown = null
    const timer = setTimeout(() => {
      active.controller.abort(
        new ReviewError('REVIEW_TIMEOUT', `the review did not finish within ${String(review.timeoutMs)} ms`),
      )
    }, review.timeoutMs)
    try {
      const call = await llm.prepareCall({ ...route, maxTokens: review.maxOutputTokens }, signal)
      const messages: Message[] = [
        createUserMessage({
          content: [{ type: 'text', text: built.text }],
          source: { kind: 'memory-review' },
        }),
      ]
      const options: GenerateOptions = {
        ...call.config,
        messages,
        system: REVIEW_SYSTEM,
        signal,
      }
      signal.throwIfAborted()
      // The log-only record of the exact request, appended after preparation
      // succeeded and immediately before dispatch (DESIGN §4.7).
      const request: MemoryReviewRequestEventData = {
        route: { provider: call.config.provider, model: call.config.model },
        system: REVIEW_SYSTEM,
        messages,
        maxTokens: call.config.maxTokens ?? review.maxOutputTokens,
        ...call.config.reasoningEffort === undefined ? {} : { reasoningEffort: call.config.reasoningEffort },
      }
      agent.session.append('memory/review-request', request)
      for await (const chunk of call.stream(options)) {
        signal.throwIfAborted()
        if (chunk.type === 'text-delta') output += chunk.text
      }
      signal.throwIfAborted()
    } catch (error) {
      failure = error
    } finally {
      clearTimeout(timer)
    }
    // Past this point the call happened, so the accumulation is spent whatever
    // the outcome was (DESIGN §4.7: a failed round does not redo the same pile).
    state.consumedCompleted += state.turns
    state.turns = 0
    if (failure !== null) {
      state.lastOutcome = `failed:${failureCode(failure)}`
      await persist(state, file, false)
      deps.logger.warn('dsh-memory: the turn-end review failed (%s)', describeError(failure))
      return
    }
    try {
      const operations = parseReviewOutput(output)
      const staged = await stageRound(operations, scope, sessionId)
      state.lastOutcome = `staged:${String(staged.ids.length)}`
      await persist(state, file, false)
      deps.logger.debug(
        'dsh-memory: the review staged %s operation(s) from %s message(s), %s excerpt byte(s)',
        String(staged.ids.length),
        String(built.messages),
        String(built.excerptBytes),
      )
      const redacted = staged.redacted.length === 0 ? '' : ` (redacted: ${staged.redacted.join(', ')})`
      // A round that proposed nothing staged nothing, so there is no user-facing
      // event to announce (DESIGN §4.7 announces what was staged).
      if (staged.ids.length > 0) {
        notify(
          agent,
          `Turn-end review staged ${String(staged.ids.length)} update(s)${redacted}; read them with /memory pending, then /memory approve <id>.`,
        )
      }
    } catch (error) {
      state.lastOutcome = `failed:${failureCode(error)}`
      await persist(state, file, false)
      deps.logger.warn(
        'dsh-memory: the review discarded its proposal after %s characters (%s)',
        String(countCodePoints(output)),
        describeError(error),
      )
    }
  }

  /** The drain point: decide, then run at most one round (DESIGN §4.7). */
  const maybeReview = async (agent: ReviewAgent): Promise<void> => {
    if (stopped) return
    const review = deps.config.review
    if (!review.enabled) return
    if (activeReview !== null) {
      deps.logger.debug('dsh-memory: a review is already running; this idle leaves the accumulation alone')
      return
    }
    if (delegationDepthOf(agent) > 0) return
    if (isPresetExcluded(deps.config, presetOf(agent))) {
      deps.logger.debug('dsh-memory: the session preset is excluded, so the review stays out')
      return
    }
    // The signal is the runner's startup service, read live, not the profile
    // name: an alias profile that mounts the headless rows is headless too
    // (T15). `includeHeadless` is the only way to admit such a run.
    if (!review.includeHeadless && deps.isHeadless?.() === true) {
      deps.logger.debug('dsh-memory: a headless run does not run the review by default')
      return
    }
    const sessionId = agent.session.id
    if (sessionId === undefined || sessionId === '') {
      deps.logger.warn('dsh-memory: the review needs a session id to record its attempts')
      return
    }
    const state = countersFor(sessionId)
    if (state.turns < review.everyTurns) return
    if (state.loaded && state.runs >= review.maxRunsPerSession) {
      deps.logger.debug('dsh-memory: the review has no attempt left for this session')
      return
    }
    // Claimed synchronously, before the first await: a second idle emitted in
    // the same turn cannot start a second round (DESIGN §4.7).
    const controller = new AbortController()
    let settle!: () => void
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const active: ActiveReview = { agent, controller, settled, settle }
    activeReview = active
    try {
      await runRound(agent, sessionId, state, active)
    } finally {
      activeReview = null
      active.settle()
    }
  }

  return {
    observe(session, event) {
      if (stopped) return
      const type = (event as { readonly type?: unknown } | null | undefined)?.type
      if (type !== 'turn/end') return
      const reason = (event as { readonly data?: unknown }).data
      const kind =
        typeof reason === 'object' && reason !== null
          ? (reason as { readonly reason?: { readonly kind?: unknown } }).reason?.kind
          : undefined
      if (kind !== 'completed') return
      if (session.id === undefined || session.id === '') return
      countersFor(session.id).turns += 1
    },
    async drain(agent) {
      try {
        await maybeReview(agent)
      } catch (error) {
        // The listener that calls this drops the promise, so it must never
        // reject — not even from the logger.
        try {
          deps.logger.warn('dsh-memory: the turn-end review failed before it could run (%s)', describeError(error))
        } catch {
          // Nothing left to report to.
        }
      }
    },
    dispose(agent) {
      if (activeReview === null || activeReview.agent !== agent) return
      activeReview.controller.abort(
        new ReviewError('REVIEW_DISPOSED', 'the agent was disposed while the review was running'),
      )
    },
    async stop() {
      const current = activeReview
      if (!stopped) stopped = true
      if (current === null) return
      current.controller.abort(
        new ReviewError('REVIEW_STOPPED', 'the plugin was disposed while the review was running'),
      )
      await current.settled
    },
  }
}

/** The short code `lastOutcome` records for one failure. */
function failureCode(error: unknown): string {
  if (error instanceof ReviewError) return error.code
  if (isMemoryError(error)) return error.code
  return 'error'
}
