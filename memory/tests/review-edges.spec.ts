/**
 * Edge-case suite for the turn-end review: the closed parse contract, the
 * sidecar defaults, the notice bound, the failure paths of the sidecar write,
 * the staging groups, and the inert seams (DESIGN §4.7, §9).
 *
 * Everything here runs through the module's own entry points: the exported
 * parsers and formatters, and `createReviewRunner` over its injected seams (a
 * fake `ctx.llm`, an atomic-write api that fails on a chosen write, and the
 * fake agent). A real `$DSH_HOME` under `os.tmpdir()` keeps the developer's
 * harness home untouched.
 * @module @anago-harness/memory/tests/review-edges
 */
import { mkdir } from 'node:fs/promises'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { GenerateOptions, LlmCallConfig, Message, ReasoningEffortId, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AtomicWriteApi } from '@anago-harness/knowledge-common'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { MemoryConfig } from '../src/config.ts'
import { type PendingRecord, globalPendingDirectory, listPending } from '../src/pending.ts'
import {
  EMPTY_REVIEW_STATE,
  REVIEW_NOTICE_MAX_LENGTH,
  ReviewError,
  type MemoryReviewRequestEventData,
  type ReviewLlm,
  type ReviewRunner,
  boundReviewSummary,
  createReviewRunner,
  parseReviewOutput,
  parseReviewState,
  readReviewStateFile,
  reviewSidecarPath,
  stripCodeFence,
} from '../src/review.ts'
import type { ReviewAgent, ReviewSession } from '../src/review-input.ts'
import {
  type DshHome,
  type FakeReviewAgent,
  type RecordingLogger,
  cleanupTempDirs,
  exists,
  fakeReviewAgent,
  memoryConfig,
  memoryStorePath,
  recordingLogger,
  toolMessage,
  useDshHome,
  userMessage,
} from './support.ts'

const realApi: AtomicWriteApi = { withFileLock, writeFileAtomic }
const homes: DshHome[] = []
let home = ''

afterAll(async () => {
  // Reverse order: a test that redirects twice must end on the value the file
  // started with, not on a temporary directory that cleanup removes.
  for (const entry of homes.splice(0).reverse()) entry.restore()
  await cleanupTempDirs()
})

// No test may reach the developer's real harness home.
beforeEach(async () => {
  const created = await useDshHome()
  homes.push(created)
  home = created.home
})

/** One dispatched review call, as the fake LLM recorded it. */
interface RecordedCall {
  /** The config `prepareCall` received. */
  readonly config: LlmCallConfig
  /** The signal `prepareCall` received. */
  readonly signal: AbortSignal | undefined
  /** The options the prepared call's `stream` received. */
  streamOptions?: GenerateOptions
}

/** A fake `ctx.llm`. */
interface FakeLlm {
  /** The service the plugin reads. */
  readonly llm: ReviewLlm
  /** One entry per prepared call, in order. */
  readonly calls: RecordedCall[]
}

/** Build a fake `ctx.llm` that yields the chosen chunks. */
function fakeLlm(
  options: {
    output?: string
    /** The exact chunks the stream yields, in order. */
    chunks?: readonly StreamChunk[]
    /** Never finish on its own: only the signal ends the stream. */
    hang?: boolean
    prepareError?: Error
    streamError?: Error
    /** Resolve the prepared call without an output-token cap. */
    dropMaxTokens?: boolean
    /** Resolved reasoning effort the prepared call carries back. */
    reasoningEffort?: ReasoningEffortId
  } = {},
): FakeLlm {
  const calls: RecordedCall[] = []
  const llm: ReviewLlm = {
    async prepareCall(config, signal) {
      const record: RecordedCall = { config, signal }
      calls.push(record)
      if (options.prepareError !== undefined) throw options.prepareError
      const prepared: LlmCallConfig = { ...config }
      if (options.dropMaxTokens === true) delete prepared.maxTokens
      if (options.reasoningEffort !== undefined) prepared.reasoningEffort = options.reasoningEffort
      return {
        config: prepared,
        stream(streamOptions) {
          record.streamOptions = streamOptions
          return (async function* generate(): AsyncGenerator<StreamChunk> {
            if (options.streamError !== undefined) throw options.streamError
            if (options.hang === true) {
              const abort = streamOptions.signal
              if (abort !== undefined && !abort.aborted) {
                await new Promise<void>((resolve) => {
                  abort.addEventListener('abort', () => { resolve() }, { once: true })
                })
              }
              streamOptions.signal?.throwIfAborted()
              return
            }
            for (const chunk of options.chunks ?? [
              { type: 'text-delta', index: 0, text: options.output ?? '' },
            ]) {
              yield chunk
            }
          })()
        },
      }
    },
  }
  return { llm, calls }
}

/** An atomic-write api whose chosen writes fail, to exercise the sidecar guard. */
interface FlakyApi {
  /** `writeFileAtomic` and the lock, with the failure injected. */
  readonly api: AtomicWriteApi
  /** One entry per attempted write, in order. */
  readonly files: string[]
}

/** Build an api whose `writeFileAtomic` rejects when `failOn` selects the write. */
function flakyApi(failOn: (write: number) => boolean): FlakyApi {
  const files: string[] = []
  return {
    files,
    api: {
      withFileLock,
      async writeFileAtomic(file, content, options) {
        files.push(file)
        if (failOn(files.length)) throw new Error('the disk is full')
        await writeFileAtomic(file, content, options)
      },
    },
  }
}

/** Build a runner over a recording logger. */
function buildRunner(options: {
  llm: ReviewLlm | null
  config?: MemoryConfig
  api?: AtomicWriteApi
  isHeadless?: () => boolean
}): { runner: ReviewRunner; logger: RecordingLogger } {
  const logger = recordingLogger()
  const runner = createReviewRunner({
    config: options.config ?? memoryConfig({ review: { everyTurns: 1 } }),
    logger,
    api: options.api ?? realApi,
    llm: () => options.llm ?? undefined,
    ...(options.isHeadless === undefined ? {} : { isHeadless: options.isHeadless }),
  })
  return { runner, logger }
}

/** A fake review agent with a route and one human prompt, unless overridden. */
function reviewAgent(
  overrides: {
    id?: string
    history?: readonly Message[]
    headerRoute?: { readonly provider: string; readonly model: string }
    noRoute?: boolean
    injectThrows?: boolean
  } = {},
): FakeReviewAgent {
  const { noRoute, ...rest } = overrides
  return fakeReviewAgent({
    ...(noRoute === true ? {} : { provider: 'test-provider', model: 'test-model' }),
    history: [userMessage('hello')],
    ...rest,
  })
}

/** Feed `count` completed turns to the runner. */
function completeTurns(runner: ReviewRunner, session: ReviewSession, count: number): void {
  for (let index = 0; index < count; index += 1) {
    runner.observe(session, { type: 'turn/end', data: { turn: index + 1, reason: { kind: 'completed' } } })
  }
}

/** Wait until a condition holds, bounded so a broken test fails instead of hanging. */
async function waitUntil(predicate: () => boolean, rounds = 400): Promise<void> {
  for (let index = 0; index < rounds && !predicate(); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  if (!predicate()) throw new Error('the condition was not reached')
}

/** The summaries of the notices the review queued. */
function noticeSummaries(agent: FakeReviewAgent): string[] {
  return agent.injected.map((message) => {
    const source = message.source as { readonly summary?: string }
    return source.summary ?? ''
  })
}

/** Every pending operation the two global stores hold. */
async function allPending(): Promise<PendingRecord[]> {
  const { records } = await listPending([
    { target: 'memory', directory: globalPendingDirectory('memory') },
    { target: 'user', directory: globalPendingDirectory('user') },
  ])
  return records
}

/** The sidecar of one agent's session. */
async function sidecarOf(agent: FakeReviewAgent): Promise<Awaited<ReturnType<typeof readReviewStateFile>>> {
  return await readReviewStateFile(reviewSidecarPath(agent.session.id ?? ''))
}

/** Run a refusal and return the `ReviewError` it threw. */
function refusal(run: () => unknown): ReviewError {
  try {
    run()
  } catch (error) {
    if (error instanceof ReviewError) return error
    throw error
  }
  throw new Error('the call was expected to be refused')
}

describe('parseReviewState', () => {
  it('reads a document that is not a JSON object as no review state', () => {
    for (const text of ['[]', 'null', '42', '"a string"', 'true']) {
      expect(parseReviewState(text)).toEqual(EMPTY_REVIEW_STATE)
    }
  })

  it('defaults every field a hand edit left out of range', () => {
    expect(
      parseReviewState('{"reviewRuns":-1,"consumedCompleted":"3","fullNotified":"yes","lastOutcome":5}'),
    ).toEqual(EMPTY_REVIEW_STATE)
    // `1e400` parses as Infinity, which is a number but not a count.
    expect(parseReviewState('{"reviewRuns":1e400}')).toEqual(EMPTY_REVIEW_STATE)
  })

  it('floors a fractional count and keeps the recognised fields', () => {
    expect(
      parseReviewState('{"reviewRuns":2.9,"consumedCompleted":0,"fullNotified":true,"lastOutcome":"staged:1"}'),
    ).toEqual({ reviewRuns: 2, consumedCompleted: 0, fullNotified: true, lastOutcome: 'staged:1' })
  })
})

describe('parseReviewOutput', () => {
  it('refuses an empty body, fenced or not', () => {
    for (const text of ['', '   ', '```\n\n```']) {
      const error = refusal(() => parseReviewOutput(text))
      expect(error.code).toBe('REVIEW_INVALID_OUTPUT')
      expect(error.message).toMatch(/no text/u)
    }
  })

  it('refuses a JSON value that is not an object', () => {
    for (const text of ['[]', 'null', '"text"', '42']) {
      const error = refusal(() => parseReviewOutput(text))
      expect(error.code).toBe('REVIEW_INVALID_OUTPUT')
      expect(error.message).toMatch(/not a JSON object/u)
    }
  })

  it('refuses a document without an operations array', () => {
    for (const text of ['{}', '{"operations":{}}', '{"operations":null}', '{"operations":"add"}']) {
      const error = refusal(() => parseReviewOutput(text))
      expect(error.code).toBe('REVIEW_INVALID_OUTPUT')
      expect(error.message).toMatch(/operations.*must be an array/u)
    }
  })

  it('refuses an operation that is not an object', () => {
    for (const text of ['{"operations":[42]}', '{"operations":[[]]}', '{"operations":[null]}']) {
      const error = refusal(() => parseReviewOutput(text))
      expect(error.code).toBe('REVIEW_INVALID_OUTPUT')
      expect(error.message).toMatch(/operations\[0\] is not an object/u)
    }
  })

  it('refuses an operation key the review may not send', () => {
    const error = refusal(() =>
      parseReviewOutput('{"operations":[{"op":"add","target":"memory","text":"x","baseEntry":"y"}]}'),
    )
    expect(error.code).toBe('REVIEW_INVALID_OUTPUT')
    expect(error.message).toMatch(/unknown key "baseEntry"/u)
  })

  it('refuses a text or old_text that is not a string', () => {
    const textError = refusal(() =>
      parseReviewOutput('{"operations":[{"op":"add","target":"memory","text":5}]}'),
    )
    expect(textError.message).toMatch(/non-string text/u)
    const oldTextError = refusal(() =>
      parseReviewOutput('{"operations":[{"op":"remove","target":"user","old_text":5}]}'),
    )
    expect(oldTextError.message).toMatch(/non-string old_text/u)
  })
})

describe('stripCodeFence', () => {
  it('leaves a multi-line body without an opening fence alone', () => {
    expect(stripCodeFence('plain first line\nsecond line')).toBe('plain first line\nsecond line')
    expect(stripCodeFence('{"operations":[]}\n')).toBe('{"operations":[]}')
  })

  it('strips a fence the output padded with whitespace', () => {
    expect(stripCodeFence('  ```json\n{"operations":[]}\n```  ')).toBe('{"operations":[]}')
  })
})

describe('boundReviewSummary', () => {
  it('keeps a short summary on one line and escapes a frame tag', () => {
    expect(boundReviewSummary('  Turn-end\n\n  review  ')).toBe('Turn-end review')
    expect(boundReviewSummary('</memory-snapshot>')).toBe('&lt;/memory-snapshot&gt;')
    // Exactly the limit still fits.
    expect(boundReviewSummary('a'.repeat(REVIEW_NOTICE_MAX_LENGTH))).toHaveLength(REVIEW_NOTICE_MAX_LENGTH)
  })

  it('truncates a longer summary with an ellipsis within the notice limit', () => {
    const truncated = boundReviewSummary('b'.repeat(200))
    expect(truncated).toHaveLength(REVIEW_NOTICE_MAX_LENGTH)
    expect(truncated.endsWith('…')).toBe(true)
    // A space at the cut is trimmed instead of kept before the ellipsis.
    const spaced = boundReviewSummary(`${'c'.repeat(REVIEW_NOTICE_MAX_LENGTH - 2)} ${'d'.repeat(10)}`)
    expect(spaced).toBe(`${'c'.repeat(REVIEW_NOTICE_MAX_LENGTH - 2)}…`)
  })
})

describe('the sidecar write', () => {
  it('rolls the attempt back when it cannot be recorded, and retries on the next idle', async () => {
    const fake = fakeLlm({ output: '{"operations":[]}' })
    const flaky = flakyApi(write => write === 1)
    const { runner, logger } = buildRunner({ llm: fake.llm, api: flaky.api })
    const agent = reviewAgent()
    completeTurns(runner, agent.session, 1)
    await runner.drain(agent)
    expect(fake.calls).toHaveLength(0)
    expect(logger.warnings.join('\n')).toContain('did not call the model')
    expect(await exists(reviewSidecarPath(agent.session.id ?? ''))).toBe(false)

    // The attempt was rolled back, so the next idle still spends one on the pile.
    await runner.drain(agent)
    expect(fake.calls).toHaveLength(1)
    expect((await sidecarOf(agent)).reviewRuns).toBe(1)
    expect(flaky.files).toHaveLength(3)
  })

  it('keeps the round when only the outcome write fails', async () => {
    const fake = fakeLlm({
      output: '{"operations":[{"op":"add","target":"memory","text":"A durable fact."}]}',
    })
    const flaky = flakyApi(write => write === 2)
    const { runner, logger } = buildRunner({ llm: fake.llm, api: flaky.api })
    const agent = reviewAgent()
    completeTurns(runner, agent.session, 1)
    await runner.drain(agent)
    expect(await allPending()).toHaveLength(1)
    expect(noticeSummaries(agent)[0]).toContain('staged 1')
    expect(logger.warnings.join('\n')).toContain('could not be written')
    // The attempt landed before the call; the outcome line did not.
    const state = await sidecarOf(agent)
    expect(state.reviewRuns).toBe(1)
    expect(state.lastOutcome).toBeNull()
  })
})

describe('the notice', () => {
  it('stages without a notice when the agent has no inject seam', async () => {
    const fake = fakeLlm({
      output: '{"operations":[{"op":"add","target":"memory","text":"A durable fact."}]}',
    })
    const { runner } = buildRunner({ llm: fake.llm })
    const agent = reviewAgent()
    delete agent.inject
    completeTurns(runner, agent.session, 1)
    await runner.drain(agent)
    expect(await allPending()).toHaveLength(1)
    expect((await sidecarOf(agent)).lastOutcome).toBe('staged:1')
  })

  it('reports a notice that cannot be queued and keeps the staged operations', async () => {
    const fake = fakeLlm({
      output: '{"operations":[{"op":"add","target":"memory","text":"A durable fact."}]}',
    })
    const { runner, logger } = buildRunner({ llm: fake.llm })
    const agent = reviewAgent({ injectThrows: true })
    completeTurns(runner, agent.session, 1)
    await runner.drain(agent)
    expect(await allPending()).toHaveLength(1)
    expect(logger.warnings.join('\n')).toContain('notice could not be queued')
    expect((await sidecarOf(agent)).lastOutcome).toBe('staged:1')
  })
})

describe('staging', () => {
  it('groups two operations of the same store into one staged batch', async () => {
    const fake = fakeLlm({
      output: JSON.stringify({
        operations: [
          { op: 'add', target: 'memory', text: 'First fact.' },
          { op: 'add', target: 'memory', text: 'Second fact.' },
        ],
      }),
    })
    const { runner } = buildRunner({ llm: fake.llm })
    const agent = reviewAgent()
    completeTurns(runner, agent.session, 1)
    await runner.drain(agent)
    const records = await allPending()
    expect(records.map(record => record.op.text)).toEqual(['First fact.', 'Second fact.'])
    expect((await sidecarOf(agent)).lastOutcome).toBe('staged:2')
    expect(noticeSummaries(agent)[0]).toContain('staged 2')
  })

  it('reports each redacted secret kind once across the stores of one round', async () => {
    const fake = fakeLlm({
      output: JSON.stringify({
        operations: [
          { op: 'add', target: 'memory', text: 'The deploy key is sk-abcdefghijklmnopqrst' },
          { op: 'add', target: 'user', text: 'The backup key is sk-zyxwvutsrqponmlkjihg' },
        ],
      }),
    })
    const { runner } = buildRunner({ llm: fake.llm })
    const agent = reviewAgent()
    completeTurns(runner, agent.session, 1)
    await runner.drain(agent)
    const records = await allPending()
    expect(records.map(record => record.op.target).sort()).toEqual(['memory', 'user'])
    expect((await sidecarOf(agent)).lastOutcome).toBe('staged:2')
    // Both stores redacted the same kind, and the notice names it once.
    expect(noticeSummaries(agent)[0]).toContain('(redacted: api-key)')
  })
})

describe('the input branches', () => {
  it('skips a round whose history holds no reviewable text', async () => {
    const fake = fakeLlm({ output: '{"operations":[]}' })
    const { runner, logger } = buildRunner({ llm: fake.llm })
    const agent = reviewAgent({ history: [toolMessage('{"result":1}')] })
    completeTurns(runner, agent.session, 1)
    await runner.drain(agent)
    expect(fake.calls).toHaveLength(0)
    expect(logger.debugLines.join('\n')).toContain('no user or assistant text')
    expect(await exists(reviewSidecarPath(agent.session.id ?? ''))).toBe(false)
  })

  it('skips a round when no LLM service is registered', async () => {
    const { runner, logger } = buildRunner({ llm: null })
    const agent = reviewAgent()
    completeTurns(runner, agent.session, 1)
    await runner.drain(agent)
    expect(logger.warnings.join('\n')).toContain('no LLM service is registered')
    expect((await sidecarOf(agent)).reviewRuns).toBe(0)
  })
})

describe('the request', () => {
  it('falls back to the configured cap when the prepared call drops maxTokens', async () => {
    const fake = fakeLlm({ output: '{"operations":[]}', dropMaxTokens: true })
    const { runner } = buildRunner({
      llm: fake.llm,
      config: memoryConfig({ review: { everyTurns: 1, maxOutputTokens: 777 } }),
    })
    const agent = reviewAgent()
    completeTurns(runner, agent.session, 1)
    await runner.drain(agent)
    expect(fake.calls[0]?.streamOptions?.maxTokens).toBeUndefined()
    const data = agent.appended[0]?.data as MemoryReviewRequestEventData
    expect(data.maxTokens).toBe(777)
  })

  it('concatenates the text deltas and ignores the other chunks', async () => {
    const fake = fakeLlm({
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'reasoning-delta', index: 0, text: 'weighing the options' },
        { type: 'text-delta', index: 0, text: '{"operations":' },
        { type: 'text-delta', index: 0, text: '[]}' },
      ],
    })
    const { runner } = buildRunner({ llm: fake.llm })
    const agent = reviewAgent()
    completeTurns(runner, agent.session, 1)
    await runner.drain(agent)
    expect((await sidecarOf(agent)).lastOutcome).toBe('staged:0')
    expect(await allPending()).toHaveLength(0)
  })
})

describe('the route', () => {
  it('has no route when the recorded header names no provider', async () => {
    const fake = fakeLlm({ output: '{"operations":[]}' })
    const { runner, logger } = buildRunner({ llm: fake.llm })
    const agent = reviewAgent({
      id: 'session-blank-route',
      noRoute: true,
      headerRoute: { provider: '', model: '' },
    })
    completeTurns(runner, agent.session, 1)
    await runner.drain(agent)
    expect(fake.calls).toHaveLength(0)
    expect(logger.warnings.join('\n')).toContain('no route')
  })
})

describe('the session identity', () => {
  it('refuses to run without a session id', async () => {
    const fake = fakeLlm({ output: '{"operations":[]}' })
    const { runner, logger } = buildRunner({ llm: fake.llm })
    const agent = reviewAgent({ id: '' })
    completeTurns(runner, agent.session, 1)
    await runner.drain(agent)
    expect(fake.calls).toHaveLength(0)
    expect(logger.warnings.join('\n')).toContain('needs a session id')
    expect(await exists(reviewSidecarPath(''))).toBe(false)
  })

  it('ignores completed turns from a session that carries no identity', async () => {
    const fake = fakeLlm({ output: '{"operations":[]}' })
    const { runner, logger } = buildRunner({ llm: fake.llm })
    const session: ReviewSession = {
      header: {},
      deriveMessages: () => [],
      append: () => undefined,
    }
    completeTurns(runner, session, 1)
    const agent: ReviewAgent = { session }
    await runner.drain(agent)
    expect(fake.calls).toHaveLength(0)
    expect(logger.warnings.join('\n')).toContain('needs a session id')
  })
})

describe('session/event', () => {
  it('ignores a turn/end whose reason is not recorded as an object', async () => {
    const fake = fakeLlm({ output: '{"operations":[]}' })
    const { runner } = buildRunner({ llm: fake.llm })
    const agent = reviewAgent()
    runner.observe(agent.session, { type: 'turn/end' })
    runner.observe(agent.session, { type: 'turn/end', data: null })
    runner.observe(agent.session, { type: 'turn/end', data: { reason: 5 } })
    await runner.drain(agent)
    expect(fake.calls).toHaveLength(0)
    expect(await exists(reviewSidecarPath(agent.session.id ?? ''))).toBe(false)
  })
})

describe('the runner seams', () => {
  it('never rejects when a store cannot be read', async () => {
    const fake = fakeLlm({ output: '{"operations":[]}' })
    const { runner, logger } = buildRunner({ llm: fake.llm })
    // A directory where the store file belongs makes the read fail.
    await mkdir(memoryStorePath(home), { recursive: true })
    const agent = reviewAgent()
    completeTurns(runner, agent.session, 1)
    await expect(runner.drain(agent)).resolves.toBeUndefined()
    expect(fake.calls).toHaveLength(0)
    expect(logger.warnings.join('\n')).toContain('failed before it could run')
  })

  it('ignores dispose for an agent that is not the running round', async () => {
    const fake = fakeLlm({ hang: true })
    const { runner } = buildRunner({ llm: fake.llm })
    const agent = reviewAgent()
    const other = reviewAgent({ id: 'session-other' })
    completeTurns(runner, agent.session, 1)
    const running = runner.drain(agent)
    await waitUntil(() => fake.calls.length === 1)
    runner.dispose(other)
    expect(fake.calls[0]?.streamOptions?.signal?.aborted).toBe(false)
    runner.dispose(agent)
    await running
    expect((await sidecarOf(agent)).lastOutcome).toBe('failed:REVIEW_DISPOSED')
  })

  it('treats a second stop as a no-op', async () => {
    const fake = fakeLlm({ hang: true })
    const { runner } = buildRunner({ llm: fake.llm })
    const agent = reviewAgent()
    completeTurns(runner, agent.session, 1)
    const running = runner.drain(agent)
    await waitUntil(() => fake.calls.length === 1)
    await runner.stop()
    await running
    // The round already settled, so the second stop has nothing to abort.
    await runner.stop()
    completeTurns(runner, agent.session, 1)
    await runner.drain(agent)
    expect(fake.calls).toHaveLength(1)
    expect((await sidecarOf(agent)).lastOutcome).toBe('failed:REVIEW_STOPPED')
  })
})
