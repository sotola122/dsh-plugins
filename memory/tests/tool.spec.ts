/**
 * Tool suite (DESIGN §4.1, §4.3, §5.1): the `memory` contract end to end against
 * real files under `os.tmpdir()` — reading, each operation, all-or-nothing, the
 * limit, redaction, the read-only child, the preset filter, and the workspace
 * target with its git preconditions.
 * @module @anago-harness/memory/tests/tool
 */
import path from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { AtomicWriteApi } from '@anago-harness/knowledge-common'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isMemoryError } from '../src/errors.ts'
import { workspacePendingKey } from '../src/pending.ts'
import { createMemoryTool, executeMemoryTool, MEMORY_DESCRIPTION, MEMORY_TOOL_NAME, renderMemoryResult, type MemoryToolValue } from '../src/tool.ts'
import {
  cleanupTempDirs,
  type DshHome,
  exists,
  fakeAgent,
  fakeExec,
  git,
  gitAvailable,
  initRepo,
  memoryConfig,
  memoryStorePath,
  readStoreFile,
  recordingLogger,
  useDshHome,
  writeStoreFile,
} from './support.ts'

const api: AtomicWriteApi = { withFileLock, writeFileAtomic }
const hasGit = gitAvailable()
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

// No test may reach the developer's real harness home: `$DSH_HOME` points at a
// temporary directory for every test, asked for or not. A test that needs its
// own home calls `home()` and gets a second, later one.
beforeEach(async () => {
  homes.push(await useDshHome())
})

/** One tool call with the default configuration. */
async function call(
  args: Parameters<typeof executeMemoryTool>[0],
  options: {
    agent?: ReturnType<typeof fakeAgent>
    config?: Record<string, unknown>
    signal?: AbortSignal
    /** The approval gate's mark, as `index.ts` wires it (DESIGN §4.5). */
    isStaged?: (exec: unknown) => boolean
    exec?: ReturnType<typeof fakeExec>
  } = {},
): Promise<MemoryToolValue> {
  const agent = options.agent ?? fakeAgent({})
  return await executeMemoryTool(args, options.exec ?? fakeExec(agent, options.signal), {
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

describe('metadata', () => {
  it('declares the model-facing name and a description that carries the contract', () => {
    const tool = createMemoryTool({ config: memoryConfig(), logger: recordingLogger(), api })
    expect(tool.name).toBe(MEMORY_TOOL_NAME)
    expect(tool.description).toBe(MEMORY_DESCRIPTION)
    for (const phrase of ['Never write secrets', 'in English', 'exactly once', 'next session snapshot']) {
      expect(tool.description).toContain(phrase)
    }
    expect(tool.description.length).toBeGreaterThan(400)
  })

  it('compiles an argument schema that requires a target and accepts an empty batch', () => {
    const tool = createMemoryTool({ config: memoryConfig(), logger: recordingLogger(), api })
    const schema = tool.parameters as { required?: string[]; properties: Record<string, unknown> }
    expect(schema.required).toEqual(['target'])
    expect(Object.keys(schema.properties).sort()).toEqual(['operations', 'target'])
  })
})

describe('reading', () => {
  it('returns the entries and usage for an empty batch', async () => {
    const created = await home()
    await writeStoreFile(memoryStorePath(created.home), ['one', 'two'])
    const value = await call({ target: 'memory', operations: [] })
    expect(value.status).toBe('applied')
    expect(value.entries).toEqual(['one', 'two'])
    expect(value.applied).toEqual([])
    expect(value.chars).toBe(6)
    expect(value.limit).toBe(2200)
    expect(value.visibleFrom).toBe('next-snapshot')
    expect(renderMemoryResult(value)).toContain('1. one')
  })

  it('reports an absent store as no entries', async () => {
    await home()
    const value = await call({ target: 'memory' })
    expect(value.entries).toEqual([])
    expect(value.chars).toBe(0)
  })
})

describe('writing', () => {
  it('adds, patches, and removes in one batch', async () => {
    const created = await home()
    await call({ target: 'memory', operations: [{ op: 'add', text: 'first note' }] })
    const value = await call({
      target: 'memory',
      operations: [
        { op: 'add', text: 'second note' },
        { op: 'patch', old_text: 'first', text: 'renamed' },
      ],
    })
    expect(value.entries).toEqual(['renamed note', 'second note'])
    expect(value.applied).toEqual(['second note', 'renamed note'])
    const removed = await call({ target: 'memory', operations: [{ op: 'remove', old_text: 'renamed' }] })
    expect(removed.entries).toEqual(['second note'])
    expect(removed.applied).toEqual(['renamed note'])
    expect(await readStoreFile(memoryStorePath(created.home))).toBe('second note\n')
  })

  it('refuses a duplicate, an unknown old_text, and an over-limit batch', async () => {
    await home()
    await call({ target: 'memory', operations: [{ op: 'add', text: 'note' }] })
    expect(await refusal({ target: 'memory', operations: [{ op: 'add', text: 'NOTE' }] })).toBe(
      'MEMORY_DUPLICATE',
    )
    expect(
      await refusal({ target: 'memory', operations: [{ op: 'remove', old_text: 'absent' }] }),
    ).toBe('MEMORY_NOT_FOUND')
    expect(
      await refusal({
        target: 'memory',
        operations: [{ op: 'add', text: 'x'.repeat(2200) }],
      }),
    ).toBe('MEMORY_LIMIT_EXCEEDED')
  })

  it('reports the limit refusal with every entry, and writes nothing', async () => {
    await home()
    await call({ target: 'memory', operations: [{ op: 'add', text: 'y'.repeat(2190) }] })
    try {
      await call({ target: 'memory', operations: [{ op: 'add', text: 'z'.repeat(20) }] })
      throw new Error('expected a refusal')
    } catch (error) {
      expect((error as Error).message).toContain('MEMORY_LIMIT_EXCEEDED')
      expect((error as Error).message).toContain('chars')
      expect((error as Error).message).toContain('Consolidate in ONE memory call')
    }
  })

  it('redacts a secret, reports the kind, and stores the placeholder', async () => {
    const created = await home()
    const value = await call({
      target: 'memory',
      operations: [{ op: 'add', text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here' }],
    })
    expect(value.redacted).toEqual(['github-token'])
    expect(await readStoreFile(memoryStorePath(created.home))).toContain('[REDACTED:github-token]')
  })

  it('returns MEMORY_REVIEW_SUGGESTED for a mostly non-ASCII entry', async () => {
    await home()
    const value = await call({
      target: 'memory',
      operations: [{ op: 'add', text: 'この環境では日本語のメモを書かないこと' }],
    })
    expect(value.review?.code).toBe('MEMORY_REVIEW_SUGGESTED')
    expect(value.review?.entries[0]?.index).toBe(1)
    expect(renderMemoryResult(value)).toContain('MEMORY_REVIEW_SUGGESTED')
  })

  it('uses the user profile limit for the user store', async () => {
    await home()
    const value = await call({ target: 'user', operations: [{ op: 'add', text: 'prefers terse answers' }] })
    expect(value.target).toBe('user')
    expect(value.limit).toBe(1375)
    expect(await exists(path.join(process.env.DSH_HOME ?? '', 'memories', 'USER.md'))).toBe(true)
  })
})

describe('authorization', () => {
  it('refuses a subagent child with MEMORY_READ_ONLY', async () => {
    await home()
    const agent = fakeAgent({ delegationDepth: 1 })
    expect(await refusal({ target: 'memory', operations: [{ op: 'add', text: 'x' }] }, { agent })).toBe(
      'MEMORY_READ_ONLY',
    )
    // The tool is denied as a whole for a child, matching the `restrict` in
    // `agent/created`: a child reads its workspace notes from the injected
    // snapshot (N8), so even the read form is refused here. This refusal is the
    // backstop for the case where the scoped restriction could not be applied.
    expect(await refusal({ target: 'workspace' }, { agent })).toBe('MEMORY_READ_ONLY')
  })

  it('refuses an excluded preset', async () => {
    await home()
    const agent = fakeAgent({ agentPreset: 'minimal' })
    expect(
      await refusal({ target: 'memory', operations: [{ op: 'add', text: 'x' }] }, {
        agent,
        config: { presets: { exclude: ['minimal'] } },
      }),
    ).toBe('MEMORY_DISABLED')
  })

  it('refuses a call with no calling agent', async () => {
    await home()
    await expect(
      executeMemoryTool({ target: 'memory' }, fakeExec(undefined), {
        config: memoryConfig(),
        logger: recordingLogger(),
        api,
      }),
    ).rejects.toThrow(/requires a calling agent/u)
  })
})

describe.skipIf(!hasGit)('workspace target', () => {
  it('creates the store and the managed block on the first write', async () => {
    const root = await initRepo()
    const agent = fakeAgent({ cwd: root })
    const value = await call({ target: 'workspace', operations: [{ op: 'add', text: 'repo note' }] }, { agent })
    expect(value.target).toBe('workspace')
    expect(await readStoreFile(path.join(root, '.dsh', 'memory', 'MEMORY.md'))).toBe('repo note\n')
    const gitignore = await readStoreFile(path.join(root, '.gitignore'))
    expect(gitignore).toContain('# >>> dsh-memory (managed by @tep-hardware/dsh-memory)')
    expect(gitignore).toContain('!.dsh/wiki.yml')
    // `git status` must not show the store: the rule and the untracked file.
    expect(git(root, ['status', '--porcelain'])).not.toContain('.dsh/memory')
  })

  it('refuses the workspace target outside a git worktree', async () => {
    const dir = await useDshHome()
    homes.push(dir)
    const plain = await import('node:fs/promises').then(async fs =>
      await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'dsh-plain-')),
    )
    const agent = fakeAgent({ cwd: plain })
    expect(await refusal({ target: 'workspace', operations: [{ op: 'add', text: 'x' }] }, { agent })).toBe(
      'MEMORY_NO_WORKSPACE',
    )
    expect(await exists(path.join(plain, '.dsh'))).toBe(false)
  })

  it('refuses a tracked store with MEMORY_TRACKED', async () => {
    const root = await initRepo()
    await writeStoreFile(path.join(root, '.dsh', 'memory', 'MEMORY.md'), ['tracked'])
    git(root, ['add', '-f', '.dsh/memory/MEMORY.md'])
    const agent = fakeAgent({ cwd: root })
    expect(await refusal({ target: 'workspace', operations: [{ op: 'add', text: 'x' }] }, { agent })).toBe(
      'MEMORY_TRACKED',
    )
  })

  it('refuses when manageGitignore is false and the path is not ignored', async () => {
    const root = await initRepo()
    const agent = fakeAgent({ cwd: root })
    expect(
      await refusal({ target: 'workspace', operations: [{ op: 'add', text: 'x' }] }, {
        agent,
        config: { workspace: { enabled: true, manageGitignore: false } },
      }),
    ).toBe('MEMORY_NO_IGNORE_RULE')
    expect(await exists(path.join(root, '.gitignore'))).toBe(false)
  })
})

describe('the staged path (DESIGN §4.5)', () => {
  it('records pending operations instead of writing, and reports the ids', async () => {
    const created = await home()
    const exec = fakeExec(fakeAgent({}))
    const value = await call(
      { target: 'memory', operations: [{ op: 'add', text: 'a staged note' }] },
      { isStaged: () => true, exec },
    )
    expect(value.status).toBe('staged')
    expect(value.applied).toEqual([])
    expect(value.entries).toEqual([])
    expect(value.staged).toHaveLength(1)
    expect(value.staged?.[0]).toMatch(/^\d{8}T\d{6}-[0-9a-f]{8}$/u)
    // The store was not created, and the pending file was.
    expect(await exists(memoryStorePath(created.home))).toBe(false)
    const pending = path.join(created.home, 'memories', 'pending', 'memory')
    expect(await readStoreFile(path.join(pending, `${value.staged?.[0] ?? ''}.json`))).toContain('a staged note')
    const text = renderMemoryResult(value)
    expect(text).toContain('memory memory: staged')
    expect(text).toContain('/memory approve')
    expect(text).toContain('Nothing was written')
  })

  it('matches the mark to the exact execution object', async () => {
    const created = await home()
    const marked = fakeExec(fakeAgent({}))
    const other = fakeExec(fakeAgent({}))
    await call(
      { target: 'memory', operations: [{ op: 'add', text: 'staged' }] },
      { isStaged: exec => exec === marked, exec: marked },
    )
    const value = await call(
      { target: 'memory', operations: [{ op: 'add', text: 'written' }] },
      { isStaged: exec => exec === marked, exec: other },
    )
    expect(value.status).toBe('applied')
    expect(await readStoreFile(memoryStorePath(created.home))).toBe('written\n')
  })

  it('never stages a read, even when the mark is set', async () => {
    const created = await home()
    await writeStoreFile(memoryStorePath(created.home), ['a note'])
    const value = await call({ target: 'memory', operations: [] }, { isStaged: () => true })
    expect(value.status).toBe('applied')
    expect(value.entries).toEqual(['a note'])
  })

  it('refuses MEMORY_PENDING_FULL at pending.maxPerStore and writes nothing', async () => {
    await home()
    const config = { pending: { maxPerStore: 1 } }
    await call({ target: 'memory', operations: [{ op: 'add', text: 'first' }] }, { isStaged: () => true, config })
    expect(
      await refusal(
        { target: 'memory', operations: [{ op: 'add', text: 'second' }] },
        { isStaged: () => true, config },
      ),
    ).toBe('MEMORY_PENDING_FULL')
  })

  it('validates the batch the same way a write does', async () => {
    await home()
    await writeStoreFile(memoryStorePath(process.env.DSH_HOME ?? ''), ['existing'])
    expect(
      await refusal(
        { target: 'memory', operations: [{ op: 'add', text: 'existing' }] },
        { isStaged: () => true },
      ),
    ).toBe('MEMORY_DUPLICATE')
    expect(
      await refusal(
        { target: 'memory', operations: [{ op: 'add', text: 'x'.repeat(2300) }] },
        { isStaged: () => true },
      ),
    ).toBe('MEMORY_LIMIT_EXCEEDED')
  })

  it.skipIf(!hasGit)('does not create the store or the .gitignore block for a workspace staging', async () => {
    const root = await initRepo()
    const agent = fakeAgent({ cwd: root })
    const value = await call(
      { target: 'workspace', operations: [{ op: 'add', text: 'staged for the repo' }] },
      { agent, isStaged: () => true },
    )
    expect(value.status).toBe('staged')
    expect(await exists(path.join(root, '.dsh', 'memory', 'MEMORY.md'))).toBe(false)
    expect(await exists(path.join(root, '.gitignore'))).toBe(false)
  })

  it.skipIf(!hasGit)('refuses to stage a workspace write manageGitignore could never make writable', async () => {
    const root = await initRepo()
    const agent = fakeAgent({ cwd: root })
    expect(
      await refusal(
        { target: 'workspace', operations: [{ op: 'add', text: 'x' }] },
        { agent, isStaged: () => true, config: { workspace: { enabled: true, manageGitignore: false } } },
      ),
    ).toBe('MEMORY_NO_IGNORE_RULE')
    expect(await exists(path.join(root, '.gitignore'))).toBe(false)
  })

  it.skipIf(!hasGit)('stages under the workspace key of the resolved root', async () => {
    const root = await initRepo()
    const created = await home()
    const agent = fakeAgent({ cwd: root })
    const value = await call(
      { target: 'workspace', operations: [{ op: 'add', text: 'repo note' }] },
      { agent, isStaged: () => true },
    )
    const key = workspacePendingKey(root)
    expect(await exists(path.join(created.home, 'memories', 'pending', 'workspaces', key, `${value.staged?.[0] ?? ''}.json`))).toBe(true)
  })
})

describe('render', () => {
  it('names the store, the usage, and the entries', async () => {
    await home()
    const value = await call({ target: 'memory', operations: [{ op: 'add', text: 'note' }] })
    const text = renderMemoryResult(value)
    expect(text).toContain('memory memory: applied — 4/2,200 chars (0%)')
    expect(text).toContain('changed: 1 entry')
    expect(text).toContain('1. note')
    expect(text).toContain('Visible from the next snapshot')
  })

  it('shows an empty store without inventing entries', () => {
    const text = renderMemoryResult({
      target: 'user',
      status: 'applied',
      chars: 0,
      limit: 1375,
      entries: [],
      applied: [],
      redacted: [],
      visibleFrom: 'next-snapshot',
    })
    expect(text).toContain('entries: (none)')
  })
})
