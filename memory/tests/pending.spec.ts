/**
 * Pending-store suite (DESIGN §4.5, sixth revision): staging, the accepted id
 * shape, the per-store bound, approval's re-check inside the lock, the drop
 * rules, and `approve all`'s bounds. There is deliberately no `issued.json`, so
 * every case here goes through the id form, the pending-directory realpath, the
 * file-name ⟷ JSON `id` agreement, and the `PendingOp` shape.
 * @module @anago-harness/memory/tests/pending
 */
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { AtomicWriteApi } from '@anago-harness/knowledge-common'
import { afterAll, afterEach, beforeEach, describe, expect, it, assert } from 'vitest'
import { isMemoryError } from '../src/errors.ts'
import {
  ALL_MAX_BYTES,
  ALL_MAX_OPERATIONS,
  approvePending,
  assertAllWithinLimits,
  countOtherWorkspacePending,
  globalPendingDirectory,
  listPending,
  type PendingDirectory,
  type PendingRecord,
  parsePendingOp,
  pendingDirectories,
  pendingId,
  pendingRoot,
  readPendingFile,
  rejectPending,
  selectPending,
  stageOperations,
  toMemoryOperation,
  workspacePendingDirectory,
  workspacePendingKey,
} from '../src/pending.ts'
import { globalStore, readStore, workspaceLocation } from '../src/store.ts'
import type { WorkspaceStore } from '../src/workspace.ts'
import {
  cleanupTempDirs,
  type DshHome,
  git,
  gitAvailable,
  initRepo,
  memoryStorePath,
  pendingFile,
  pendingOp,
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

/** Assert one call is refused with a code. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (isMemoryError(error)) return error.code
    throw error
  }
  throw new Error('the call was expected to fail')
}

/** The `memory` pending directory of a harness home. */
function memoryPending(home: string): string {
  return globalPendingDirectory('memory', path.join(home, 'memories', 'pending'))
}

describe('staging (DESIGN §4.5)', () => {
  it('records one file per operation, with the documented PendingOp shape', async () => {
    const created = await home()
    const directory = memoryPending(created.home)
    const outcome = await stageOperations({
      target: 'memory',
      directory,
      sessionId: 'session-1',
      source: 'tool',
      operations: [
        { op: 'add', text: 'a staged note' },
        { op: 'patch', old_text: 'old', text: 'new' },
        { op: 'remove', old_text: 'gone' },
      ],
      document: { header: null, entries: ['old entry', 'gone entry'] },
      limit: 2200,
      maxPerStore: 50,
      now: new Date('2026-10-19T10:12:03.000Z'),
    })
    expect(outcome.ids).toHaveLength(3)
    expect(outcome.applied).toEqual(['a staged note', 'new entry', 'gone entry'])
    expect(outcome.bases).toEqual([undefined, 'old entry', 'gone entry'])
    const names = (await readdir(directory)).sort()
    expect(names).toHaveLength(3)
    expect(names).toEqual([...outcome.ids].map(id => `${id}.json`).sort())
    for (const id of outcome.ids) {
      expect(id).toMatch(/^20261019T101203-[0-9a-f]{8}$/u)
      const record = JSON.parse(await readFile(path.join(directory, `${id}.json`), 'utf8')) as Record<
        string,
        unknown
      >
      expect(record.id).toBe(id)
      expect(record.createdAt).toBe('2026-10-19T10:12:03.000Z')
      expect(record.sessionId).toBe('session-1')
      expect(record.source).toBe('tool')
      expect(record.target).toBe('memory')
    }
    const first = JSON.parse(await readFile(path.join(directory, `${outcome.ids[0] ?? ''}.json`), 'utf8')) as Record<
      string,
      unknown
    >
    // An add carries no baseEntry; the patch does.
    expect('baseEntry' in first).toBe(false)
  })

  it('validates with the write path and stages nothing when the batch is refused', async () => {
    const created = await home()
    const directory = memoryPending(created.home)
    expect(
      await refusal(
        async () =>
          await stageOperations({
            target: 'memory',
            directory,
            sessionId: 's',
            source: 'tool',
            operations: [{ op: 'add', text: 'duplicate' }],
            document: { header: null, entries: ['duplicate'] },
            limit: 2200,
            maxPerStore: 50,
          }),
      ),
    ).toBe('MEMORY_DUPLICATE')
    expect(
      await refusal(
        async () =>
          await stageOperations({
            target: 'memory',
            directory,
            sessionId: 's',
            source: 'tool',
            operations: [{ op: 'remove', old_text: 'absent' }],
            document: { header: null, entries: ['other'] },
            limit: 2200,
            maxPerStore: 50,
          }),
      ),
    ).toBe('MEMORY_NOT_FOUND')
    expect(
      await refusal(
        async () =>
          await stageOperations({
            target: 'memory',
            directory,
            sessionId: 's',
            source: 'tool',
            operations: [{ op: 'add', text: 'x'.repeat(3000) }],
            document: { header: null, entries: [] },
            limit: 2200,
            maxPerStore: 50,
          }),
      ),
    ).toBe('MEMORY_LIMIT_EXCEEDED')
    expect(await readdir(directory).catch(() => [])).toEqual([])
  })

  it('refuses at the per-store bound without writing anything', async () => {
    const created = await home()
    const directory = memoryPending(created.home)
    const stage = async (text: string): Promise<void> => {
      await stageOperations({
        target: 'memory',
        directory,
        sessionId: 's',
        source: 'tool',
        operations: [{ op: 'add', text }],
        document: { header: null, entries: [] },
        limit: 2200,
        maxPerStore: 2,
      })
    }
    await stage('one')
    await stage('two')
    expect(await refusal(async () =>{  await stage('three') })).toBe('MEMORY_PENDING_FULL')
    expect(await readdir(directory)).toHaveLength(2)
  })
})

describe('the accepted id (DESIGN §4.5)', () => {
  const directory: PendingDirectory = {
    target: 'memory',
    directory: '/tmp/pending/memory',
  }

  it('accepts a well-formed record', async () => {
    const created = await home()
    const dir = memoryPending(created.home)
    const file = path.join(dir, '20261019T101203-a1b2c3d4.json')
    await writePendingFile(file, {
      createdAt: '2026-10-19T10:12:03.000Z',
      sessionId: 's',
      source: 'tool',
      target: 'memory',
      op: 'add',
      text: 'note',
    })
    const record = await readPendingFile(file, { ...directory, directory: dir })
    expect(record.op.op).toBe('add')
  })

  it('refuses a file name that is not an id', async () => {
    const created = await home()
    const dir = memoryPending(created.home)
    const file = path.join(dir, 'notes.json')
    await writePendingFile(file, { createdAt: '2026-10-19T10:12:03.000Z', sessionId: 's', source: 'tool', target: 'memory', op: 'add', text: 'note' })
    expect(await refusal(async () => await readPendingFile(file, { ...directory, directory: dir }))).toBe(
      'MEMORY_PENDING_UNKNOWN',
    )
  })

  it('refuses a JSON id that disagrees with the file name', async () => {
    const created = await home()
    const dir = memoryPending(created.home)
    const file = path.join(dir, '20261019T101203-a1b2c3d4.json')
    await writePendingFile(file, {
      id: '20261019T101203-deadbeef',
      createdAt: '2026-10-19T10:12:03.000Z',
      sessionId: 's',
      source: 'tool',
      target: 'memory',
      op: 'add',
      text: 'note',
    })
    expect(await refusal(async () => await readPendingFile(file, { ...directory, directory: dir }))).toBe(
      'MEMORY_PENDING_UNKNOWN',
    )
  })

  it('refuses a shape that is not a PendingOp', () => {
    const id = '20261019T101203-a1b2c3d4'
    const base = {
      id,
      createdAt: '2026-10-19T10:12:03.000Z',
      sessionId: 's',
      source: 'tool',
      target: 'memory',
    }
    const cases: unknown[] = [
      { ...base, op: 'add' },
      { ...base, op: 'add', text: 'x', baseEntry: 'stale' },
      { ...base, op: 'patch', text: 'x', old_text: 'y' },
      { ...base, op: 'remove', old_text: 'y' },
      { ...base, op: 'rename', text: 'x' },
      { ...base, op: 'add', text: 'x', target: 'global-wiki' },
      { ...base, op: 'add', text: 'x', source: 'review', extra: true },
      { ...base, id: '20261019T101203-deadbeef', op: 'add', text: 'x' },
      'not an object',
    ]
    for (const value of cases) {
      expect(() => parsePendingOp(value, id, 'file')).toThrow(/MEMORY_PENDING_UNKNOWN/u)
    }
    expect(parsePendingOp({ ...base, op: 'add', text: 'x' }, id, 'file').op).toBe('add')
  })

  it('refuses a record whose target disagrees with the directory it sits in', async () => {
    const created = await home()
    const dir = memoryPending(created.home)
    const file = path.join(dir, '20261019T101203-a1b2c3d4.json')
    await writePendingFile(file, {
      createdAt: '2026-10-19T10:12:03.000Z',
      sessionId: 's',
      source: 'tool',
      target: 'workspace',
      op: 'add',
      text: 'not this store',
    })
    expect(await refusal(async () => await readPendingFile(file, { ...directory, directory: dir }))).toBe(
      'MEMORY_PENDING_UNKNOWN',
    )
  })

  it('refuses a symlink that resolves outside the pending directory', async () => {
    const created = await home()
    const dir = memoryPending(created.home)
    await mkdir(dir, { recursive: true })
    const outside = path.join(created.home, 'outside.json')
    await writeFile(outside, JSON.stringify(pendingOp({ id: '20261019T101203-a1b2c3d4' })))
    const file = path.join(dir, '20261019T101203-a1b2c3d4.json')
    await symlink(outside, file)
    expect(await refusal(async () => await readPendingFile(file, { ...directory, directory: dir }))).toBe(
      'MEMORY_PENDING_UNKNOWN',
    )
  })
})

describe('listing and selection', () => {
  it('lists the addressable stores only, sorted by id', async () => {
    await home()
    const root = pendingRoot()
    await writePendingFile(path.join(globalPendingDirectory('memory', root), '20261019T101204-bbbbbbbb.json'), {
      createdAt: '2026-10-19T10:12:04.000Z',
      sessionId: 's',
      source: 'tool',
      target: 'memory',
      op: 'add',
      text: 'second',
    })
    await writePendingFile(path.join(globalPendingDirectory('user', root), '20261019T101203-aaaaaaaa.json'), {
      createdAt: '2026-10-19T10:12:03.000Z',
      sessionId: 's',
      source: 'review',
      target: 'user',
      op: 'add',
      text: 'first',
    })
    // A workspace pending of another repository is not addressable here.
    await writePendingFile(path.join(workspacePendingDirectory('other-key', root), '20261019T101205-cccccccc.json'), {
      createdAt: '2026-10-19T10:12:05.000Z',
      sessionId: 's',
      source: 'tool',
      target: 'workspace',
      op: 'add',
      text: 'elsewhere',
    })
    const directories = pendingDirectories({}, root)
    const { records, problems } = await listPending(directories)
    expect(problems).toEqual([])
    expect(records.map(record => record.op.id)).toEqual([
      '20261019T101203-aaaaaaaa',
      '20261019T101204-bbbbbbbb',
    ])
    expect(await countOtherWorkspacePending(root, undefined)).toBe(1)
    expect(await countOtherWorkspacePending(root, 'other-key')).toBe(0)
  })

  it('reports a file that is not usable instead of failing the listing', async () => {
    const created = await home()
    void created
    const root = pendingRoot()
    const directory = globalPendingDirectory('memory', root)
    await writePendingFile(path.join(directory, 'notes.txt'), {})
    await writePendingFile(path.join(directory, '20261019T101203-aaaaaaaa.json'), {
      createdAt: '2026-10-19T10:12:03.000Z',
      sessionId: 's',
      source: 'tool',
      target: 'memory',
      op: 'add',
      text: 'fine',
    })
    const { records, problems } = await listPending(pendingDirectories({}, root))
    expect(records).toHaveLength(1)
    expect(problems).toHaveLength(1)
  })

  it('selects ids explicitly, reports unknown ones, and understands all', async () => {
    const created = await home()
    void created
    const root = pendingRoot()
    const directory = globalPendingDirectory('memory', root)
    await writePendingFile(path.join(directory, '20261019T101203-aaaaaaaa.json'), {
      createdAt: '2026-10-19T10:12:03.000Z',
      sessionId: 's',
      source: 'tool',
      target: 'memory',
      op: 'add',
      text: 'one',
    })
    const directories = pendingDirectories({}, root)
    const one = await selectPending(['20261019T101203-aaaaaaaa'], directories)
    expect(one.records).toHaveLength(1)
    expect(one.unknown).toEqual([])
    const bad = await selectPending(['20261019T101203-deadbeef', '../../etc/passwd'], directories)
    expect(bad.records).toEqual([])
    expect(bad.unknown).toEqual(['20261019T101203-deadbeef', '../../etc/passwd'])
    const all = await selectPending('all', directories)
    expect(all.records).toHaveLength(1)
  })
})

describe('approve all limits (DESIGN §4.5)', () => {
  const record = (index: number, text: string): PendingRecord =>
    ({
      op: pendingOp({ id: `20261019T1012${String(index).padStart(2, '0')}-aaaaaaaa`, text }),
      file: `/tmp/${String(index)}.json`,
      directory: { target: 'memory', directory: '/tmp' },
    })

  it('refuses more than 20 operations, and applies none', () => {
    const records = Array.from({ length: ALL_MAX_OPERATIONS + 1 }, (_value, index) => record(index, 'x'))
    expect(() =>{  assertAllWithinLimits(records) }).toThrow(/MEMORY_PENDING_ALL_LIMIT/u)
  })

  it('refuses more than 64 KiB of text', () => {
    const records = [record(1, 'y'.repeat(ALL_MAX_BYTES)), record(2, 'z'.repeat(ALL_MAX_BYTES))]
    expect(() =>{  assertAllWithinLimits(records) }).toThrow(/MEMORY_PENDING_ALL_LIMIT/u)
  })

  it('accepts exactly the bounds', () => {
    const records = [record(1, 'x'.repeat(100))]
    expect(() =>{  assertAllWithinLimits(records) }).not.toThrow()
  })
})

describe('approval (DESIGN §4.5)', () => {
  /** The store and pending directory of a fresh harness home. */
  async function staged(text: string, entries: readonly string[] = []): Promise<{
    id: string
    file: string
    directory: string
    location: ReturnType<typeof globalStore>
  }> {
    const created = await home()
    const directory = memoryPending(created.home)
    const outcome = await stageOperations({
      target: 'memory',
      directory,
      sessionId: 's',
      source: 'tool',
      operations: [{ op: 'add', text }],
      document: { header: null, entries: [...entries] },
      limit: 2200,
      maxPerStore: 50,
    })
    const id = outcome.ids[0] ?? ''
    return { id, file: pendingFile(directory, `${id}.json`), directory, location: globalStore('memory', 2200) }
  }

  it('applies a staged add and removes the pending file', async () => {
    const { id, file, location } = await staged('approved note')
    const records = await selectPending([id], pendingDirectories({}, pendingRoot()))
    const outcomes = await approvePending(records.records, {
      locationFor: async () => location,
      api,
      lockWaitMs: 5000,
      logger: recordingLogger(),
    })
    expect(outcomes).toEqual([{ id, target: 'memory', ok: true }])
    expect(await readStoreFile(location.path)).toBe('approved note\n')
    expect(await readdir(path.dirname(file))).toEqual([])
  })

  it('applies a patch whose baseEntry is still there, and drops one that changed', async () => {
    const created = await home()
    const directory = memoryPending(created.home)
    const file = memoryStorePath(created.home)
    await writeStoreFile(file, ['keep me', 'replace me'])
    const outcome = await stageOperations({
      target: 'memory',
      directory,
      sessionId: 's',
      source: 'tool',
      operations: [{ op: 'patch', old_text: 'replace', text: 'replaced' }],
      document: { header: null, entries: ['keep me', 'replace me'] },
      limit: 2200,
      maxPerStore: 50,
    })
    const id = outcome.ids[0] ?? ''
    const location = globalStore('memory', 2200)
    const records = await selectPending([id], pendingDirectories({}, pendingRoot()))
    const outcomes = await approvePending(records.records, {
      locationFor: async () => location,
      api,
      lockWaitMs: 5000,
      logger: recordingLogger(),
    })
    expect(outcomes[0]?.ok).toBe(true)
    expect(await readStoreFile(file)).toBe('keep me\n§\nreplaced me\n')
  })

  it('drops a staged patch when the entry it selected is gone, and writes nothing', async () => {
    const created = await home()
    const directory = memoryPending(created.home)
    const file = memoryStorePath(created.home)
    await writeStoreFile(file, ['the entry'])
    const outcome = await stageOperations({
      target: 'memory',
      directory,
      sessionId: 's',
      source: 'tool',
      operations: [{ op: 'patch', old_text: 'the', text: 'renamed' }],
      document: { header: null, entries: ['the entry'] },
      limit: 2200,
      maxPerStore: 50,
    })
    const id = outcome.ids[0] ?? ''
    // A direct edit (N2) replaces the entry the staged operation selected.
    await writeStoreFile(file, ['something else entirely'])
    const records = await selectPending([id], pendingDirectories({}, pendingRoot()))
    const logger = recordingLogger()
    const outcomes = await approvePending(records.records, {
      locationFor: async () => globalStore('memory', 2200),
      api,
      lockWaitMs: 5000,
      logger,
    })
    const [first] = outcomes
    assert(first !== undefined && !first.ok)
    expect(first.code).toBe('MEMORY_PENDING_STALE')
    expect(first.dropped).toBe(true)
    expect(await readStoreFile(file)).toBe('something else entirely\n')
    expect(await readdir(directory)).toEqual([])
    expect(logger.warnings.join('\n')).toMatch(/dropped the staged operation/u)
  })

  it('drops a staged add that became a duplicate', async () => {
    const created = await home()
    const directory = memoryPending(created.home)
    const file = memoryStorePath(created.home)
    await writeStoreFile(file, [])
    const outcome = await stageOperations({
      target: 'memory',
      directory,
      sessionId: 's',
      source: 'tool',
      operations: [{ op: 'add', text: 'same note' }],
      document: { header: null, entries: [] },
      limit: 2200,
      maxPerStore: 50,
    })
    await writeStoreFile(file, ['same note'])
    const records = await selectPending(outcome.ids, pendingDirectories({}, pendingRoot()))
    const outcomes = await approvePending(records.records, {
      locationFor: async () => globalStore('memory', 2200),
      api,
      lockWaitMs: 5000,
      logger: recordingLogger(),
    })
    const [first] = outcomes
    assert(first !== undefined && !first.ok)
    expect(first.code).toBe('MEMORY_PENDING_STALE')
    expect(first.message).toMatch(/MEMORY_DUPLICATE/u)
    expect(first.dropped).toBe(true)
    expect(await readdir(directory)).toEqual([])
  })

  it('keeps the pending file when the store cannot be reached at all', async () => {
    const { id, directory } = await staged('kept note')
    const records = await selectPending([id], pendingDirectories({}, pendingRoot()))
    const outcomes = await approvePending(records.records, {
      locationFor: async () => {
        throw new Error('no workspace')
      },
      api,
      lockWaitMs: 5000,
      logger: recordingLogger(),
    })
    const [first] = outcomes
    assert(first !== undefined && !first.ok)
    expect(first.dropped).toBe(false)
    expect(await readdir(directory)).toHaveLength(1)
  })

  it('rejects a staged operation without touching the store', async () => {
    const created = await home()
    const { id, directory } = await staged('dropped note')
    const records = await selectPending([id], pendingDirectories({}, pendingRoot()))
    const outcomes = await rejectPending(records.records)
    expect(outcomes).toEqual([{ id, target: 'memory', ok: true }])
    expect(await readdir(directory)).toEqual([])
    expect(await readStore(globalStore('memory', 2200))).toMatchObject({ exists: false })
    expect(memoryStorePath(created.home)).toContain('MEMORY.md')
  })

  it('projects a staged operation back onto the tool operation it came from', () => {
    expect(
      toMemoryOperation({
        id: 'x',
        createdAt: '2026-10-19T10:12:03.000Z',
        sessionId: 's',
        source: 'tool',
        target: 'memory',
        op: 'remove',
        old_text: 'y',
        baseEntry: 'y',
      }),
    ).toEqual({ op: 'remove', old_text: 'y' })
  })
})

describe('workspace pendings', () => {
  it.skipIf(!hasGit)('are keyed by the canonical root and approved through the store', async () => {
    const created = await home()
    const root = await initRepo()
    git(root, ['config', 'user.email', 'test@example.com'])
    const key = workspacePendingKey(root)
    const directory = workspacePendingDirectory(key, path.join(created.home, 'memories', 'pending'))
    const outcome = await stageOperations({
      target: 'workspace',
      directory,
      sessionId: 's',
      source: 'tool',
      operations: [{ op: 'add', text: 'repo note' }],
      document: { header: null, entries: [] },
      limit: 2200,
      maxPerStore: 50,
    })
    const directories = pendingDirectories({ workspaceKey: key }, path.join(created.home, 'memories', 'pending'))
    const { records } = await listPending(directories)
    expect(records).toHaveLength(1)
    const store: WorkspaceStore = {
      root,
      checkoutRoot: root,
      file: path.join(root, '.dsh', 'memory', 'MEMORY.md'),
      gitignore: path.join(root, '.gitignore'),
      worktree: false,
    }
    const outcomes = await approvePending(records, {
      locationFor: async () => workspaceLocation(store, 2200),
      api,
      lockWaitMs: 5000,
      logger: recordingLogger(),
    })
    expect(outcomes[0]?.ok).toBe(true)
    expect(await readStoreFile(store.file)).toBe('repo note\n')
    expect(await readdir(directory)).toEqual([])
    // The fixture's own file is gone, and the workspace store is separate.
    expect(outcome.ids).toHaveLength(1)
  })
})

describe('id and directory helpers', () => {
  it('stamps the id in UTC and keys a workspace by its root digest', () => {
    expect(pendingId(new Date('2026-10-19T10:12:03.000Z'), 'a1b2c3d4')).toBe('20261019T101203-a1b2c3d4')
    expect(workspacePendingKey('/repo')).toMatch(/^[0-9a-f]{64}$/u)
    expect(workspacePendingKey('/repo')).toBe(workspacePendingKey('/repo'))
  })

  it('removes a staged file it cannot roll back only by best effort', async () => {
    const created = await home()
    void created
    const root = pendingRoot()
    expect(globalPendingDirectory('user', root)).toBe(path.join(root, 'user'))
    await rm(root, { recursive: true, force: true })
  })
})
