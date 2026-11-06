/**
 * Plugin-entry edge cases left by `plugin.spec.ts`: a non-idle status never
 * starts a review, disposing an agent aborts its in-flight round through the
 * wired `agent/disposed` listener, and the headless fallback rejects an empty
 * or non-string profile name. Also covers the approval predicate's tolerance of
 * an invocation that carries no argument object.
 * @module @anago-harness/memory/tests/plugin-edges
 */
import { readFileSync } from 'node:fs'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRestriction } from '@deepseek-ai/dsh-tools'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isMemoryWriteCall } from '../src/approval.ts'
import { apply, isHeadlessRun } from '../src/index.ts'
import { reviewSidecarPath } from '../src/review.ts'
import {
  cleanupTempDirs,
  type DshHome,
  fakeAgentRegistry,
  fakeContext,
  fakeReviewAgent,
  type FakeAgentRegistry,
  memoryConfig,
  useDshHome,
  userMessage,
  type WiredListener,
} from './support.ts'

const homes: DshHome[] = []

afterEach(() => {
  // Reverse order: a test that redirects twice must end on the value the file
  // started with, not on a temporary directory that cleanup removes.
  for (const home of homes.splice(0).reverse()) home.restore()
})
afterAll(cleanupTempDirs)

// No test may reach the developer's real harness home.
beforeEach(async () => {
  homes.push(await useDshHome())
})

/** Substitute the placeholders a Cordis logger would, so the suite reads real lines. */
function formatLog(message: string, args: readonly unknown[]): string {
  let index = 0
  return message.replace(/%[so]/gu, () => (index < args.length ? String(args[index++]) : ''))
}

interface Harness {
  readonly ctx: Context
  readonly warnings: string[]
  readonly listeners: Map<string, WiredListener>
  /** The counted holds `apply` takes on an agent whose review it drains. */
  readonly agents: FakeAgentRegistry
}

/** A fake context with the seams `apply` touches. */
function createHarness(options: { readonly llm?: unknown } = {}): Harness {
  const warnings: string[] = []
  const listeners = new Map<string, WiredListener>()
  const agents = fakeAgentRegistry()
  const tools = {
    register: (_definition: ToolDefinition) => () => {},
    restrict: (_filter: ToolRestriction) => () => {},
  }
  const ctx = fakeContext({
    tools,
    agents,
    commands: { register: (_definition: CommandDefinition) => () => {} },
    logger: {
      warn: (message: string, ...args: unknown[]) => {
        warnings.push(formatLog(message, args))
      },
      debug: () => {},
    },
    on: (event: string, listener: WiredListener) => {
      listeners.set(event, listener)
      return () => {}
    },
    effect: (body: () => unknown) => {
      void body()
      return () => {}
    },
    get: (key: string) => {
      if (key === 'tools') return tools
      if (key === 'llm') return options.llm
      return undefined
    },
  })
  return { ctx, warnings, listeners, agents }
}

/** Wait until a condition holds, bounded so a broken test fails instead of hanging. */
async function waitUntil(predicate: () => boolean, description: string, rounds = 400): Promise<void> {
  for (let index = 0; index < rounds && !predicate(); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  if (!predicate()) throw new Error(`the condition was not reached: ${description}`)
}

/** An LLM stub that answers every prepared call with no operations. */
function reviewLlm(calls: unknown[]): unknown {
  return {
    prepareCall: async (config: unknown) => {
      calls.push(config)
      return {
        config,
        stream: () =>
          (async function* generate() {
            yield { type: 'text-delta', index: 0, text: '{"operations":[]}' }
          })(),
      }
    },
  }
}

/** An LLM stub whose stream waits until the round's signal is aborted. */
function hangingReviewLlm(calls: unknown[]): unknown {
  return {
    prepareCall: async (config: unknown) => {
      calls.push(config)
      return {
        config,
        stream: async function* generate(options: { readonly signal?: AbortSignal }) {
          if (options.signal !== undefined && !options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal?.addEventListener('abort', () => { resolve() }, { once: true })
            })
          }
          options.signal?.throwIfAborted()
        },
      }
    },
  }
}

/** Fire one event through a listener the plugin wired. */
function emit(harness: Harness, event: string, payload: unknown): void {
  harness.listeners.get(event)?.(payload)
}

/** Record one completed turn for an agent, as the session event carries it. */
function completeTurn(harness: Harness, agent: ReturnType<typeof fakeReviewAgent>): void {
  // `session/event` takes the session and the event, not one payload object.
  harness.listeners.get('session/event')
    ?.(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
}

/** Wait for a sidecar outcome, reading it as the review would. */
async function waitForOutcome(sessionId: string, expected: string): Promise<void> {
  const file = reviewSidecarPath(sessionId)
  const read = (): string | undefined => {
    try {
      const state = JSON.parse(readFileSync(file, 'utf8')) as { readonly lastOutcome?: unknown }
      return typeof state.lastOutcome === 'string' ? state.lastOutcome : undefined
    } catch {
      return undefined
    }
  }
  await waitUntil(() => read() === expected, `the review outcome ${expected}`)
}

describe('agent/status wiring', () => {
  it('leaves the accumulation alone for a status that is not idle', async () => {
    const calls: unknown[] = []
    const harness = createHarness({ llm: reviewLlm(calls) })
    apply(harness.ctx, memoryConfig({ review: { everyTurns: 1 } }))
    const agent = fakeReviewAgent({
      id: 'session-not-idle',
      provider: 'test-provider',
      model: 'test-model',
      history: [userMessage('hello')],
    })
    completeTurn(harness, agent)
    emit(harness, 'agent/status', { agent, status: 'running' })
    // One macrotask boundary: a dispatched round would have prepared its call by then.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toHaveLength(0)
    expect(() => readFileSync(reviewSidecarPath('session-not-idle'), 'utf8')).toThrow()
  })

  it('skips the review and reports when the agent can no longer be held', async () => {
    const calls: unknown[] = []
    const harness = createHarness({ llm: reviewLlm(calls) })
    apply(harness.ctx, memoryConfig({ review: { everyTurns: 1 } }))
    const agent = fakeReviewAgent({
      id: 'session-dead-hold',
      provider: 'test-provider',
      model: 'test-model',
      history: [userMessage('hello')],
    })
    // The registry refuses a hold for an agent that already left it.
    harness.agents.dispose(agent)
    completeTurn(harness, agent)
    emit(harness, 'agent/status', { agent, status: 'idle' })
    await waitUntil(
      () => harness.warnings.some(line => line.includes('skipped an agent that is no longer live')),
      'the hold refusal report',
    )
    // Nothing was dispatched, and the refused hold left no count behind.
    expect(calls).toHaveLength(0)
    expect(harness.agents.holds(agent)).toBe(0)
    expect(harness.agents.released).toEqual([])
  })
})

describe('agent/disposed wiring', () => {
  it('aborts the in-flight review of the disposed agent', async () => {
    const calls: unknown[] = []
    const harness = createHarness({ llm: hangingReviewLlm(calls) })
    apply(harness.ctx, memoryConfig({ review: { everyTurns: 1 } }))
    const agent = fakeReviewAgent({
      id: 'session-disposed',
      provider: 'test-provider',
      model: 'test-model',
      history: [userMessage('hello')],
    })
    completeTurn(harness, agent)
    emit(harness, 'agent/status', { agent, status: 'idle' })
    await waitUntil(() => calls.length === 1, 'the review call')
    emit(harness, 'agent/disposed', { agent })
    await waitForOutcome('session-disposed', 'failed:REVIEW_DISPOSED')
    await waitUntil(
      () => harness.warnings.some(line => line.includes('the turn-end review failed')),
      'the disposed round report',
    )
  })

  it('is inert for an agent with no running review', () => {
    const harness = createHarness({ llm: reviewLlm([]) })
    apply(harness.ctx, memoryConfig())
    const agent = fakeReviewAgent({ id: 'session-idle-dispose' })
    expect(() => {
      emit(harness, 'agent/disposed', { agent })
    }).not.toThrow()
    expect(harness.warnings).toEqual([])
  })
})

describe('headless fallback', () => {
  /** A context whose only seam the detector reads is `get`. */
  const contextWith = (services: Record<string, unknown>): Context =>
    fakeContext({ get: (key: string) => services[key] })

  it('does not treat an empty or non-string profile name as headless', () => {
    expect(isHeadlessRun(contextWith({ profileContext: { name: '' } }))).toBe(false)
    expect(isHeadlessRun(contextWith({ profileContext: { name: 42 } }))).toBe(false)
  })
})

describe('the approval predicate', () => {
  it('refuses to classify an invocation whose arguments are not an object', () => {
    expect(isMemoryWriteCall({ name: 'memory', arguments: null })).toBe(false)
    expect(isMemoryWriteCall({ name: 'memory', arguments: 'operations' })).toBe(false)
    expect(
      isMemoryWriteCall({ name: 'memory', arguments: { operations: [{ op: 'add', text: 'x' }] } }),
    ).toBe(true)
  })
})
