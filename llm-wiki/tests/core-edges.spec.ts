/**
 * Plugin-core edge suite: the lifecycle wiring `apply` installs (the notice
 * listener's contained failure, the approval gate's deferred service lookup, the
 * working-directory lookup, and `/wiki status`'s policy line), plus the small
 * exported helpers with no other test: `presetOf`, the wiki error predicates and
 * `describeError`'s non-Error form, the `wiki_write` write predicate and prompt,
 * the notice-injection seams (cancellation, the `rev-parse` cache, a failing
 * global view), and `stripFrontmatter` without frontmatter.
 *
 * The fake context mirrors `plugin.spec.ts`, but keeps every listener per event
 * and runs them as the waterfall Cordis would, so the guard and the approval gate
 * see each other exactly as they do in the shipped plugin. `$DSH_HOME` points at
 * a temporary directory, so the plugin's own sidecar never touches a developer's
 * home.
 * @module @anago-harness/llm-wiki/tests/core-edges.spec
 */
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import type { PreToolDecision, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { presetOf, type WikiAgent } from '../src/agents.ts'
import { approvalPrompt, isWikiWriteCall } from '../src/approval.ts'
import { describeError, isWikiError, wikiError } from '../src/errors.ts'
import { apply } from '../src/index.ts'
import { createNoticeListener, injectNotice, type PreStepPayload } from '../src/inject.ts'
import { createWikiRootCache } from '../src/inspect.ts'
import { stripFrontmatter } from '../src/skill.ts'
import {
  cleanupTempDirs,
  fakeAgent,
  fakeApproval,
  fakeContext,
  fakeInvocation,
  fakeToolCall,
  gitAvailable,
  initRepo,
  recordingLogger,
  scaffoldWiki,
  tempDir,
  tempGlobalState,
  userMessage,
  wikiConfig,
  writePage,
} from './support.ts'

const hasGit = gitAvailable()

afterAll(cleanupTempDirs)

let savedHome: string | undefined

beforeAll(async () => {
  savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = await tempDir('dsh-wiki-home-')
})

afterAll(() => {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
})

/** One `tools/pre-execute` or `agent/pre-step` listener as `apply` registers it. */
type Listener = (payload: unknown, next: () => Promise<unknown>) => unknown

/** A fake context recording what `apply` registers and what it logs. */
interface Harness {
  readonly ctx: Context
  readonly tools: ToolDefinition[]
  readonly skills: SkillRegistration[]
  readonly commands: CommandDefinition[]
  readonly warnings: string[]
  /** Run one event through its listeners in registration order, then the terminal. */
  emit<Result>(event: string, payload: unknown, terminal: () => Promise<Result>): Promise<Result>
  /** How many listeners one event name has. */
  listenerCount(event: string): number
}

/** Build the harness; `services` answers `ctx.get(name)`. */
function createHarness(services: Record<string, unknown> = {}): Harness {
  const tools: ToolDefinition[] = []
  const skills: SkillRegistration[] = []
  const commands: CommandDefinition[] = []
  const listeners = new Map<string, Listener[]>()
  const warnings: string[] = []
  const format = (message: string, args: readonly unknown[]): string => `${message} ${args.join(' ')}`.trim()
  const ctx = fakeContext({
    tools: {
      register: (definition: ToolDefinition) => {
        tools.push(definition)
        return () => {}
      },
    },
    skills: {
      register: (skill: SkillRegistration) => {
        skills.push(skill)
        return () => {}
      },
    },
    commands: {
      register: (definition: CommandDefinition) => {
        commands.push(definition)
        return () => {}
      },
    },
    logger: {
      warn: (message: string, ...args: unknown[]) => {
        warnings.push(format(message, args))
      },
      debug: () => {},
    },
    on: (event: string, listener: Listener) => {
      const list = listeners.get(event)
      if (list === undefined) listeners.set(event, [listener])
      else list.push(listener)
      return () => {}
    },
    get: (name: string) => services[name],
  })
  return {
    ctx,
    tools,
    skills,
    commands,
    warnings,
    listenerCount: event => listeners.get(event)?.length ?? 0,
    emit: async <Result>(event: string, payload: unknown, terminal: () => Promise<Result>) => {
      const list = listeners.get(event) ?? []
      const run = async (index: number): Promise<unknown> => {
        const listener = list[index]
        if (listener === undefined) return await terminal()
        return await Promise.resolve(listener(payload, () => run(index + 1)))
      }
      return (await run(0)) as Result
    },
  }
}

/** One pre-step payload for a fake agent. */
function stepPayload(
  agent: unknown,
  messages: readonly UserMessage[],
  options: { step?: number; signal?: AbortSignal } = {},
): PreStepPayload {
  return {
    agent: agent as WikiAgent,
    messages,
    turn: 1,
    step: options.step ?? 2,
    signal: options.signal ?? new AbortController().signal,
  }
}

/** The allow decision `next()` produces in the policy tests. */
async function allow(): Promise<PreToolDecision> {
  return { kind: 'allow' }
}

describe('apply: the registered listeners (DESIGN §6.1, §6.6)', () => {
  it('forwards a contained notice failure to the context logger (S8)', async () => {
    const harness = createHarness()
    apply(harness.ctx, wikiConfig())
    expect(harness.listenerCount('agent/pre-step')).toBe(1)
    const claimed = userMessage('hello')
    const agent = {
      session: {
        header: { cwd: '/nonexistent' },
        deriveMessages: () => {
          throw new Error('surface unavailable')
        },
      },
    }
    const decision: PreStepDecision = { kind: 'enter', messages: [claimed] }
    const result = await harness.emit(
      'agent/pre-step',
      { agent, messages: [claimed], turn: 1, step: 2, signal: new AbortController().signal },
      async () => decision,
    )
    // The listener returns what `next()` decided and only warns: an exception
    // here would end the turn.
    expect(result).toBe(decision)
    expect(harness.warnings.join('\n')).toMatch(/could not be injected/u)
  })

  it('asks a wiki_write through the approval service the context registers', async () => {
    const harness = createHarness({ approval: fakeApproval({ policy: 'ask' }) })
    apply(harness.ctx, wikiConfig({ writeApproval: 'ask' }))
    const call = fakeToolCall('wiki_write', { path: 'pages/alpha.md', content: '# alpha\n' })
    const decision = await harness.emit('tools/pre-execute', call, allow)
    expect(decision.kind).toBe('ask')
    const asked = decision as Extract<PreToolDecision, { kind: 'ask' }>
    expect(asked.reason).toContain('pages/alpha.md')
    expect(asked.displayReason?.en).toContain('pages/alpha.md')
    expect(asked.displayReason?.ja).toContain('pages/alpha.md')
  })

  it('resolves a relative write path through the context working directory', async () => {
    const base = await tempDir('dsh-wiki-core-wd-')
    const ensureCalls: unknown[] = []
    const harness = createHarness({
      workingDirectory: {
        ensure: async (agent: unknown) => {
          ensureCalls.push(agent)
          return base
        },
      },
    })
    apply(harness.ctx, wikiConfig())
    // The base holds no wiki, so the guard finds nothing to protect and only the
    // relative-path resolution is exercised.
    const call = fakeToolCall('write', { file_path: '.dsh/wiki/raw/topic/next.md' }, fakeAgent({ cwd: base }))
    expect(await harness.emit('tools/pre-execute', call, allow)).toEqual({ kind: 'allow' })
    expect(ensureCalls).toHaveLength(1)
  })

  it('reports the effective approval policy in /wiki status', async () => {
    const harness = createHarness({ approval: fakeApproval({ policy: 'never' }) })
    apply(harness.ctx, wikiConfig({ writeApproval: 'ask' }))
    const handler = harness.commands[0]?.handler
    if (handler === undefined) throw new Error('no command handler')
    const result = await handler(fakeInvocation(fakeAgent({ cwd: await tempDir('dsh-wiki-core-status-') }), 'status'))
    expect(result.kind).toBe('success')
    const text = result.kind === 'success' ? result.text : ''
    expect(text).toContain('approval policy now: never')
    expect(text).toContain('WIKI_APPROVAL_UNAVAILABLE')
  })
})

describe('agents (DESIGN §6.2)', () => {
  it('reads the agent preset a session recorded', () => {
    expect(presetOf(fakeAgent({ agentPreset: 'minimal' }))).toBe('minimal')
  })

  it('reports no preset for a session composed without one', () => {
    expect(presetOf(fakeAgent({}))).toBeUndefined()
  })
})

describe('errors', () => {
  it('recognizes the wiki refusals and nothing else', () => {
    const refusal = wikiError('WIKI_IO', 'the disk went away')
    expect(isWikiError(refusal)).toBe(true)
    expect(isWikiError(new Error('WIKI_IO: the disk went away'))).toBe(false)
    expect(isWikiError('WIKI_IO')).toBe(false)
    // The message format is what a transcript shows after `Error: `.
    expect(refusal.message).toBe('WIKI_IO: the disk went away')
    expect(refusal.code).toBe('WIKI_IO')
  })

  it('describes a thrown value by its message, or its string form', () => {
    expect(describeError(new Error('the tool failed'))).toBe('the tool failed')
    expect(describeError('the tool failed')).toBe('the tool failed')
    expect(describeError(17)).toBe('17')
  })
})

describe('the wiki_write predicate and prompt (DESIGN §6.4)', () => {
  it('accepts only a wiki_write that names a path and carries content or an edit', () => {
    expect(isWikiWriteCall({ name: 'write', arguments: { path: 'pages/a.md', content: 'x' } })).toBe(false)
    expect(isWikiWriteCall({ name: 'wiki_write', arguments: 'not an object' })).toBe(false)
    expect(isWikiWriteCall({ name: 'wiki_write', arguments: null })).toBe(false)
    expect(isWikiWriteCall({ name: 'wiki_write', arguments: {} })).toBe(false)
    expect(isWikiWriteCall({ name: 'wiki_write', arguments: { path: 7, content: 'x' } })).toBe(false)
    expect(isWikiWriteCall({ name: 'wiki_write', arguments: { path: '  ', content: 'x' } })).toBe(false)
    expect(isWikiWriteCall({ name: 'wiki_write', arguments: { path: 'pages/a.md' } })).toBe(false)
    expect(isWikiWriteCall({ name: 'wiki_write', arguments: { path: 'pages/a.md', edit: null } })).toBe(false)
    expect(isWikiWriteCall({ name: 'wiki_write', arguments: { path: 'pages/a.md', content: '# a\n' } })).toBe(true)
    expect(
      isWikiWriteCall({ name: 'wiki_write', arguments: { path: 'pages/a.md', edit: { old_text: 'a', new_text: 'b' } } }),
    ).toBe(true)
  })

  it('names the target in the prompt and falls back when the call has no path', () => {
    const prompt = approvalPrompt({ arguments: { path: 'pages/alpha.md' } })
    expect(prompt.reason).toContain('pages/alpha.md')
    expect(prompt.displayReason.en).toContain('pages/alpha.md')
    expect(prompt.displayReason.ja).toContain('pages/alpha.md')
    for (const args of [{}, { path: 7 }]) {
      const fallback = approvalPrompt({ arguments: args })
      expect(fallback.reason).toContain('a wiki file')
      expect(fallback.displayReason.en).toContain('a wiki file')
      expect(fallback.displayReason.ja).toContain('a wiki file')
    }
  })
})

describe('stripFrontmatter (DESIGN §6.1)', () => {
  it('leaves Markdown without frontmatter untouched', () => {
    expect(stripFrontmatter('# LLM wiki\n\nBody.\n')).toBe('# LLM wiki\n\nBody.\n')
  })

  it('strips CRLF frontmatter and the spaces after the closing fence', () => {
    expect(stripFrontmatter('---\r\nname: llm-wiki\r\n---  \r\n\r\n# Body\r\n')).toBe('# Body\r\n')
  })

  it('strips a frontmatter block that ends the file', () => {
    expect(stripFrontmatter('---\nname: llm-wiki\n---')).toBe('')
  })
})

describe('injectNotice edges (DESIGN §6.6)', () => {
  it('records why a session with no cwd gets no notice', async () => {
    const logger = recordingLogger()
    const claimed = userMessage('hello')
    const decision: PreStepDecision = { kind: 'enter', messages: [claimed] }
    const result = await injectNotice(stepPayload(fakeAgent({}), [claimed]), decision, {
      config: wikiConfig(),
      logger,
    })
    expect(result).toBe(decision)
    expect(logger.debugLines.join('\n')).toMatch(/recorded no cwd/u)
  })

  it.skipIf(!hasGit)('uses the turn signal and the plugin cache for the inspection', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha' })
    const cache = createWikiRootCache()
    const controller = new AbortController()
    const claimed = userMessage('what does the wiki say?')
    const result = await injectNotice(
      stepPayload(fakeAgent({ cwd: root }), [claimed], { signal: controller.signal }),
      { kind: 'enter', messages: [claimed] },
      { config: wikiConfig(), logger: recordingLogger(), cache, signal: controller.signal },
    )
    expect(result.kind).toBe('enter')
    if (result.kind !== 'enter') throw new Error('unreachable')
    expect(result.messages).toHaveLength(2)
    expect(result.messages[1]?.source.kind).toBe('llm-wiki')
    // The answer came through the cache the plugin shares between steps.
    expect(cache.entries.has(root)).toBe(true)
  })

  it.skipIf(!hasGit)('leaves the global count out when the global view cannot be read', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const designated = await tempDir('dsh-wiki-core-global-')
    const { state } = await tempGlobalState({
      sidecar: { path: designated },
      // The git seam is the injected one: every command fails, so the global
      // repository cannot be inspected and the notice must still go out.
      run: async () => {
        throw new Error('the git seam failed')
      },
    })
    const logger = recordingLogger()
    const claimed = userMessage('hello')
    const result = await injectNotice(stepPayload(fakeAgent({ cwd: root }), [claimed]), { kind: 'enter', messages: [claimed] }, {
      config: wikiConfig(),
      logger,
      global: state,
    })
    expect(result.kind).toBe('enter')
    if (result.kind !== 'enter') throw new Error('unreachable')
    expect(result.messages).toHaveLength(2)
    const summary = (result.messages[1]?.source as { summary?: string }).summary ?? ''
    expect(summary).toContain('LLM wiki: project 0 pages.')
    expect(summary).not.toMatch(/global/u)
    expect(logger.debugLines.join('\n')).toMatch(/global wiki page count failed/u)
  })
})

describe('the notice listener and cancellation (DESIGN §6.6, S8)', () => {
  it('leaves a step alone when the turn was already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const claimed = userMessage('hello')
    const decision: PreStepDecision = { kind: 'enter', messages: [claimed] }
    const listener = createNoticeListener({ config: wikiConfig(), logger: recordingLogger() })
    const result = await listener(stepPayload(fakeAgent({ cwd: '/nonexistent' }), [claimed], { signal: controller.signal }), async () => decision)
    // `next()` still runs; only the notice is skipped.
    expect(result).toBe(decision)
  })

  it('rethrows a cancellation that happens during the injection', async () => {
    const controller = new AbortController()
    const claimed = userMessage('hello')
    const agent = {
      session: {
        header: { cwd: '/nonexistent' },
        deriveMessages: () => {
          controller.abort()
          throw new Error('surface unavailable')
        },
      },
    }
    const listener = createNoticeListener({ config: wikiConfig(), logger: recordingLogger() })
    // An aborted turn must not be reported as a step: the cancellation surfaces.
    await expect(
      listener(stepPayload(agent, [claimed], { signal: controller.signal }), async () => ({
        kind: 'enter',
        messages: [claimed],
      })),
    ).rejects.toThrow(/surface unavailable/u)
  })
})
