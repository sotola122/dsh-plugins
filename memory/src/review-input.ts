/**
 * The transcript excerpt the turn-end review sends (DESIGN §4.7, §9).
 *
 * The excerpt is the recent conversation as the model saw it —
 * `session.deriveMessages()`, walked **newest first** — but only the two things
 * a memory proposal can be grounded in: a direct human prompt
 * (`source.kind === 'user'`) and assistant body text (`source.kind === 'model'`,
 * `text` blocks). Tool results, injected snapshots, notices, and developer
 * messages are material the model already consumed; sending them would spend
 * the budget without adding a fact worth remembering.
 *
 * Two bounds are the design's:
 *
 * - `maxInputBytes` caps the excerpt. A message that does not fit is **not**
 *   cut: older messages are left out, and when the newest message alone does
 *   not fit, the round is skipped rather than shortened (S23's rule, §4.7).
 * - The current entries are attached **outside** that byte budget, so the model
 *   can name an existing entry in `old_text` (§4.7: the current entry and
 *   `system` are outside this byte count).
 *
 * The assembled text then goes through `knowledge-common`'s {@link scanText}
 * before it is sent. A secret becomes `[REDACTED:<kind>]` and is reported; a
 * **refusal is a refusal** — unlike `scanSearchHit`, which drops a refused
 * field silently, this module returns `kind: 'refused'` and the caller skips
 * the round instead of sending partly-sanitized text.
 *
 * Everything here is pure except the `deriveMessages()` read and the store
 * reads the caller already performed, so the budget, the ordering, and the
 * scan are unit-testable without a Context or an LLM.
 * @module @anago-harness/memory/review-input
 */

import { Buffer } from 'node:buffer'
import type { LlmCallConfig, Message, ReasoningEffortId, UserMessage } from '@deepseek-ai/dsh-llm'
import { type MemoryDocument, type ScanFinding, type SecretKind, scanText } from '@anago-harness/knowledge-common'
import type { MemorySessionHeader } from './agents.ts'
import { displayPath, type MemoryTarget, type StoreLocation } from './store.ts'

/** Exact log-only record of one review request, appended before dispatch. */
export interface MemoryReviewRequestEventData {
  /** Resolved provider and model the prepared call dispatches to. */
  readonly route: { readonly provider: string; readonly model: string }
  /** Exact system prompt sent with the request. */
  readonly system: string
  /** Exact message list sent with the request. */
  readonly messages: Message[]
  /** Exact output-token cap sent with the request. */
  readonly maxTokens: number
  /** Resolved reasoning effort, present when the prepared call carries one. */
  readonly reasoningEffort?: ReasoningEffortId
}

/** The session facts the review reads (DESIGN §4.7). */
export interface ReviewSession {
  /** The session identity; the review sidecar is keyed by its digest. */
  readonly id?: string
  /** Durable creation metadata: delegation depth, preset, working directory. */
  readonly header: MemorySessionHeader
  /** The current model-visible history; the excerpt is taken from its tail. */
  deriveMessages(): readonly Message[]
  /**
   * The route of the last logged request (S24). The review uses the
   * conversation's own route, so this is the fallback when the agent carries no
   * explicit provider/model.
   */
  requestHeader?(): { readonly config?: LlmCallConfig } | undefined
  /**
   * Append the review's exact request to the session log. The review calls
   * this immediately before dispatch.
   * @param type - the log-only review request event.
   * @param data - the exact request.
   * @returns the committed event, or a test fake's record of it.
   */
  append(type: 'memory/review-request', data: MemoryReviewRequestEventData): unknown
}

/** The agent view this module needs; the real `Agent` satisfies it. */
export interface ReviewAgent {
  /** The live session whose conversation is reviewed. */
  readonly session: ReviewSession
  /** The conversation's route (DESIGN §4.7: `agent.options` first). */
  readonly options?: {
    /** Registered provider route, when the agent pinned one. */
    readonly provider?: string
    /** Model id, when the agent pinned one. */
    readonly model?: string
  }
  /**
   * Queue model-facing context without waking the driver (`agent.inject`,
   * DESIGN §4.7's notice). Absent only in a test that does not watch notices.
   */
  inject?(message: UserMessage): void
}

/** One store as the prompt shows it: where it lives and what it holds now. */
export interface ReviewStoreView {
  /** Which store this is. */
  readonly target: MemoryTarget
  /** Its location, for the heading and the limit. */
  readonly location: StoreLocation
  /** Its parsed contents, for the numbered entry list. */
  readonly document: MemoryDocument
}

/** What the assembled excerpt came to. */
export type ReviewInputResult =
  | {
    /** The text to send, already scanned and with secrets redacted. */
    readonly kind: 'ok'
    /** One message of the request: the excerpt plus the current entries. */
    readonly text: string
    /** UTF-8 bytes the transcript excerpt itself took (entries excluded). */
    readonly excerptBytes: number
    /** How many messages contributed to the excerpt. */
    readonly messages: number
    /** Secret kinds the scan replaced before the text was accepted. */
    readonly redacted: readonly SecretKind[]
  }
  /** The conversation holds no user prompt or assistant text to review. */
  | { readonly kind: 'empty' }
  /** The newest message alone exceeds the budget; the round is skipped. */
  | { readonly kind: 'oversize'; readonly bytes: number }
  /** The §9 scan refused the assembled text; the round is skipped. */
  | { readonly kind: 'refused'; readonly findings: readonly ScanFinding[] }

/**
 * The line a refusal detail renders as, shared with the memory entry scan.
 * @param finding - the rule that refused the text and its bounded detail.
 * @returns the rule name alone when the detail is empty, else `rule: detail`.
 */
export function describeFinding(finding: ScanFinding): string {
  return finding.detail === '' ? finding.rule : `${finding.rule}: ${finding.detail}`
}

/**
 * Render one message as an excerpt chunk, or `null` when it is not part of the
 * conversation the review reads (DESIGN §4.7).
 * @param message - one derived message.
 * @returns the chunk, or null for tool results, injected context, and empty text.
 */
export function transcriptChunk(message: Message): string | null {
  const kind = message.source.kind
  const label = kind === 'user' ? 'User' : kind === 'model' ? 'Assistant' : null
  if (label === null) return null
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
  }
  const text = parts.join('\n').trim()
  if (text === '') return null
  return `${label}:\n${text}`
}

/**
 * Compose the one request message: the excerpt, then the current entries
 * (DESIGN §4.7).
 *
 * The wording avoids the shapes the §9 scan refuses (frame tags, chat-template
 * tokens, instruction-override phrasings, response-language directives), or the
 * review could never send its own template.
 * @param chunks - the excerpt chunks, oldest first.
 * @param stores - the stores whose entries the model may address.
 * @returns the assembled text, before the scan.
 */
export function composeReviewInput(
  chunks: readonly string[],
  stores: readonly ReviewStoreView[],
): string {
  const lines = [
    'Conversation excerpt (oldest first; user prompts and assistant replies only).',
    '',
    chunks.join('\n\n'),
    '',
    'Current entries of the persistent memory stores. patch and remove match old_text inside exactly one of these entries.',
  ]
  for (const store of stores) {
    lines.push(`## ${store.target} (${displayPath(store.location)})`)
    if (store.document.entries.length === 0) {
      lines.push('(no entries)')
      continue
    }
    for (const [index, entry] of store.document.entries.entries()) {
      lines.push(`${String(index + 1)}. ${entry}`)
    }
  }
  return lines.join('\n')
}

/** Inputs for {@link buildReviewInput}. */
export interface ReviewInputOptions {
  /** The agent whose conversation is reviewed. */
  readonly agent: ReviewAgent
  /** The stores, in the order the prompt lists them. */
  readonly stores: readonly ReviewStoreView[]
  /** `review.maxInputBytes`. */
  readonly maxInputBytes: number
}

/**
 * Build the scanned request text (DESIGN §4.7, §9).
 *
 * The walk is newest-first so the budget keeps the most recent material; the
 * chunks are reversed back into reading order afterwards. The scan is applied
 * to the finished text — excerpt and entries together — because the model
 * receives both.
 * @param options - the agent, the stores, and the byte budget.
 * @returns the text to send, or why the round is skipped.
 */
export function buildReviewInput(options: ReviewInputOptions): ReviewInputResult {
  const messages = options.agent.session.deriveMessages()
  const chunks: string[] = []
  let excerptBytes = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    const chunk = transcriptChunk(message)
    if (chunk === null) continue
    const size = Buffer.byteLength(chunk, 'utf8')
    if (excerptBytes + size > options.maxInputBytes) {
      // The newest message alone does not fit: there is nothing to trim down to.
      if (chunks.length === 0) return { kind: 'oversize', bytes: size }
      break
    }
    chunks.push(chunk)
    excerptBytes += size
  }
  if (chunks.length === 0) return { kind: 'empty' }
  chunks.reverse()
  const scan = scanText(composeReviewInput(chunks, options.stores))
  if (!scan.ok) return { kind: 'refused', findings: scan.findings }
  return {
    kind: 'ok',
    text: scan.text,
    excerptBytes,
    messages: chunks.length,
    redacted: scan.redacted,
  }
}
