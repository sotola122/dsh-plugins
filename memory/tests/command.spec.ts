/**
 * `/memory` suite (DESIGN §4.6): every subcommand, including the full-text
 * `pending` listing, the re-checked `approve`, the `all` bounds, and
 * `gitignore`. The command is exercised through {@link runMemoryCommand}, which
 * is exactly what the registered handler calls.
 * @module @anago-harness/memory/tests/command
 */
import path from 'node:path'
import { readdir, rm } from 'node:fs/promises'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { AtomicWriteApi } from '@anago-harness/knowledge-common'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  formatAge,
  MEMORY_COMMAND_HINT,
  MEMORY_SUBCOMMANDS,
  MEMORY_USAGE,
  runMemoryCommand,
  wrapDisplay,
} from '../src/command.ts'
import {
  ALL_MAX_OPERATIONS,
  globalPendingDirectory,
  pendingRoot,
  stageOperations,
  workspacePendingDirectory,
  workspacePendingKey,
} from '../src/pending.ts'
import { globalStore } from '../src/store.ts'
import {
  cleanupTempDirs,
  type DshHome,
  fakeAgent,
  fakeInvocation,
  gitAvailable,
  initRepo,
  memoryConfig,
  memoryStorePath,
  readStoreFile,
  recordingLogger,
  useDshHome,
  writePendingFile,
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

/** Run one line through the command. */
async function run(
  line: string,
  options: {
    agent?: ReturnType<typeof fakeAgent>
    config?: Record<string, unknown>
    now?: () => Date
  } = {},
): Promise<string> {
  const agent = options.agent ?? fakeAgent({})
  const result = await runMemoryCommand(fakeInvocation(agent, line), {
    config: memoryConfig(options.config ?? {}),
    logger: recordingLogger(),
    api,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return `kind: ${result.kind}\n${result.text ?? ''}`
}

describe('metadata', () => {
  it('names the seven subcommands of the design, without gitignore remove', () => {
    expect([...MEMORY_SUBCOMMANDS]).toEqual([
      'list',
      'show',
      'path',
      'pending',
      'approve',
      'reject',
      'gitignore',
    ])
    expect(MEMORY_USAGE).not.toMatch(/remove/u)
    expect(MEMORY_COMMAND_HINT).toContain('approve <id…|all>')
  })
})

describe('wrapDisplay and formatAge', () => {
  it('wraps at 80 code points on spaces and keeps every character', () => {
    const text = `${'a'.repeat(60)} ${'b'.repeat(60)}`
    const lines = wrapDisplay(text)
    expect(lines[0]).toHaveLength(60)
    expect(lines[1]).toBe('b'.repeat(60))
    expect(lines.join(' ').replace(/\s+/gu, ' ')).toBe(text.replace(/\s+/gu, ' '))
  })

  it('cuts a word longer than the width rather than eliding it', () => {
    const lines = wrapDisplay('x'.repeat(200))
    expect(lines).toEqual(['x'.repeat(80), 'x'.repeat(80), 'x'.repeat(40)])
  })

  it('counts code points, so a wide character does not overflow the column count', () => {
    const lines = wrapDisplay('あ'.repeat(100))
    expect(lines.map(line => Array.from(line).length)).toEqual([80, 20])
  })

  it('keeps explicit line breaks', () => {
    expect(wrapDisplay('one\ntwo')).toEqual(['one', 'two'])
  })

  it('renders a compact age', () => {
    const now = new Date('2026-10-19T10:20:00.000Z')
    expect(formatAge('2026-10-19T10:19:30.000Z', now)).toBe('30s ago')
    expect(formatAge('2026-10-19T10:12:00.000Z', now)).toBe('8m ago')
    expect(formatAge('2026-10-19T05:00:00.000Z', now)).toBe('5h ago')
    expect(formatAge('2026-10-16T10:00:00.000Z', now)).toBe('3d ago')
    expect(formatAge('nonsense', now)).toBe('unknown age')
  })
})

describe('/memory list', () => {
  it('reports each store, its usage, the pending counts, and the review state', async () => {
    const created = await home()
    await writeStoreFile(memoryStorePath(created.home), ['a note', 'a second note'])
    await writeStoreFile(memoryStorePath(created.home, 'user'), ['writes in English'])
    const text = await run('list')
    expect(text).toContain('kind: success')
    expect(text).toContain(`memory stores (pending root: ${pendingRoot()})`)
    expect(text).toContain('1. memory')
    expect(text).toContain('2. user')
    expect(text).toContain('2 entries, pending 0, non-ASCII advisories 0')
    expect(text).toContain('pending: 0 operation(s) — source=tool 0, source=review 0')
    expect(text).toContain('review: enabled true, 0/4 attempt(s), last outcome: (none yet)')
  })

  it('counts the non-ASCII advisories and the review-sourced pendings', async () => {
    const created = await home()
    await writeStoreFile(memoryStorePath(created.home), ['この環境では日本語のメモを書かないこと'])
    await writePendingFile(
      path.join(globalPendingDirectory('memory', pendingRoot()), '20261019T101203-aaaaaaaa.json'),
      {
        createdAt: '2026-10-19T10:12:03.000Z',
        sessionId: 's',
        source: 'review',
        target: 'memory',
        op: 'add',
        text: 'proposed',
      },
    )
    const text = await run('list')
    expect(text).toContain('non-ASCII advisories 1')
    expect(text).toContain('source=review 1')
  })

  it('reports an unavailable workspace store instead of failing', async () => {
    await home()
    const plain = await useDshHome()
    homes.push(plain)
    const text = await run('list', { agent: fakeAgent({ cwd: plain.home }) })
    expect(text).toContain('3. workspace: unavailable')
  })

  it('mentions pending operations of other repositories', async () => {
    const created = await home()
    await writePendingFile(
      path.join(workspacePendingDirectory('someone-else', pendingRoot()), '20261019T101203-aaaaaaaa.json'),
      {
        createdAt: '2026-10-19T10:12:03.000Z',
        sessionId: 's',
        source: 'tool',
        target: 'workspace',
        op: 'add',
        text: 'elsewhere',
      },
    )
    void created
    const text = await run('list')
    expect(text).toContain('belong to other repositories')
  })
})

describe('/memory show', () => {
  it('numbers the entries and marks the non-ASCII ones', async () => {
    const created = await home()
    await writeStoreFile(memoryStorePath(created.home), ['plain note', 'この環境では日本語のメモを書かないこと'])
    const text = await run('show memory')
    expect(text).toContain('1. plain note')
    expect(text).toContain('2. この環境では日本語のメモを書かないこと  [non-ASCII')
  })

  it('says when a store does not exist yet', async () => {
    await home()
    const text = await run('show user')
    expect(text).toContain('(the file does not exist yet)')
    expect(text).toContain('(no entries)')
  })

  it('refuses an unknown target and an unavailable workspace', async () => {
    await home()
    expect(await run('show everything')).toContain('show needs one of memory, user, workspace')
    const plain = await useDshHome()
    homes.push(plain)
    const text = await run('show workspace', { agent: fakeAgent({ cwd: plain.home }) })
    expect(text).toContain('kind: error')
    expect(text).toContain('MEMORY_NO_WORKSPACE')
  })
})

describe('/memory path', () => {
  it('prints the three stores and the pending directories', async () => {
    const created = await home()
    const text = await run('path')
    expect(text).toContain(`memory     ${globalStore('memory', 2200).path}`)
    expect(text).toContain(`user       ${globalStore('user', 1375).path}`)
    expect(text).toContain(`pending    ${pendingRoot()}`)
    expect(text).toContain(`  memory     ${path.join(created.home, 'memories', 'pending', 'memory')}`)
    expect(text).toContain('  workspace  (unavailable: no git worktree)')
  })

  it.skipIf(!hasGit)('prints the workspace key of the current repository', async () => {
    const root = await initRepo()
    const text = await run('path', { agent: fakeAgent({ cwd: root }) })
    expect(text).toContain(workspacePendingKey(root))
  })
})

describe('/memory pending', () => {
  it('prints the full text and old_text, wrapped, with id, target, source, and age', async () => {
    await home()
    const directory = globalPendingDirectory('memory', pendingRoot())
    const long = `${'staged '.repeat(14)}end`
    await writePendingFile(path.join(directory, '20261019T101203-aaaaaaaa.json'), {
      createdAt: '2026-10-19T10:12:03.000Z',
      sessionId: 's',
      source: 'tool',
      target: 'memory',
      op: 'patch',
      old_text: 'old entry',
      text: long,
      baseEntry: 'old entry',
    })
    const text = await run('pending', { now: () => new Date('2026-10-19T10:15:03.000Z') })
    expect(text).toContain('20261019T101203-aaaaaaaa  memory  source=tool  3m ago  patch')
    expect(text).toContain('baseEntry: old entry')
    expect(text).toContain('old_text (9 chars):')
    expect(text).toContain('    old entry')
    expect(text).toContain(`text (${String(long.length)} chars):`)
    // Nothing is elided: every character of the staged text is in the output.
    expect(text.replace(/[ \n]/gu, '')).toContain(long.replace(/ /gu, ''))
    // And the wrap actually happened at 80 columns.
    expect(text.split('\n').some(line => line.startsWith('    staged staged'))).toBe(true)
  })

  it('says there is nothing staged, and mentions other repositories', async () => {
    await home()
    expect(await run('pending')).toContain('No staged operations.')
    await writePendingFile(
      path.join(workspacePendingDirectory('elsewhere', pendingRoot()), '20261019T101203-aaaaaaaa.json'),
      { createdAt: '2026-10-19T10:12:03.000Z', sessionId: 's', source: 'tool', target: 'workspace', op: 'add', text: 'x' },
    )
    const text = await run('pending')
    expect(text).toContain('No staged operations here.')
    expect(text).toContain('belong to another repository')
  })

  it('reports a file that is not a usable pending operation', async () => {
    await home()
    await writePendingFile(path.join(globalPendingDirectory('memory', pendingRoot()), 'notes.json'), {})
    const text = await run('pending')
    expect(text).toContain('Files that are not usable pending operations (1)')
    expect(text).toContain('MEMORY_PENDING_UNKNOWN')
  })
})

describe('/memory approve and reject', () => {
  /** Stage one operation through the real staging path. */
  async function staged(text: string, entries: readonly string[] = []): Promise<string> {
    const outcome = await stageOperations({
      target: 'memory',
      directory: globalPendingDirectory('memory', pendingRoot()),
      sessionId: 'session-memory-test',
      source: 'tool',
      operations: [{ op: 'add', text }],
      document: { header: null, entries: [...entries] },
      limit: 2200,
      maxPerStore: 50,
    })
    return outcome.ids[0] ?? ''
  }

  it('applies one id and reports it', async () => {
    await home()
    const id = await staged('approved through the command')
    const text = await run(`approve ${id}`)
    expect(text).toContain('kind: success')
    expect(text).toContain('applied 1 of 1 selected staged operation(s)')
    expect(text).toContain(`approved ${id} (memory)`)
    expect(await readStoreFile(globalStore('memory', 2200).path)).toBe('approved through the command\n')
  })

  it('refuses an id the plugin did not issue', async () => {
    await home()
    const text = await run('approve 20261019T101203-deadbeef')
    expect(text).toContain('kind: error')
    expect(text).toContain('MEMORY_PENDING_UNKNOWN: 20261019T101203-deadbeef')
  })

  it('refuses a path masquerading as an id', async () => {
    await home()
    const text = await run('approve ../../etc/passwd')
    expect(text).toContain('kind: error')
    expect(text).toContain('MEMORY_PENDING_UNKNOWN: ../../etc/passwd')
  })

  it('reports a stale approval and drops the pending file', async () => {
    const created = await home()
    const file = memoryStorePath(created.home)
    await writeStoreFile(file, ['the entry'])
    const outcome = await stageOperations({
      target: 'memory',
      directory: globalPendingDirectory('memory', pendingRoot()),
      sessionId: 's',
      source: 'tool',
      operations: [{ op: 'patch', old_text: 'the', text: 'renamed' }],
      document: { header: null, entries: ['the entry'] },
      limit: 2200,
      maxPerStore: 50,
    })
    const id = outcome.ids[0] ?? ''
    await writeStoreFile(file, ['edited by hand'])
    const text = await run(`approve ${id}`)
    expect(text).toContain('kind: error')
    expect(text).toContain('MEMORY_PENDING_STALE')
    expect(text).toContain(`dropped ${id}`)
    expect(await readdir(globalPendingDirectory('memory', pendingRoot()))).toEqual([])
  })

  it('refuses approve all past the operation bound and applies none', async () => {
    await home()
    const directory = globalPendingDirectory('memory', pendingRoot())
    for (let index = 0; index <= ALL_MAX_OPERATIONS; index += 1) {
      const id = `20261019T1012${String(index).padStart(2, '0')}-aaaaaaaa`
      await writePendingFile(path.join(directory, `${id}.json`), {
        createdAt: '2026-10-19T10:12:03.000Z',
        sessionId: 's',
        source: 'tool',
        target: 'memory',
        op: 'add',
        text: `note ${String(index)}`,
      })
    }
    const text = await run('approve all')
    expect(text).toContain('kind: error')
    expect(text).toContain('MEMORY_PENDING_ALL_LIMIT')
    expect(await readdir(directory)).toHaveLength(ALL_MAX_OPERATIONS + 1)
  })

  it('approves an oversized staged text when the id is named explicitly', async () => {
    await home()
    // Over the 64 KiB `approve all` bound; the store's own limit is raised so
    // that the only bound in play is the `all` one.
    const huge = 'z'.repeat(66_000)
    const config = { limits: { memory: 70_000 } }
    await stageOperations({
      target: 'memory',
      directory: globalPendingDirectory('memory', pendingRoot()),
      sessionId: 's',
      source: 'tool',
      operations: [{ op: 'add', text: huge }],
      document: { header: null, entries: [] },
      limit: 70_000,
      maxPerStore: 50,
    })
    const id = (await readdir(globalPendingDirectory('memory', pendingRoot())))[0]?.replace('.json', '') ?? ''
    // The same single operation is refused by `approve all`...
    const all = await run('approve all', { config })
    expect(all).toContain('MEMORY_PENDING_ALL_LIMIT')
    expect(await readdir(globalPendingDirectory('memory', pendingRoot()))).toHaveLength(1)
    // ...and applied when the id is named explicitly.
    const text = await run(`approve ${id}`, { config })
    expect(text).toContain('kind: success')
    expect(text).toContain('applied 1 of 1')
    expect(await readdir(globalPendingDirectory('memory', pendingRoot()))).toEqual([])
  })

  it('applies every pending operation with approve all', async () => {
    await home()
    // One batch, so the two operations keep the order they were staged in.
    await stageOperations({
      target: 'memory',
      directory: globalPendingDirectory('memory', pendingRoot()),
      sessionId: 'session-memory-test',
      source: 'tool',
      operations: [
        { op: 'add', text: 'one' },
        { op: 'add', text: 'two' },
      ],
      document: { header: null, entries: [] },
      limit: 2200,
      maxPerStore: 50,
    })
    const text = await run('approve all')
    expect(text).toContain('applied 2 of 2 selected staged operation(s)')
    expect(await readStoreFile(globalStore('memory', 2200).path)).toBe('one\n§\ntwo\n')
  })

  it('applies a patch of an entry the same batch added, because the batch keeps its order', async () => {
    await home()
    await stageOperations({
      target: 'memory',
      directory: globalPendingDirectory('memory', pendingRoot()),
      sessionId: 'session-memory-test',
      source: 'tool',
      operations: [
        { op: 'add', text: 'first version' },
        { op: 'patch', old_text: 'first', text: 'second' },
      ],
      document: { header: null, entries: [] },
      limit: 2200,
      maxPerStore: 50,
    })
    const text = await run('approve all')
    expect(text).toContain('applied 2 of 2 selected staged operation(s)')
    expect(await readStoreFile(globalStore('memory', 2200).path)).toBe('second version\n')
  })

  it('refuses all combined with an id', async () => {
    await home()
    const text = await run('approve all 20261019T101203-aaaaaaaa')
    expect(text).toContain("'all' cannot be combined with ids")
  })

  it('rejects an id without touching the store', async () => {
    await home()
    const id = await staged('dropped')
    const text = await run(`reject ${id}`)
    expect(text).toContain('rejected 1 of 1 selected staged operation(s)')
    expect(await readdir(globalPendingDirectory('memory', pendingRoot()))).toEqual([])
  })

  it('rejects everything with reject all', async () => {
    await home()
    await staged('one')
    await staged('two')
    const text = await run('reject all')
    expect(text).toContain('rejected 2 of 2 selected staged operation(s)')
  })

  it('asks for an id when none is given', async () => {
    await home()
    expect(await run('approve')).toContain('approve needs at least one id, or all')
    expect(await run('reject')).toContain('reject needs at least one id, or all')
  })
})

describe('/memory gitignore', () => {
  it.skipIf(!hasGit)('creates the block for a repository that has none', async () => {
    const root = await initRepo()
    const text = await run('gitignore', { agent: fakeAgent({ cwd: root }) })
    expect(text).toContain('kind: success')
    expect(text).toContain('created the managed block')
    expect(text).toContain('  .dsh/*')
    expect(await readStoreFile(path.join(root, '.gitignore'))).toContain('# >>> dsh-memory')
  })

  it.skipIf(!hasGit)('reports an already current block without writing', async () => {
    const root = await initRepo()
    await run('gitignore', { agent: fakeAgent({ cwd: root }) })
    const before = await readStoreFile(path.join(root, '.gitignore'))
    const text = await run('gitignore', { agent: fakeAgent({ cwd: root }) })
    expect(text).toContain('unchanged: the block already matches the expected lines')
    expect(await readStoreFile(path.join(root, '.gitignore'))).toBe(before)
    expect(MEMORY_USAGE).not.toContain('remove')
  })

  it.skipIf(!hasGit)('reports manageGitignore false with the block a person can paste', async () => {
    const root = await initRepo()
    const text = await run('gitignore', {
      agent: fakeAgent({ cwd: root }),
      config: { workspace: { enabled: true, manageGitignore: false } },
    })
    expect(text).toContain('MEMORY_NO_IGNORE_RULE')
    expect(text).toContain('Add this block to .gitignore by hand')
  })

  it('reports an unavailable workspace store', async () => {
    const plain = await useDshHome()
    homes.push(plain)
    const text = await run('gitignore', { agent: fakeAgent({ cwd: plain.home }) })
    expect(text).toContain('kind: error')
    expect(text).toContain('MEMORY_NO_WORKSPACE')
  })
})

describe('unknown subcommands', () => {
  it('shows the usage for no subcommand and for an unknown one, and never offers remove', async () => {
    await home()
    await home()
    expect(await run('')).toContain('usage: /memory <subcommand>')
    const text = await run('gitignore remove')
    expect(text).toContain('there is no `gitignore remove`')
    expect(text).toContain('workspace.manageGitignore: false')
    expect(await run('forget everything')).toContain("unknown subcommand 'forget'")
  })
})

describe('cleanup', () => {
  it('leaves nothing behind in the harness home', async () => {
    const created = await home()
    await rm(created.home, { recursive: true, force: true })
    expect(await readdir(created.home).catch(() => [])).toEqual([])
  })
})
