/**
 * Plugin-entry suite: metadata, the config schema's defaults and rejections,
 * the three registrations `apply` performs, the headless decision (T15), and
 * the subagent restriction with its failure containment (DESIGN §4.4, §4.2,
 * §4.1).
 * @module @anago-harness/memory/tests/plugin
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRestriction } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { apply, Config, inject, isHeadlessRun, name } from '../src/index.ts'
import { reviewSidecarPath } from '../src/review.ts'
import {
  cleanupTempDirs,
  type DshHome,
  fakeAgent,
  fakeAgentRegistry,
  fakeApproval,
  fakeContext,
  fakeExec,
  fakeInvocation,
  fakeReviewAgent,
  type FakeAgentRegistry,
  memoryConfig,
  memoryStorePath,
  pendingRootOf,
  readStoreFile,
  recordingLogger,
  useDshHome,
  userMessage,
  type WiredListener,
  writeStoreFile,
} from './support.ts'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const homes: DshHome[] = []

afterAll(async () => {
  // Reverse order: a test that redirects twice must end on the value the file
  // started with, not on a temporary directory that cleanup removes.
  for (const home of homes.splice(0).reverse()) home.restore()
  await cleanupTempDirs()
})

// No test may reach the developer's real harness home: `$DSH_HOME` points at a
// temporary directory for every test, asked for or not.
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
  readonly registered: ToolDefinition[]
  readonly commands: CommandDefinition[]
  readonly restrictions: ToolRestriction[]
  readonly warnings: string[]
  readonly debugs: string[]
  readonly listeners: Map<string, WiredListener>
  /** Disposers `apply` registered through `ctx.effect`, in registration order. */
  readonly disposers: (() => unknown)[]
  /** The counted holds `apply` takes on an agent whose review it drains. */
  readonly agents: FakeAgentRegistry
}

/** A fake context with the seams `apply` touches. */
function createHarness(
  options: {
    restrictThrows?: boolean
    tools?: boolean
    approval?: ReturnType<typeof fakeApproval>
    services?: boolean
    llm?: unknown
    agents?: FakeAgentRegistry
    /** Whether the shipped headless startup row published its service. */
    headlessStartup?: boolean
    /** `profileContext.name`; undefined means no profile context at all. */
    profileName?: string
  } = {},
): Harness {
  const registered: ToolDefinition[] = []
  const commands: CommandDefinition[] = []
  const restrictions: ToolRestriction[] = []
  const warnings: string[] = []
  const debugs: string[] = []
  const disposers: (() => unknown)[] = []
  const listeners = new Map<string, WiredListener>()
  const agents = options.agents ?? fakeAgentRegistry()
  const tools = {
    register: (definition: ToolDefinition) => {
      registered.push(definition)
      return () => {}
    },
    restrict: (filter: ToolRestriction) => {
      if (options.restrictThrows === true) throw new Error('unknown tool name')
      restrictions.push(filter)
      return () => {}
    },
  }
  const ctx = fakeContext({
    tools,
    agents,
    commands: {
      register: (definition: CommandDefinition) => {
        commands.push(definition)
        return () => {}
      },
    },
    logger: {
      warn: (message: string, ...args: unknown[]) => {
        warnings.push(formatLog(message, args))
      },
      debug: (message: string, ...args: unknown[]) => {
        debugs.push(formatLog(message, args))
      },
    },
    on: (event: string, listener: WiredListener) => {
      listeners.set(event, listener)
      return () => {}
    },
    effect: (body: () => unknown) => {
      const disposer = body()
      if (typeof disposer === 'function') disposers.push(disposer as () => unknown)
      return () => {}
    },
    get: (key: string) => {
      if (options.services === false) return undefined
      if (key === 'tools' && options.tools !== false) return tools
      if (key === 'approval') return options.approval
      if (key === 'llm') return options.llm
      if (key === 'headlessStartup') {
        return options.headlessStartup === true ? { task: 'integration task', json: false } : undefined
      }
      if (key === 'profileContext') {
        return options.profileName === undefined ? undefined : { name: options.profileName }
      }
      return undefined
    },
  })
  return { ctx, registered, commands, restrictions, warnings, debugs, listeners, disposers, agents }
}

/** An agent whose scoped context answers the tool-registry lookup. */
function agentAtDepth(depth: number, tools: unknown): Agent {
  return {
    session: { header: { delegationDepth: depth }, id: 'session-test' },
    ctx: { get: (key: string) => (key === 'tools' ? tools : undefined) },
  } as Agent
}

/** Wait until a condition holds, bounded so a broken test fails instead of hanging. */
async function waitUntil(predicate: () => boolean, description: string, rounds = 400): Promise<void> {
  for (let index = 0; index < rounds && !predicate(); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  if (!predicate()) throw new Error(`the condition was not reached: ${description}`)
}

/** An LLM stub that records each prepared call and answers with no operations. */
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
function hangingReviewLlm(calls: unknown[], signals: AbortSignal[]): unknown {
  return {
    prepareCall: async (config: unknown) => {
      calls.push(config)
      return {
        config,
        stream: async function* generate(options: { readonly signal?: AbortSignal }) {
          if (options.signal !== undefined) signals.push(options.signal)
          if (options.signal !== undefined && !options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal?.addEventListener('abort', () =>{  resolve() }, { once: true })
            })
          }
          options.signal?.throwIfAborted()
        },
      }
    },
  }
}

/**
 * An LLM stub whose stream parks on a barrier the test releases.
 *
 * The prepared call is recorded before the stream waits, so a test can observe
 * the round in flight without a timer.
 * @returns the stub and the barrier release.
 */
function gatedReviewLlm(calls: unknown[]): { readonly llm: unknown; release(): void } {
  const gate = Promise.withResolvers<undefined>()
  return {
    llm: {
      prepareCall: async (config: unknown) => {
        calls.push(config)
        return {
          config,
          stream: async function* generate(options: { readonly signal?: AbortSignal }) {
            yield { type: 'text-delta', index: 0, text: '{"operations":[]}' }
            await gate.promise
            options.signal?.throwIfAborted()
          },
        }
      },
    },
    release: () => {
      gate.resolve(undefined)
    },
  }
}

/**
 * The idle-release check the Session Controller applies to a quiescent agent,
 * reduced to the condition the review can change: `holds(agent) > 0`.
 */
function releasable(agents: FakeAgentRegistry, agent: ReturnType<typeof fakeReviewAgent>): boolean {
  return agents.holds(agent) === 0
}

/** Fire one completed turn and one idle through the harness's wired listeners. */
function idleOnce(harness: Harness, agent: ReturnType<typeof fakeReviewAgent>): void {
  const observe = harness.listeners.get('session/event')
  const status = harness.listeners.get('agent/status')
  if (observe === undefined || status === undefined) throw new Error('the review listeners are not wired')
  observe(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  // The plugin never awaits the drain; the effect is what the test waits for.
  status({ agent, status: 'idle' })
}

/**
 * Wait for the drained round to finish.
 *
 * The sidecar is the round's last write, and the runner's single-flight claim
 * is released right after it; the macrotask boundary lets that continuation run
 * before the next test starts a round of its own.
 */
async function waitForRound(agent: ReturnType<typeof fakeReviewAgent>): Promise<void> {
  const file = reviewSidecarPath(agent.session.id ?? '')
  await waitUntil(() => existsSync(file), 'the review sidecar')
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('plugin metadata', () => {
  it('declares its loader name and required services', () => {
    expect(name).toBe('memory')
    expect(inject).toEqual(['tools', 'commands', 'agents'])
  })
})

describe('Config schema', () => {
  it('defaults every field to the design value', () => {
    const config = Config({}) as ReturnType<typeof memoryConfig>
    expect(config.limits).toEqual({ memory: 2200, user: 1375, workspace: 2200 })
    expect(config.workspace).toEqual({ enabled: true, manageGitignore: true })
    expect(config.presets.exclude).toEqual([])
    expect(config.writeApproval).toBe('none')
    expect(config.pending.maxPerStore).toBe(50)
    expect(config.review).toEqual({
      enabled: true,
      everyTurns: 5,
      maxRunsPerSession: 4,
      maxInputBytes: 16384,
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      includeHeadless: false,
    })
    expect(config.lockWaitMs).toBe(5000)
  })

  it('rejects a writeApproval the design does not define', () => {
    expect(() => Config({ writeApproval: 'sometimes' } as never)).toThrow(/expected/u)
  })

  it('accepts the approval and review keys', () => {
    const config = Config({
      writeApproval: 'ask',
      review: { enabled: false, everyTurns: 2 },
    } as never) as ReturnType<typeof memoryConfig>
    expect(config.writeApproval).toBe('ask')
    expect(config.review.enabled).toBe(false)
    expect(config.review.everyTurns).toBe(2)
  })
})

describe('headless detection (T15)', () => {
  /** A context whose only seam the detector reads is `get`. */
  const contextWith = (services: Record<string, unknown>): Context =>
    fakeContext({ get: (key: string) => services[key] })

  it('keys on the headless startup service, not on the profile name', () => {
    expect(isHeadlessRun(contextWith({ headlessStartup: { task: 't' }, profileContext: { name: 'itest' } }))).toBe(
      true,
    )
    expect(isHeadlessRun(contextWith({ profileContext: { name: 'web' } }))).toBe(false)
  })

  it('falls back to the shipped profile name when the service is absent', () => {
    // A future DSH may rename the service; the shipped profile keeps the
    // design's default exclusion.
    expect(isHeadlessRun(contextWith({ profileContext: { name: 'headless' } }))).toBe(true)
  })

  it('treats neither signal as a non-headless run', () => {
    // No profile context at all is the design's "do not exclude" case, and an
    // unclassifiable profile must not be excluded either.
    expect(isHeadlessRun(contextWith({ profileContext: { name: 'web' } }))).toBe(false)
    expect(isHeadlessRun(contextWith({}))).toBe(false)
  })
})

describe('apply', () => {
  it('registers the tool, the command, and the six listeners', () => {
    const harness = createHarness()
    apply(harness.ctx, memoryConfig())
    expect(harness.registered.map(tool => tool.name)).toEqual(['memory'])
    expect(harness.commands.map(command => command.name)).toEqual(['memory'])
    expect(harness.commands[0]?.input?.hint).toContain('approve')
    expect([...harness.listeners.keys()].sort()).toEqual([
      'agent/created',
      'agent/disposed',
      'agent/pre-step',
      'agent/status',
      'session/event',
      'tools/pre-execute',
    ])
  })

  it('drains the review through the wired session/event and agent/status listeners', async () => {
    const calls: unknown[] = []
    const harness = createHarness({ llm: reviewLlm(calls) })
    apply(harness.ctx, memoryConfig({ review: { everyTurns: 1 } }))
    const agent = fakeReviewAgent({
      provider: 'test-provider',
      model: 'test-model',
      history: [userMessage('hello')],
    })
    idleOnce(harness, agent)
    await waitUntil(() => calls.length === 1, 'the review call')
    await waitForRound(agent)
    expect(calls).toHaveLength(1)
  })

  it('registers one disposer that aborts the in-flight review and refuses later rounds', async () => {
    const calls: unknown[] = []
    const signals: AbortSignal[] = []
    const harness = createHarness({ llm: hangingReviewLlm(calls, signals) })
    apply(harness.ctx, memoryConfig({ review: { everyTurns: 1 } }))
    const agent = fakeReviewAgent({
      provider: 'test-provider',
      model: 'test-model',
      history: [userMessage('hello')],
    })
    idleOnce(harness, agent)
    await waitUntil(() => calls.length === 1, 'the review call')
    expect(harness.disposers).toHaveLength(1)
    await harness.disposers[0]?.()
    expect(signals[0]?.aborted).toBe(true)
    // The fiber is disposed: a later idle must not dispatch another request.
    const later = fakeReviewAgent({
      id: 'session-after-dispose',
      provider: 'test-provider',
      model: 'test-model',
      history: [userMessage('hello again')],
    })
    idleOnce(harness, later)
    expect(calls).toHaveLength(1)
    expect(existsSync(reviewSidecarPath(later.session.id ?? ''))).toBe(false)
  })

  it('holds the agent while the review runs and releases it when the round settles', async () => {
    const calls: unknown[] = []
    const released = Promise.withResolvers<undefined>()
    const agents = fakeAgentRegistry(() => { released.resolve(undefined) })
    const gated = gatedReviewLlm(calls)
    const harness = createHarness({ llm: gated.llm, agents })
    apply(harness.ctx, memoryConfig({ review: { everyTurns: 1 } }))
    const agent = fakeReviewAgent({
      provider: 'test-provider',
      model: 'test-model',
      history: [userMessage('hello')],
    })
    idleOnce(harness, agent)
    await waitUntil(() => calls.length === 1, 'the review call')
    // The agent went idle and the round is in flight: only the hold keeps an
    // idle release from disposing the agent the round still reads.
    expect(harness.agents.holds(agent)).toBe(1)
    expect(releasable(harness.agents, agent)).toBe(false)
    gated.release()
    await released.promise
    expect(harness.agents.holds(agent)).toBe(0)
    expect(releasable(harness.agents, agent)).toBe(true)
    expect(harness.agents.released).toEqual([agent])
  })

  it('releases the hold when the plugin unloads during a review', async () => {
    const calls: unknown[] = []
    const signals: AbortSignal[] = []
    const harness = createHarness({ llm: hangingReviewLlm(calls, signals) })
    apply(harness.ctx, memoryConfig({ review: { everyTurns: 1 } }))
    const agent = fakeReviewAgent({
      id: 'session-unload-hold',
      provider: 'test-provider',
      model: 'test-model',
      history: [userMessage('hello')],
    })
    idleOnce(harness, agent)
    await waitUntil(() => calls.length === 1, 'the review call')
    expect(harness.agents.holds(agent)).toBe(1)
    // Unload aborts the round and waits for the drain, so the hold is gone by
    // the time the disposer settles.
    await harness.disposers[0]?.()
    expect(harness.agents.holds(agent)).toBe(0)
    expect(harness.agents.released).toEqual([agent])
  })

  it('keeps the review out of a headless run even when the profile name is not headless', async () => {
    const calls: unknown[] = []
    const harness = createHarness({ llm: reviewLlm(calls), headlessStartup: true, profileName: 'itest' })
    apply(harness.ctx, memoryConfig({ review: { everyTurns: 1, includeHeadless: false } }))
    const agent = fakeReviewAgent({
      provider: 'test-provider',
      model: 'test-model',
      history: [userMessage('hello')],
    })
    idleOnce(harness, agent)
    // The exclusion logs its decision; the call must never be prepared.
    await waitUntil(
      () => harness.debugs.some(line => line.includes('headless run does not run the review')),
      'the headless exclusion',
    )
    expect(calls).toHaveLength(0)
  })

  it('admits a headless run when includeHeadless is true', async () => {
    const calls: unknown[] = []
    const harness = createHarness({ llm: reviewLlm(calls), headlessStartup: true, profileName: 'itest' })
    apply(harness.ctx, memoryConfig({ review: { everyTurns: 1, includeHeadless: true } }))
    const agent = fakeReviewAgent({
      provider: 'test-provider',
      model: 'test-model',
      history: [userMessage('hello')],
    })
    idleOnce(harness, agent)
    await waitUntil(() => calls.length === 1, 'the review call')
    await waitForRound(agent)
    expect(calls).toHaveLength(1)
  })

  it('runs for an alias profile when no headless service is mounted', async () => {
    const calls: unknown[] = []
    const harness = createHarness({ llm: reviewLlm(calls), profileName: 'itest' })
    apply(harness.ctx, memoryConfig({ review: { everyTurns: 1, includeHeadless: false } }))
    const agent = fakeReviewAgent({
      provider: 'test-provider',
      model: 'test-model',
      history: [userMessage('hello')],
    })
    idleOnce(harness, agent)
    await waitUntil(() => calls.length === 1, 'the review call')
    await waitForRound(agent)
    expect(calls).toHaveLength(1)
  })

  it('wires /memory to the plugin configuration', async () => {
    const home = await useDshHome()
    homes.push(home)
    await writeStoreFile(memoryStorePath(home.home), ['a note'])
    const harness = createHarness()
    apply(harness.ctx, memoryConfig())
    const handler = harness.commands[0]?.handler
    if (handler === undefined) throw new Error('no command handler')
    const result = await handler(fakeInvocation(fakeAgent({}), 'show memory'))
    expect(result.kind).toBe('success')
    expect(result.kind === 'success' ? result.text : '').toContain('1. a note')
  })

  it('asks through the wired pre-execute listener under an ask policy', async () => {
    await useDshHome()
    const harness = createHarness({ approval: fakeApproval({ policy: 'ask' }) })
    apply(harness.ctx, memoryConfig({ writeApproval: 'ask' }))
    const listener = harness.listeners.get('tools/pre-execute')
    if (listener === undefined) throw new Error('no pre-execute listener')
    const decision = await listener(
      {
        name: 'memory',
        arguments: { target: 'memory', operations: [{ op: 'add', text: 'x' }] },
        agent: fakeAgent({}),
      },
      async () => ({ kind: 'allow' }),
    )
    expect((decision as { kind: string }).kind).toBe('ask')
  })

  it('stages the write the pre-execute listener allowed under never', async () => {
    const home = await useDshHome()
    homes.push(home)
    const harness = createHarness({ approval: fakeApproval({ policy: 'never' }) })
    apply(harness.ctx, memoryConfig({ writeApproval: 'ask' }))
    const listener = harness.listeners.get('tools/pre-execute')
    const tool = harness.registered[0]
    if (listener === undefined || tool === undefined) throw new Error('nothing was registered')
    const agent = fakeAgent({})
    const args = { target: 'memory', operations: [{ op: 'add', text: 'staged through the plugin' }] }
    // The pipeline hands one execution object to the policy chain and to the
    // tool body (S16), so the wiring test does the same.
    const exec = fakeExec(agent, undefined, args)
    type Listener = (exec: unknown, next: () => Promise<unknown>) => Promise<{ kind: string }>
    const decision = await (listener as Listener)(exec, async () => ({ kind: 'allow' }))
    expect(decision.kind).toBe('allow')
    const value = (await tool.execute(args, exec)) as { status: string; staged?: string[] }
    expect(value.status).toBe('staged')
    expect(value.staged).toHaveLength(1)
    // Nothing reached the store; the pending file did.
    expect(await readStoreFile(memoryStorePath(home.home)).catch(() => '')).toBe('')
    const pending = `${pendingRootOf(home.home)}/memory/${value.staged?.[0] ?? ''}.json`
    expect(await readStoreFile(pending)).toContain('staged through the plugin')
    // And the tool the harness registered is the real one.
    expect(tool.name).toBe('memory')
    expect(withFileLock).toBeTypeOf('function')
    expect(writeFileAtomic).toBeTypeOf('function')
    expect(recordingLogger().warnings).toEqual([])
  })

  it('inserts a snapshot through the registered pre-step callback', async () => {
    const home = await useDshHome()
    homes.push(home)
    await writeStoreFile(memoryStorePath(home.home), ['wired note'])
    const harness = createHarness()
    apply(harness.ctx, memoryConfig())
    const listener = harness.listeners.get('agent/pre-step')
    if (listener === undefined) throw new Error('no pre-step listener')
    const message = userMessage('hello')
    const decision = { kind: 'enter' as const, messages: [message] }
    const result = (await listener(
      {
        agent: fakeAgent({}),
        messages: [message],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => decision,
    )) as { messages: { source: { kind: string } }[] }
    expect(result.messages).toHaveLength(2)
    expect(result.messages[1]?.source.kind).toBe('memory')
  })
})

describe('subagent restriction (DESIGN §4.4)', () => {
  it('denies the memory tool for a child, after the tool was registered', () => {
    const harness = createHarness()
    apply(harness.ctx, memoryConfig())
    const created = harness.listeners.get('agent/created')
    if (created === undefined) throw new Error('no agent/created listener')
    created({ agent: agentAtDepth(1, harness.ctx.get('tools')), source: 'startup' })
    expect(harness.restrictions).toEqual([{ deny: ['memory'] }])
    expect(harness.warnings).toEqual([])
  })

  it('leaves a top-level agent alone', () => {
    const harness = createHarness()
    apply(harness.ctx, memoryConfig())
    const created = harness.listeners.get('agent/created')
    if (created === undefined) throw new Error('no agent/created listener')
    created({ agent: agentAtDepth(0, harness.ctx.get('tools')), source: 'startup' })
    expect(harness.restrictions).toEqual([])
  })

  it('warns instead of failing agent creation when restrict throws', () => {
    const harness = createHarness({ restrictThrows: true })
    apply(harness.ctx, memoryConfig())
    const created = harness.listeners.get('agent/created')
    if (created === undefined) throw new Error('no agent/created listener')
    expect(() => created({ agent: agentAtDepth(1, harness.ctx.get('tools')), source: 'startup' })).not.toThrow()
    expect(harness.warnings.join('\n')).toMatch(/could not restrict memory/u)
    expect(harness.warnings.join('\n')).toMatch(/MEMORY_READ_ONLY/u)
  })

  it('warns when the child scope has no tool registry', () => {
    const harness = createHarness()
    apply(harness.ctx, memoryConfig())
    const created = harness.listeners.get('agent/created')
    if (created === undefined) throw new Error('no agent/created listener')
    created({ agent: agentAtDepth(1, undefined), source: 'startup' })
    expect(harness.warnings.join('\n')).toMatch(/no tool registry/u)
    expect(harness.restrictions).toEqual([])
  })
})
