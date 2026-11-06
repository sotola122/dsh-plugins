/**
 * The existence notice's pre-step listener (DESIGN §6.6).
 *
 * Registered on `agent/pre-step` and running **after** `next()`, exactly like
 * `dsh-memory`'s snapshot injection (S10), so the decision the rest of the
 * chain produced is never disturbed:
 *
 * 1. A rejected step (`kind !== 'enter'`) is left alone.
 * 2. `payload.step === 1` with an empty claim is the runtime-context-only
 *    warm-up batch; inserting there would open a model call the loop
 *    deliberately did not open (S7).
 * 3. The notice is **visible** when a `user/message` whose `source.kind` is
 *    `llm-wiki` is claimed in this batch or still on the derived surface. A
 *    resume restores it; a compaction that shadowed it removes it, and then the
 *    next step re-injects — which is the behaviour the design wants from the
 *    same test `dsh-memory` uses, and it makes the notice self-healing rather
 *    than a one-shot that can be lost.
 * 4. The insertion point is directly after the last claimed message, so the
 *    notice sits before the runtime-context block.
 *
 * The listener never throws: an exception from a pre-step listener ends the
 * turn (S8), so every failure is contained and only warned about. Cancellation
 * is the one exception — an aborted turn must not be reported as a step.
 * @module @anago-harness/llm-wiki/inject
 */

import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { appendClaimedMessage } from '@anago-harness/knowledge-common'
import { cwdOf, type WikiAgent } from './agents.ts'
import type { WikiConfig } from './config.ts'
import { describeError } from './errors.ts'
import type { GlobalWikiState } from './global.ts'
import { inspectWiki, type WikiRootCache } from './inspect.ts'
import { countPages } from './lint.ts'
import { createNoticeMessage, isNoticeMessage } from './notice.ts'

/** A logger, narrowed to the two levels this module uses. */
export interface WikiLogger {
  /** A recoverable problem: the notice is skipped and nothing else happens. */
  warn(message: string, ...args: unknown[]): void
  /** Normal, expected conditions, such as "this directory has no wiki". */
  debug(message: string, ...args: unknown[]): void
}

/** The pre-step payload this module reads (S6). */
export interface PreStepPayload {
  /** The agent proposing the step. */
  readonly agent: WikiAgent
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
export interface NoticeDeps {
  /** Resolved plugin configuration; `notice: false` turns the injection off. */
  readonly config: WikiConfig
  /** Where recoverable problems go. */
  readonly logger: WikiLogger
  /** The global wiki's state, so the notice can carry its page count (§6.6). */
  readonly global?: GlobalWikiState
  /** Cancellation for the filesystem work; the turn's signal when there is one. */
  readonly signal?: AbortSignal
  /** The plugin's `rev-parse` memo. */
  readonly cache?: WikiRootCache
}

/**
 * Whether the notice is already visible to the model (DESIGN §6.6).
 *
 * Two places count, exactly as in `dsh-memory`'s snapshot test: the batch about
 * to be admitted, and the derived history after every `surfaceOp`.
 * @param agent - the agent proposing the step.
 * @param messages - the messages the step would admit.
 * @returns true when a wiki notice is visible.
 * @throws when the session cannot derive its messages; the caller skips injection.
 */
export function isNoticeVisible(
  agent: WikiAgent,
  messages: readonly { readonly source: { readonly kind: string } }[],
): boolean {
  if (messages.some(isNoticeMessage)) return true
  const derived = agent.session.deriveMessages?.()
  if (derived === undefined) return false
  return derived.some(message => message.role === 'user' && isNoticeMessage(message))
}

/**
 * Decide whether one step admits the notice (DESIGN §6.6).
 * @param payload - the proposed step.
 * @param decision - what `next()` produced.
 * @param deps - configuration, logger, cancellation, and the cache.
 * @returns the decision, with the notice inserted when the design says so.
 */
export async function injectNotice(
  payload: PreStepPayload,
  decision: PreStepDecision,
  deps: NoticeDeps,
): Promise<PreStepDecision> {
  if (decision.kind !== 'enter') return decision
  if (!deps.config.notice) return decision
  const claimed = decision.messages.filter(message => payload.messages.includes(message))
  if (payload.step === 1 && claimed.length === 0) return decision
  if (isNoticeVisible(payload.agent, decision.messages)) return decision
  const cwd = cwdOf(payload.agent)
  if (cwd === undefined) {
    deps.logger.debug('dsh-llm-wiki: the session recorded no cwd, so there is no wiki to announce')
    return decision
  }
  const inspection = await inspectWiki({
    cwd,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    ...(deps.cache === undefined ? {} : { cache: deps.cache }),
  })
  if (inspection.kind !== 'found') {
    deps.logger.debug('dsh-llm-wiki: %s', inspection.detail)
    return decision
  }
  for (const warning of inspection.warnings) deps.logger.warn('dsh-llm-wiki: %s', warning)
  const message = createNoticeMessage(
    inspection,
    await countPagesSafely(inspection.root.wikiRoot, deps.logger),
    await globalPagesSafely(payload.agent, deps),
  )
  return appendClaimedMessage(payload.messages, decision, message)
}

/** Count the pages for the notice, containing every failure to a zero. */
async function countPagesSafely(wikiRoot: string, logger: WikiLogger): Promise<number> {
  let pages = 0
  try {
    pages = await countPages(wikiRoot)
  } catch (error) {
    /* v8 ignore next -- `countPages` fails only when the page directory cannot be listed, and the count is advisory. */
    logger.debug('dsh-llm-wiki: the page count of %s failed (%s)', wikiRoot, describeError(error))
  }
  return pages
}

/**
 * The global wiki's page count for the notice (DESIGN §6.6).
 *
 * `undefined` — the notice then says nothing about a global wiki — covers every
 * way the global half can be off: no repository designated, a rejected one, a
 * session whose cwd overlaps it, and a page count that could not be read. The
 * count is only a number on the line, so a failure is not worth a warning.
 */
async function globalPagesSafely(
  agent: WikiAgent,
  deps: NoticeDeps,
): Promise<number | undefined> {
  if (deps.global === undefined) return undefined
  try {
    const view = await deps.global.forAgent(agent)
    if (view.kind !== 'found') return undefined
    return await countPages(view.repo.repoRoot, deps.global.pagesDir)
  } catch (error) {
    deps.logger.debug('dsh-llm-wiki: the global wiki page count failed (%s)', describeError(error))
    return undefined
  }
}

/**
 * Build the global `agent/pre-step` listener (DESIGN §6.6).
 *
 * The listener never throws: a failure inside {@link injectNotice} is logged and
 * the decision is returned unchanged, because a listener exception ends the turn
 * (S8). Cancellation is the one exception.
 * @param deps - configuration, logger, and the cache.
 * @returns the listener to register with `ctx.on('agent/pre-step', listener)`.
 */
export function createNoticeListener(
  deps: NoticeDeps,
): (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision> {
  return async (payload, next) => {
    const decision = await next()
    if (payload.signal.aborted) return decision
    try {
      return await injectNotice(payload, decision, { ...deps, signal: payload.signal })
    } catch (error) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort during the await
      if (payload.signal.aborted) throw error
      deps.logger.warn('dsh-llm-wiki: the wiki notice could not be injected (%s)', describeError(error))
      return decision
    }
  }
}
