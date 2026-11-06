/**
 * Tool edge cases left by `tool.spec.ts`: the refusals reachable only before a
 * store resolves, staging under a session with no id, the result renderer's
 * optional fields, and the registry wrapper's own render and failure log.
 * @module @anago-harness/memory/tests/tool-edges
 */
import path from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { AtomicWriteApi } from '@anago-harness/knowledge-common'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MemoryAgent } from '../src/agents.ts'
import { isMemoryError } from '../src/errors.ts'
import {
  createMemoryTool,
  executeMemoryTool,
  type MemoryToolValue,
  renderMemoryResult,
} from '../src/tool.ts'
import {
  cleanupTempDirs,
  type DshHome,
  exists,
  fakeAgent,
  fakeExec,
  memoryConfig,
  pendingRootOf,
  readStoreFile,
  recordingLogger,
  tempDir,
  useDshHome,
} from './support.ts'

const api: AtomicWriteApi = { withFileLock, writeFileAtomic }
const homes: DshHome[] = []

afterEach(() => {
  // Reverse order: a test that redirects twice must end on the value the file
  // started with, not on a temporary directory that cleanup removes.
  for (const home of homes.splice(0).reverse()) home.restore()
})
afterAll(cleanupTempDirs)

/** A harness home with `$DSH_HOME` redirected. */
async function home(): Promise<DshHome> {
  const created = await useDshHome()
  homes.push(created)
  return created
}

// No test may reach the developer's real harness home.
beforeEach(async () => {
  homes.push(await useDshHome())
})

/** One tool call with the default configuration. */
async function call(
  args: Parameters<typeof executeMemoryTool>[0],
  options: {
    readonly agent?: MemoryAgent
    readonly config?: Record<string, unknown>
    readonly isStaged?: (exec: unknown) => boolean
  } = {},
): Promise<MemoryToolValue> {
  const agent = options.agent ?? fakeAgent({})
  return await executeMemoryTool(args, fakeExec(agent), {
    config: memoryConfig(options.config ?? {}),
    logger: recordingLogger(),
    api,
    ...(options.isStaged === undefined ? {} : { isStaged: options.isStaged }),
  })
}

/** Assert one call is refused with a code. */
async function refusal(
  args: Parameters<typeof executeMemoryTool>[0],
  options: Parameters<typeof call>[1] = {},
): Promise<string> {
  try {
    await call(args, options)
  } catch (error) {
    if (isMemoryError(error)) return error.code
    throw error
  }
  throw new Error('the call was expected to fail')
}

/**
 * Type one argument double as the arguments a validated call carries.
 *
 * A refusal case passes a value the schema would reject, so the double keeps
 * only the members the refusal reads.
 * @param value - the double.
 * @returns the same value, typed as the arguments.
 */
function fakeArgs(value: object): Parameters<typeof executeMemoryTool>[0] {
  return value as Parameters<typeof executeMemoryTool>[0]
}

/** A result value with every required field, overridable per test. */
function resultValue(overrides: Partial<MemoryToolValue> = {}): MemoryToolValue {
  return {
    target: 'memory',
    status: 'applied',
    chars: 0,
    limit: 2200,
    entries: [],
    applied: [],
    redacted: [],
    visibleFrom: 'next-snapshot',
    ...overrides,
  }
}

describe('refusals before a store resolves', () => {
  it('refuses the workspace target when the session recorded no cwd', async () => {
    await home()
    expect(await refusal({ target: 'workspace' }, { agent: fakeAgent({}) })).toBe('MEMORY_NO_WORKSPACE')
  })

  it('refuses a target the model supplied that is not one of the three stores', async () => {
    await home()
    const args = fakeArgs({ target: 'everything' })
    expect(await refusal(args)).toBe('MEMORY_INVALID_OPERATION')
  })

  it('refuses to stage a workspace write outside a git worktree', async () => {
    await home()
    const plain = await tempDir('dsh-plain-')
    expect(
      await refusal(
        { target: 'workspace', operations: [{ op: 'add', text: 'x' }] },
        { agent: fakeAgent({ cwd: plain }), isStaged: () => true },
      ),
    ).toBe('MEMORY_NO_WORKSPACE')
    expect(await exists(path.join(plain, '.dsh'))).toBe(false)
  })
})

describe('staging without a session id', () => {
  it('records an empty sessionId rather than dropping the operation', async () => {
    const created = await home()
    const agent: MemoryAgent = { session: { header: {}, deriveMessages: () => [] } }
    const value = await call(
      { target: 'memory', operations: [{ op: 'add', text: 'no session' }] },
      { agent, isStaged: () => true },
    )
    const id = value.staged?.[0] ?? ''
    expect(value.status).toBe('staged')
    const file = path.join(pendingRootOf(created.home), 'memory', `${id}.json`)
    const record = JSON.parse(await readStoreFile(file)) as { readonly sessionId?: unknown }
    expect(record.sessionId).toBe('')
  })
})

describe('renderMemoryResult optional fields', () => {
  it('renders a zero limit as fully used instead of dividing by zero', () => {
    const text = renderMemoryResult(resultValue({ limit: 0 }))
    expect(text).toContain('0/0 chars (100%)')
  })

  it('pluralizes a batch that changed more than one entry', () => {
    const text = renderMemoryResult(resultValue({ applied: ['one', 'two'] }))
    expect(text).toContain('changed: 2 entries')
  })

  it('names the secret kinds it redacted', () => {
    const text = renderMemoryResult(resultValue({ redacted: ['github-token'] }))
    expect(text).toContain('redacted: github-token')
  })

  it('pluralizes the entries an advisory names', () => {
    const text = renderMemoryResult(
      resultValue({
        review: {
          code: 'MEMORY_REVIEW_SUGGESTED',
          entries: [
            { index: 1, ratio: 0.9, text: 'この環境では日本語のメモを書かないこと' },
            { index: 2, ratio: 0.8, text: 'もう一つのメモ' },
          ],
        },
      }),
    )
    expect(text).toContain('audit entries')
    expect(text).toContain('1 (90% non-ASCII), 2 (80% non-ASCII)')
  })

  it('renders a staged result whose ids were not reported', () => {
    const text = renderMemoryResult(resultValue({ status: 'staged' }))
    expect(text).toContain('staged: 0 pending operation(s), nothing written')
  })
})

describe('the registry wrapper', () => {
  it('renders through the registered tool output callback', () => {
    const tool = createMemoryTool({ config: memoryConfig(), logger: recordingLogger(), api })
    const blocks = tool.output.render(
      {},
      {
        target: 'memory',
        status: 'applied',
        chars: 6,
        limit: 2200,
        entries: ['a note'],
        applied: [],
        redacted: [],
        visibleFrom: 'next-snapshot',
      },
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'text' })
    expect(blocks[0]?.type === 'text' ? blocks[0].text : '').toContain('1. a note')
  })

  it('logs one debug line and rethrows when the call cannot run', async () => {
    const logger = recordingLogger()
    const tool = createMemoryTool({ config: memoryConfig(), logger, api })
    await expect(tool.execute({ target: 'memory' }, fakeExec(undefined))).rejects.toThrow(
      /requires a calling agent/u,
    )
    expect(logger.debugLines.join('\n')).toContain('requires a calling agent')
  })
})
