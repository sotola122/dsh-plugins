/**
 * Edge-case suite for the transcript excerpt the turn-end review sends: the
 * documented formatting of a refusal finding, and the walk over a derived
 * history that carries a gap (DESIGN §4.7, §9).
 * @module @anago-harness/memory/tests/review-input-edges
 */
import type { Message } from '@deepseek-ai/dsh-llm'
import { afterAll, describe, expect, it } from 'vitest'
import { buildReviewInput, describeFinding } from '../src/review-input.ts'
import { cleanupTempDirs, fakeReviewAgent, userMessage } from './support.ts'

afterAll(async () => {
  await cleanupTempDirs()
})

describe('describeFinding', () => {
  it('renders the rule alone when the finding carries no detail', () => {
    expect(describeFinding({ rule: 'frame-tag', detail: '' })).toBe('frame-tag')
  })

  it('renders the rule and its detail otherwise', () => {
    expect(describeFinding({ rule: 'frame-tag', detail: '<memory-snapshot>' })).toBe(
      'frame-tag: <memory-snapshot>',
    )
  })
})

describe('buildReviewInput over a gapped history', () => {
  it('skips a missing entry instead of failing the walk', () => {
    const history: Message[] = [userMessage('the kept message')]
    // A history array may carry a hole where a message used to be; the walk
    // reads it as "nothing to render" rather than as a message.
    history.length = 3
    const agent = fakeReviewAgent({ history })
    const result = buildReviewInput({ agent, stores: [], maxInputBytes: 4096 })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.messages).toBe(1)
    expect(result.text).toContain('the kept message')
  })
})
