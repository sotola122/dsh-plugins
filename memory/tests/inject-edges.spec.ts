/**
 * Injection edges (DESIGN §4.2, S8): the paths the truth-table suite leaves —
 * a store file with nothing to show, a step with no cancellation signal, the
 * workspace skip reasons that only a real repository can produce, a failing log
 * sink, the one-line description a log line gives a non-Error failure, and the
 * two cancellation points of the listener.
 * @module @anago-harness/memory/tests/inject-edges
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { describeError } from '../src/errors.ts'
import {
  collectInjectableSections,
  createPreStepListener,
  type MemoryLogger,
  readInjectableStore,
} from '../src/inject.ts'
import { globalStore } from '../src/store.ts'
import {
  cleanupTempDirs,
  type DshHome,
  fakeAgent,
  type FakeAgent,
  git,
  gitAvailable,
  initRepo,
  memoryConfig,
  memoryStorePath,
  recordingLogger,
  type RecordingLogger,
  useDshHome,
  userMessage,
  writeRawFile,
  writeStoreFile,
} from './support.ts'

const hasGit = gitAvailable()
const signal = new AbortController().signal
const homes: DshHome[] = []

afterEach(() => {
  for (const home of homes.splice(0)) home.restore()
})
afterAll(cleanupTempDirs)

/** A harness home whose global notes store holds one entry per argument. */
async function globalFixture(entries: readonly string[]): Promise<void> {
  const home = await useDshHome()
  homes.push(home)
  await writeStoreFile(memoryStorePath(home.home), [...entries])
}

/** Run the real listener with one proposed step. */
async function run(options: {
  agent: FakeAgent
  messages?: readonly UserMessage[]
  decision?: PreStepDecision
  logger?: RecordingLogger
  signal?: AbortSignal
}): Promise<{ decision: PreStepDecision; logger: RecordingLogger }> {
  const logger = options.logger ?? recordingLogger()
  const listener = createPreStepListener({ config: memoryConfig({}), logger })
  const messages = [...(options.messages ?? [])]
  const decision = options.decision ?? { kind: 'enter', messages: [...messages] }
  return {
    logger,
    decision: await listener(
      { agent: options.agent, messages, turn: 1, step: 1, signal: options.signal ?? signal },
      async () => decision,
    ),
  }
}

/** The inserted memory message of one decision, or undefined. */
function inserted(decision: PreStepDecision): UserMessage | undefined {
  if (decision.kind !== 'enter') return undefined
  return decision.messages.find(message => message.source.kind === 'memory')
}

/** A logger that records every line and fails its first `warn` call. */
function failingSink(): { logger: MemoryLogger; lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    logger: {
      warn: (message, ...args) => {
        let index = 0
        lines.push(message.replace(/%s/gu, () => String(args[index++])))
        if (lines.length === 1) throw new Error('the log sink is gone')
      },
      debug: () => {},
    },
  }
}

describe('stores with nothing to show', () => {
  it('treats a store file that holds only its header comment as empty', async () => {
    const home = await useDshHome()
    homes.push(home)
    await writeRawFile(memoryStorePath(home.home), '<!-- notes for later -->\n\n')
    expect(await readInjectableStore(globalStore('memory', 2200))).toBeNull()

    const result = await run({ agent: fakeAgent({}), messages: [userMessage('hello')] })
    expect(inserted(result.decision)).toBeUndefined()
    expect(result.logger.warnings).toEqual([])
  })
})

describe.skipIf(!hasGit)('workspace store skip reasons', () => {
  it('reads the workspace store when no cancellation signal is supplied', async () => {
    homes.push(await useDshHome())
    const root = await initRepo()
    await writeFile(path.join(root, '.gitignore'), '.dsh/\n')
    await writeStoreFile(path.join(root, '.dsh', 'memory', 'MEMORY.md'), ['workspace note'])

    const logger = recordingLogger()
    const sections = await collectInjectableSections(fakeAgent({ cwd: root }), {
      config: memoryConfig({}),
      logger,
    })
    expect(sections.map(section => section.rendered.name)).toEqual(['workspace-memory'])
    expect(sections[0]?.rendered.entries).toEqual(['workspace note'])
    expect(logger.warnings).toEqual([])
  })

  it('warns instead of injecting when git already tracks the workspace store', async () => {
    homes.push(await useDshHome())
    const root = await initRepo()
    await mkdir(path.join(root, '.dsh', 'memory'), { recursive: true })
    await writeFile(path.join(root, '.dsh', 'memory', 'MEMORY.md'), 'tracked\n')
    git(root, ['add', '-f', '.dsh/memory/MEMORY.md'])

    const result = await run({
      agent: fakeAgent({ cwd: root }),
      messages: [userMessage('hello')],
    })
    expect(inserted(result.decision)).toBeUndefined()
    expect(result.logger.warnings.join('\n')).toMatch(/git already tracks 1 file\(s\)/u)
  })

  it('warns that the workspace store is not ignored before its first write', async () => {
    homes.push(await useDshHome())
    const root = await initRepo()

    const result = await run({
      agent: fakeAgent({ cwd: root }),
      messages: [userMessage('hello')],
    })
    expect(inserted(result.decision)).toBeUndefined()
    expect(result.logger.warnings.join('\n')).toMatch(/is not ignored by git/u)
  })

  it('keeps the step alive when the log sink fails while skipping an unreadable store', async () => {
    homes.push(await useDshHome())
    const root = await initRepo()
    await writeFile(path.join(root, '.gitignore'), '.dsh/\n')
    // A directory where the store belongs: reading it fails, the per-store
    // containment reports it, and the sink refuses that report.
    await mkdir(path.join(root, '.dsh', 'memory', 'MEMORY.md'), { recursive: true })

    const sink = failingSink()
    const listener = createPreStepListener({ config: memoryConfig({}), logger: sink.logger })
    const message = userMessage('hello')
    const decision: PreStepDecision = { kind: 'enter', messages: [message] }
    const result = await listener(
      { agent: fakeAgent({ cwd: root }), messages: [message], turn: 1, step: 1, signal },
      async () => decision,
    )
    expect(result).toBe(decision)
    expect(sink.lines).toHaveLength(2)
    expect(sink.lines[0]).toMatch(/skipped .*MEMORY\.md for the snapshot/u)
    expect(sink.lines[1]).toMatch(/skipped the workspace store/u)
  })
})

describe('failure descriptions', () => {
  it('describes a thrown value that is not an Error in one line', () => {
    // A warning line is built from any thrown value, including one a third-party
    // seam rejected with, so the report never renders as "[object Object]".
    expect(describeError('git is gone')).toBe('git is gone')
    expect(describeError(3)).toBe('3')
    expect(describeError(new Error('the store is gone'))).toBe('the store is gone')
  })
})

describe('cancellation (S8)', () => {
  it('returns the decision untouched for a turn cancelled before the step', async () => {
    await globalFixture(['a note'])
    const controller = new AbortController()
    controller.abort()
    const logger = recordingLogger()
    const listener = createPreStepListener({ config: memoryConfig({}), logger })
    const message = userMessage('hello')
    const decision: PreStepDecision = { kind: 'enter', messages: [message] }
    let delegated = 0
    const result = await listener(
      { agent: fakeAgent({}), messages: [message], turn: 1, step: 1, signal: controller.signal },
      async () => {
        delegated += 1
        return decision
      },
    )
    expect(result).toBe(decision)
    // The earlier listener still ran, and no store was consulted afterwards.
    expect(delegated).toBe(1)
    expect(logger.debugLines).toEqual([])
    expect(logger.warnings).toEqual([])
  })

  it('rethrows when the turn is cancelled while the snapshot is being decided', async () => {
    await globalFixture(['a note'])
    const controller = new AbortController()
    const cancelled: FakeAgent = {
      history: [],
      session: {
        header: {},
        deriveMessages: () => {
          controller.abort()
          throw new Error('the session projection is gone')
        },
      },
    }
    const logger = recordingLogger()
    const listener = createPreStepListener({ config: memoryConfig({}), logger })
    const message = userMessage('hello')
    await expect(
      listener(
        { agent: cancelled, messages: [message], turn: 1, step: 1, signal: controller.signal },
        async () => ({ kind: 'enter', messages: [message] }),
      ),
    ).rejects.toThrow('the session projection is gone')
    // The cancellation is not contained: it is a cancelled turn, not a skipped store.
    expect(logger.warnings).toEqual([])
  })
})
