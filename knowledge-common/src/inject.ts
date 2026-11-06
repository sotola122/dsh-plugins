/**
 * Message insertion shared by the memory and wiki pre-step listeners.
 *
 * Both plugins append their injected notice after the last message the step
 * claimed, unless the same payload is already present. They own what the
 * message contains and when it is due; the placement and equality rules live
 * here once.
 * @module knowledge-common/inject
 */

import { isDeepStrictEqual } from 'node:util'

/** The message fields the deduplication test reads; an LLM message satisfies it. */
export interface PayloadMessage {
  /** The message body. */
  readonly content: unknown
  /** Where the message came from. */
  readonly source: unknown
}

/**
 * Whether two messages carry the same payload, so a second copy is redundant.
 * @param left - one message.
 * @param right - the other message.
 * @returns true when both content and source are deeply equal.
 */
export function samePayload(left: PayloadMessage, right: PayloadMessage): boolean {
  return isDeepStrictEqual(left.content, right.content) && isDeepStrictEqual(left.source, right.source)
}

/** The part of an `enter` pre-step decision this insertion rewrites. */
export interface ClaimedDecision<Message> {
  /** The messages the step would admit. */
  readonly messages: readonly Message[]
}

/**
 * Insert a message immediately after the last message the step claimed, unless
 * an equal payload is already admitted.
 * @param claimed - the messages the step removed from the inbox.
 * @param decision - the `enter` decision the rest of the chain produced.
 * @param message - the message to insert.
 * @returns the decision unchanged, or with the message inserted.
 */
export function appendClaimedMessage<
  Message extends PayloadMessage,
  Decision extends ClaimedDecision<Message>,
>(claimed: readonly Message[], decision: Decision, message: Message): Decision {
  if (decision.messages.some(existing => samePayload(existing, message))) return decision
  const lastClaimed = decision.messages.findLastIndex(existing => claimed.includes(existing))
  return { ...decision, messages: decision.messages.toSpliced(lastClaimed + 1, 0, message) }
}
