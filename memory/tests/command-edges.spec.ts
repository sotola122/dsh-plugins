/**
 * `/memory` edge cases left by `command.spec.ts`: the read-only reports of a
 * damaged or missing state, the `user`/`workspace` approval targets, the
 * rejection refusals, the `.gitignore` update and lock paths, and an invocation
 * that supplies no cancellation.
 * @module @anago-harness/memory/tests/command-edges
 */
import path from 'node:path'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { AtomicWriteApi } from '@anago-harness/knowledge-common'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MemoryAgent, MemorySessionHeader } from '../src/agents.ts'
import { runMemoryCommand, wrapDisplay } from '../src/command.ts'
import {
  globalPendingDirectory,
  pendingRoot,
  stageOperations,
  workspacePendingDirectory,
  workspacePendingKey,
} from '../src/pending.ts'
import { reviewSidecarPath } from '../src/review.ts'
import { globalStore } from '../src/store.ts'
import {
  cleanupTempDirs,
  type DshHome,
  fakeAgent,
  fakeCommandInvocation,
  fakeInvocation,
  gitAvailable,
  initRepo,
  memoryConfig,
  memoryStorePath,
  readStoreFile,
  recordingLogger,
  type RecordingLogger,
  tempDir,
  useDshHome,
  writePendingFile,
  writeRawFile,
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

// No test may reach the developer's real harness home.
beforeEach(async () => {
  homes.push(await useDshHome())
})

/** Run one invocation and return the whole result. */
async function invoke(
  line: string,
  options: {
    readonly agent?: MemoryAgent
    readonly config?: Record<string, unknown>
    readonly now?: () => Date
    readonly logger?: RecordingLogger
    readonly invocation?: CommandInvocation
  } = {},
): Promise<CommandResult> {
  const agent = options.agent ?? fakeAgent({})
  return await runMemoryCommand(options.invocation ?? fakeInvocation(agent, line), {
    config: memoryConfig(options.config ?? {}),
    logger: options.logger ?? recordingLogger(),
    api,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
}

/** Run one line through the command, formatted the way `command.spec.ts` does. */
async function run(line: string, options: Parameters<typeof invoke>[1] = {}): Promise<string> {
  const result = await invoke(line, options)
  return `kind: ${result.kind}\n${result.text ?? ''}`
}

/**
 * An agent whose `cwd` resolves to a repository on the first read and to a
 * plain directory afterwards: the race `/memory approve` has to survive when
 * the worktree a staged operation was recorded in is gone by the time a person
 * applies it.
 */
function vanishingRepoAgent(root: string, elsewhere: string): MemoryAgent {
  let reads = 0
  return {
    session: {
      id: 'session-memory-test',
      header: {
        get cwd(): string {
          reads += 1
          return reads === 1 ? root : elsewhere
        },
      },
      deriveMessages: () => [],
    },
  }
}

/** An agent whose session recorded no identity. */
function anonymousSessionAgent(header: MemorySessionHeader = {}): MemoryAgent {
  return { session: { header, deriveMessages: () => [] } }
}

/**
 * An invocation from a caller that supplied no cancellation signal.
 *
 * `MemoryCommandDeps.signal` is optional and the command has a no-signal form;
 * `CommandInvocation.signal` is required, so a test cannot omit it without the
 * same cast the package's own `fakeInvocation` fixture uses.
 */
function invocationWithoutSignal(agent: MemoryAgent, line: string): CommandInvocation {
  return fakeCommandInvocation({ ...fakeInvocation(agent, line), signal: undefined })
}

describe('wrapDisplay', () => {
  it('keeps a blank line as an empty display line', () => {
    expect(wrapDisplay('one\n\ntwo')).toEqual(['one', '', 'two'])
    expect(wrapDisplay('x\n')).toEqual(['x', ''])
    expect(wrapDisplay('\n\n')).toEqual(['', '', ''])
  })
})

describe('an invocation without cancellation', () => {
  it('runs the subcommand with the optional signal absent', async () => {
    const created = await home()
    const agent = fakeAgent({ cwd: created.home })
    const result = await invoke('list', { invocation: invocationWithoutSignal(agent, 'list') })
    expect(result.kind).toBe('success')
    expect(result.kind === 'success' ? result.text : '').toContain('memory stores (pending root:')
  })
})

describe('/memory list state reading', () => {
  it('reports the review sidecar attempts and last outcome', async () => {
    await home()
    const agent = fakeAgent({ id: 'session-sidecar-readable' })
    await writeRawFile(
      reviewSidecarPath('session-sidecar-readable'),
      `${JSON.stringify({ reviewRuns: 2, lastOutcome: 'staged:1' })}\n`,
    )
    const text = await run('list', { agent })
    expect(text).toContain('2/4 attempt(s), last outcome: staged:1')
  })

  it('treats a sidecar of the wrong field types as no review yet', async () => {
    await home()
    const agent = fakeAgent({ id: 'session-sidecar-damaged' })
    await writeRawFile(
      reviewSidecarPath('session-sidecar-damaged'),
      `${JSON.stringify({ reviewRuns: 'two', lastOutcome: 7 })}\n`,
    )
    const text = await run('list', { agent })
    expect(text).toContain('0/4 attempt(s), last outcome: (none yet)')
  })

  it('renders a store whose limit is zero as fully used', async () => {
    await home()
    const text = await run('list', { config: { limits: { memory: 0 } } })
    expect(text).toContain('0/0 chars (100%)')
  })

  it('reports no review for a session that recorded no identity', async () => {
    await home()
    const text = await run('list', { agent: anonymousSessionAgent() })
    expect(text).toContain('review: enabled true, 0/4 attempt(s), last outcome: (none yet)')
  })

  it('counts the pending files it cannot use', async () => {
    await home()
    await writePendingFile(path.join(globalPendingDirectory('memory', pendingRoot()), 'notes.json'), {})
    const text = await run('list')
    expect(text).toContain('unusable pending files: 1')
  })

  it('reports an unreadable store as MEMORY_IO instead of crashing', async () => {
    const created = await home()
    // A directory where the store file is expected: the read fails with EISDIR.
    await mkdir(memoryStorePath(created.home), { recursive: true })
    const result = await invoke('show memory')
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' ? result.text : '').toContain('MEMORY_IO')
  })
})

describe('/memory pending operation fields', () => {
  it('prints an add without a base entry or old_text, and a remove without text', async () => {
    await home()
    const directory = globalPendingDirectory('memory', pendingRoot())
    await stageOperations({
      target: 'memory',
      directory,
      sessionId: 'session-memory-test',
      source: 'tool',
      operations: [{ op: 'add', text: 'a fresh note' }],
      document: { header: null, entries: [] },
      limit: 2200,
      maxPerStore: 50,
    })
    await stageOperations({
      target: 'memory',
      directory,
      sessionId: 'session-memory-test',
      source: 'tool',
      operations: [{ op: 'remove', old_text: 'stale note' }],
      document: { header: null, entries: ['stale note'] },
      limit: 2200,
      maxPerStore: 50,
    })
    const text = await run('pending', { now: () => new Date('2026-10-19T10:15:03.000Z') })
    expect(text).toContain('baseEntry: (none)')
    expect(text).toContain('old_text (10 chars):')
    // The add carries text and no old_text; the remove carries only old_text.
    expect(text.match(/^ {2}text \(/gmu)).toHaveLength(1)
    expect(text.match(/^ {2}old_text \(/gmu)).toHaveLength(1)
  })
})

describe('/memory approve across stores', () => {
  it('applies a staged user-profile operation', async () => {
    await home()
    const outcome = await stageOperations({
      target: 'user',
      directory: globalPendingDirectory('user', pendingRoot()),
      sessionId: 'session-memory-test',
      source: 'tool',
      operations: [{ op: 'add', text: 'prefers terse answers' }],
      document: { header: null, entries: [] },
      limit: 1375,
      maxPerStore: 50,
    })
    const id = outcome.ids[0] ?? ''
    const text = await run(`approve ${id}`)
    expect(text).toContain('applied 1 of 1 selected staged operation(s)')
    expect(text).toContain(`approved ${id} (user)`)
    expect(await readStoreFile(globalStore('user', 1375).path)).toBe('prefers terse answers\n')
  })

  it.skipIf(!hasGit)('applies a staged workspace operation and creates the managed block', async () => {
    const root = await initRepo()
    const key = workspacePendingKey(root)
    await stageOperations({
      target: 'workspace',
      directory: workspacePendingDirectory(key, pendingRoot()),
      sessionId: 'session-memory-test',
      source: 'tool',
      operations: [{ op: 'add', text: 'repo note' }],
      document: { header: null, entries: [] },
      limit: 2200,
      maxPerStore: 50,
    })
    const text = await run('approve all', { agent: fakeAgent({ cwd: root }) })
    expect(text).toContain('applied 1 of 1 selected staged operation(s)')
    expect(await readStoreFile(path.join(root, '.dsh', 'memory', 'MEMORY.md'))).toBe('repo note\n')
    expect(await readStoreFile(path.join(root, '.gitignore'))).toContain('# >>> dsh-memory')
  })

  it.skipIf(!hasGit)('keeps a workspace operation whose repository is gone at approval time', async () => {
    const root = await initRepo()
    const key = workspacePendingKey(root)
    const outcome = await stageOperations({
      target: 'workspace',
      directory: workspacePendingDirectory(key, pendingRoot()),
      sessionId: 'session-memory-test',
      source: 'tool',
      operations: [{ op: 'add', text: 'repo note' }],
      document: { header: null, entries: [] },
      limit: 2200,
      maxPerStore: 50,
    })
    const id = outcome.ids[0] ?? ''
    const elsewhere = await tempDir('dsh-plain-')
    const result = await invoke('approve all', { agent: vanishingRepoAgent(root, elsewhere) })
    expect(result.kind).toBe('error')
    const text = result.kind === 'error' ? result.text : ''
    expect(text).toContain('applied 0 of 1 selected staged operation(s)')
    expect(text).toContain(`kept ${id} (workspace)`)
    expect(text).toContain('MEMORY_NO_WORKSPACE')
    // A kept record is retried, so its file is still there.
    expect(await readdir(workspacePendingDirectory(key, pendingRoot()))).toHaveLength(1)
  })
})

describe('/memory reject refusals', () => {
  it('reports an id the plugin did not issue', async () => {
    await home()
    const text = await run('reject 20261019T101203-deadbeef')
    expect(text).toContain('kind: error')
    expect(text).toContain('rejected 0 of 0 selected staged operation(s)')
    expect(text).toContain('MEMORY_PENDING_UNKNOWN: 20261019T101203-deadbeef')
  })

  it('reports an unusable pending file when everything is rejected', async () => {
    await home()
    await writePendingFile(path.join(globalPendingDirectory('memory', pendingRoot()), 'notes.json'), {})
    const text = await run('reject all')
    expect(text).toContain('kind: error')
    expect(text).toContain('rejected 0 of 0 selected staged operation(s)')
    expect(text).toContain('MEMORY_PENDING_UNKNOWN: ')
  })

  it('rejects nothing without failing when nothing is staged', async () => {
    await home()
    const text = await run('reject all')
    expect(text).toContain('kind: success')
    expect(text).toContain('rejected 0 of 0 selected staged operation(s)')
  })
})

describe('/memory gitignore edges', () => {
  it.skipIf(!hasGit)('updates an outdated managed block', async () => {
    const root = await initRepo()
    await writeFile(
      path.join(root, '.gitignore'),
      [
        '# >>> dsh-memory (managed by @tep-hardware/dsh-memory)',
        '.dsh/stale-rule',
        '# <<< dsh-memory',
        'coverage/',
        '',
      ].join('\n'),
    )
    const text = await run('gitignore', { agent: fakeAgent({ cwd: root }) })
    expect(text).toContain('kind: success')
    expect(text).toContain('updated the managed block')
    const content = await readStoreFile(path.join(root, '.gitignore'))
    expect(content).toContain('.dsh/*')
    expect(content).not.toContain('.dsh/stale-rule')
    expect(content).toContain('coverage/')
  })

  it.skipIf(!hasGit)('reports manageGitignore false when another rule already ignores the store', async () => {
    const root = await initRepo()
    await writeFile(path.join(root, '.gitignore'), '.dsh/\n')
    const text = await run('gitignore', {
      agent: fakeAgent({ cwd: root }),
      config: { workspace: { enabled: true, manageGitignore: false } },
    })
    expect(text).toContain('kind: success')
    expect(text).toContain('unchanged: workspace.manageGitignore is false, so the block is never written')
    expect(text).toContain(
      'workspace.manageGitignore is false: set it to true to let the plugin write the block',
    )
  })

  it.skipIf(!hasGit)('reports a writer-lock timeout that is not a MEMORY_ refusal', async () => {
    const root = await initRepo()
    // The lock file another writer holds: the atomic write above it must time out.
    await writeFile(path.join(root, '.gitignore.lock'), `${String(process.pid)}\n`, { mode: 0o600 })
    const logger = recordingLogger()
    const result = await invoke('gitignore', {
      agent: fakeAgent({ cwd: root }),
      config: { lockWaitMs: 20 },
      logger,
    })
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' ? result.text : '').toContain('/memory gitignore failed:')
    expect(result.kind === 'error' ? result.text : '').toContain('waiting for the writer lock')
    expect(logger.warnings.join('\n')).toContain('/memory gitignore failed')
  })
})
