/**
 * Injection placement suite: payload equality across content and source, the
 * slot after the last claimed message, and the duplicate check that leaves an
 * already-admitted payload untouched.
 * @module knowledge-common/test/inject.test
 */
import { describe, expect, it } from 'vitest'
import { appendClaimedMessage, samePayload } from '../src/index.ts'

/** One admitted message carrying the payload fields the equality test reads. */
interface Message {
  readonly role: string
  readonly content: unknown
  readonly source: unknown
}

/** Build one message with the given payload and origin. */
function message(content: string, source = 'memory'): Message {
  return { role: 'user', content, source }
}

describe('samePayload', () => {
  it('compares both the content and the source', () => {
    expect(samePayload(message('note'), message('note'))).toBe(true)
    expect(samePayload(message('note', 'wiki'), message('note', 'memory'))).toBe(false)
    expect(samePayload(message('note'), message('other'))).toBe(false)
  })
})

describe('appendClaimedMessage', () => {
  it('inserts after the last message the step claimed', () => {
    const claimed = [message('a'), message('b')]
    const admitted = [...claimed, message('user')]
    const decision = { messages: admitted, extra: 'kept' }
    const result = appendClaimedMessage(claimed, decision, message('injected'))
    expect(result.messages.map(entry => entry.content)).toEqual(['a', 'b', 'injected', 'user'])
    expect(result.extra).toBe('kept')
  })

  it('inserts at the front when the step claimed nothing', () => {
    const result = appendClaimedMessage([], { messages: [message('user')] }, message('injected'))
    expect(result.messages.map(entry => entry.content)).toEqual(['injected', 'user'])
  })

  it('returns the decision untouched when the payload is already admitted', () => {
    const decision = { messages: [message('same'), message('user')] }
    const result = appendClaimedMessage([], decision, message('same'))
    expect(result).toBe(decision)
  })
})
