/**
 * Pending-store edge cases (DESIGN §4.5, sixth revision): the closed
 * `PendingOp` shape, the files that claim to be pending operations but are not
 * usable, the two refusal sides of staging, the rollback of a batch whose write
 * failed halfway, and the id-collision retry that keeps a batch's records
 * apart.
 *
 * `stageOperations` names each record from `randomBytes(4)`, so the collision
 * cases seed that one nondeterministic input (the id's hex suffix) instead of
 * waiting for a 32-bit collision; every file they assert on is a real file.
 * @module @anago-harness/memory/tests/pending-edges
 */
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { AtomicWriteApi } from '@anago-harness/knowledge-common'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, assert } from 'vitest'
import { isMemoryError } from '../src/errors.ts'
import {
  ALL_MAX_BYTES,
  approvePending,
  assertAllWithinLimits,
  globalPendingDirectory,
  type PendingDirectory,
  type PendingOp,
  type PendingRecord,
  parsePendingOp,
  pendingDirectories,
  pendingRoot,
  readPendingFile,
  rejectPending,
  selectPending,
  stageOperations,
} from '../src/pending.ts'
import { globalStore } from '../src/store.ts'
import {
  cleanupTempDirs,
  type DshHome,
  pendingFile,
  readStoreFile,
  recordingLogger,
  useDshHome,
  writePendingFile,
  writeStoreFile,
} from './support.ts'

/**
 * The one nondeterministic input of the staging path: the 32-bit seed a batch's
 * eight hex digits count up from. Leaving it unset keeps the real generator, so
 * only the collision cases make the names predictable.
 */
const entropy = vi.hoisted(() => ({ seed: undefined as number | undefined }))

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    randomBytes: (size: number): Buffer => {
      if (entropy.seed === undefined || size !== 4) return actual.randomBytes(size)
      const buffer = Buffer.alloc(size)
      buffer.writeUInt32BE(entropy.seed, 0)
      return buffer
    },
  }
})

const api: AtomicWriteApi = { withFileLock, writeFileAtomic }
const homes: DshHome[] = []
const STAMP = new Date('2026-10-19T10:12:03.000Z')
const STAMP_ISO = '2026-10-19T10:12:03.000Z'
const STAMP_ID = '20261019T101203'
const canCreateUnreadable = process.platform !== 'win32' && process.getuid?.() !== 0

beforeEach(async () => {
  homes.push(await useDshHome())
})
afterEach(() => {
  entropy.seed = undefined
  // Reverse order: a test that redirects twice must end on the value the file
  // started with, not on a temporary directory that cleanup removes.
  for (const home of homes.splice(0).reverse()) home.restore()
})
afterAll(cleanupTempDirs)

/** A harness home with `$DSH_HOME` redirected, for a test needing a second one. */
async function home(): Promise<DshHome> {
  const created = await useDshHome()
  homes.push(created)
  return created
}

/** The `memory` pending directory of a harness home. */
function memoryPending(dir: string): string {
  return globalPendingDirectory('memory', path.join(dir, 'memories', 'pending'))
}

/** The code of a refused promise. */
async function refusalCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (isMemoryError(error)) return error.code
    throw error
  }
  throw new Error('the call was expected to fail')
}

/** The refusal message of a refused staging call. */
async function stageFailure(input: Parameters<typeof stageOperations>[0]): Promise<string> {
  try {
    await stageOperations(input)
  } catch (error) {
    if (error instanceof Error) return error.message
    throw error
  }
  throw new Error('the staging call was expected to fail')
}

/** One staging input over an empty store. */
function stageInput(
  directory: string,
  operations: Parameters<typeof stageOperations>[0]['operations'],
): Parameters<typeof stageOperations>[0] {
  return {
    target: 'memory',
    directory,
    sessionId: 'session-memory-test',
    source: 'tool',
    operations,
    document: { header: null, entries: [] },
    limit: 2200,
    maxPerStore: 50,
    now: STAMP,
  }
}

/** One complete add operation, as the parsed shape requires it. */
function addOp(id: string, text: string): PendingOp {
  return {
    id,
    createdAt: STAMP_ISO,
    sessionId: 'session-memory-test',
    source: 'tool',
    target: 'memory',
    op: 'add',
    text,
  }
}

describe('the closed PendingOp shape (DESIGN §4.5)', () => {
  const id = `${STAMP_ID}-a1b2c3d4`
  const base = addOp(id, 'note')

  /** The message `parsePendingOp` refused one value with. */
  function shapeRefusal(raw: unknown): string {
    try {
      parsePendingOp(raw, id, 'file')
    } catch (error) {
      if (isMemoryError(error)) return error.message
      throw error
    }
    throw new Error('the record was expected to be refused')
  }

  it('requires an ISO-8601 createdAt and a string sessionId', () => {
    expect(shapeRefusal({ ...base, createdAt: 5 })).toContain('`createdAt` must be an ISO-8601 instant')
    expect(shapeRefusal({ ...base, createdAt: 'yesterday' })).toContain(
      '`createdAt` must be an ISO-8601 instant',
    )
    expect(shapeRefusal({ ...base, sessionId: 5 })).toContain('`sessionId` must be a string')
  })

  it('requires the two documented sources and string optional fields', () => {
    expect(shapeRefusal({ ...base, source: 'worker' })).toContain('`source` must be tool or review')
    expect(shapeRefusal({ ...base, text: 5 })).toContain('`text` must be a string')
    expect(shapeRefusal({ ...base, op: 'patch', old_text: 5, baseEntry: 'x' })).toContain(
      '`old_text` must be a string',
    )
    expect(shapeRefusal({ ...base, op: 'patch', old_text: 'x', baseEntry: 5 })).toContain(
      '`baseEntry` must be a string',
    )
  })

  it('requires a patch to carry text and a selector', () => {
    expect(shapeRefusal({ ...base, op: 'patch', text: '  ', old_text: 'x', baseEntry: 'x' })).toContain(
      'a patch requires a non-empty `text`',
    )
    expect(shapeRefusal({ ...base, op: 'patch', text: 'x', baseEntry: 'x' })).toContain(
      'a patch requires `old_text`',
    )
  })

  it('requires a remove to carry a non-empty selector', () => {
    expect(shapeRefusal({ ...base, op: 'remove', old_text: '', baseEntry: 'x' })).toContain(
      'a remove requires `old_text`',
    )
    expect(shapeRefusal({ ...base, op: 'remove', old_text: 5, baseEntry: 'x' })).toContain(
      '`old_text` must be a string',
    )
  })

  it('accepts a complete remove', () => {
    const op = parsePendingOp({ ...base, op: 'remove', old_text: 'x', baseEntry: 'x entry' }, id, 'file')
    expect(op).toMatchObject({ op: 'remove', old_text: 'x', baseEntry: 'x entry' })
  })
})

describe('files that claim to be pending operations (DESIGN §4.5)', () => {
  const id = `${STAMP_ID}-a1b2c3d4`

  /** A pending directory and the addressable descriptor for it. */
  async function pendingDirectory(): Promise<{ directory: string; addressable: PendingDirectory }> {
    const created = await home()
    const directory = memoryPending(created.home)
    await mkdir(directory, { recursive: true })
    return { directory, addressable: { target: 'memory', directory } }
  }

  it('refuses a candidate that could not be stat-ed', async () => {
    const { directory, addressable } = await pendingDirectory()
    expect(
      await refusalCode(async () => await readPendingFile(path.join(directory, `${id}.json`), addressable)),
    ).toBe('MEMORY_PENDING_UNKNOWN')
  })

  it('refuses a directory named like a pending id', async () => {
    const { directory, addressable } = await pendingDirectory()
    const file = path.join(directory, `${id}.json`)
    await mkdir(file)
    expect(await refusalCode(async () => await readPendingFile(file, addressable))).toBe(
      'MEMORY_PENDING_UNKNOWN',
    )
  })

  it.skipIf(!canCreateUnreadable)('refuses a file it may not read and leaves it alone', async () => {
    const { directory, addressable } = await pendingDirectory()
    const file = path.join(directory, `${id}.json`)
    await writePendingFile(file, {
      createdAt: STAMP_ISO,
      sessionId: 's',
      source: 'tool',
      target: 'memory',
      op: 'add',
      text: 'sealed',
    })
    await chmod(file, 0o000)
    try {
      expect(await refusalCode(async () => await readPendingFile(file, addressable))).toBe(
        'MEMORY_PENDING_UNKNOWN',
      )
      expect(await readdir(directory)).toEqual([`${id}.json`])
    } finally {
      await chmod(file, 0o600)
    }
  })

  it('refuses a file that is not JSON', async () => {
    const { directory, addressable } = await pendingDirectory()
    const file = path.join(directory, `${id}.json`)
    await writeFile(file, '{ this is not json', { mode: 0o600 })
    expect(await refusalCode(async () => await readPendingFile(file, addressable))).toBe(
      'MEMORY_PENDING_UNKNOWN',
    )
  })
})

describe('staging refusals (DESIGN §4.5)', () => {
  it('reports MEMORY_IO when the pending directory cannot be created', async () => {
    const created = await home()
    const blocker = path.join(created.home, 'not-a-directory')
    await writeFile(blocker, 'a file where a directory is needed')
    const directory = path.join(blocker, 'pending')
    const message = await stageFailure(stageInput(directory, [{ op: 'add', text: 'never staged' }]))
    expect(message).toContain('MEMORY_IO')
    expect(message).toContain('could not be created')
    expect(message).toContain('nothing was staged')
  })

  it.skipIf(!canCreateUnreadable)('reports MEMORY_IO when a record cannot be written', async () => {
    const created = await home()
    const directory = memoryPending(created.home)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    // Read and execute, but no write: the directory exists for `mkdir` and the
    // batch's first file write is refused.
    await chmod(directory, 0o500)
    try {
      const message = await stageFailure(stageInput(directory, [{ op: 'add', text: 'never staged' }]))
      expect(message).toContain('MEMORY_IO')
      expect(message).toContain('could not be written')
      expect(await readdir(directory)).toEqual([])
    } finally {
      await chmod(directory, 0o700)
    }
  })
})

describe('id collisions (DESIGN §4.5)', () => {
  /** The record one written pending file carries. */
  async function storedText(file: string): Promise<string> {
    const record = JSON.parse(await readFile(file, 'utf8')) as { text?: string }
    return record.text ?? ''
  }

  it('skips a name that is already taken instead of overwriting the file', async () => {
    const created = await home()
    const directory = memoryPending(created.home)
    await mkdir(directory, { recursive: true })
    const planted = pendingFile(directory, `${STAMP_ID}-00000010.json`)
    await writePendingFile(planted, {
      createdAt: STAMP_ISO,
      sessionId: 'someone-else',
      source: 'tool',
      target: 'memory',
      op: 'add',
      text: 'planted record',
    })
    entropy.seed = 0x10
    const outcome = await stageOperations(stageInput(directory, [{ op: 'add', text: 'staged note' }]))
    // The first name was taken, so the batch took the next suffix.
    expect(outcome.ids).toEqual([`${STAMP_ID}-00000011`])
    expect(await storedText(planted)).toBe('planted record')
    expect(await storedText(pendingFile(directory, `${STAMP_ID}-00000011.json`))).toBe('staged note')
  })

  it('rolls back the records it wrote when every remaining name is taken', async () => {
    const created = await home()
    const directory = memoryPending(created.home)
    await mkdir(directory, { recursive: true })
    // The first operation takes 00000020; all four names the second operation
    // would try are planted, so the batch fails after one file was written.
    const planted: string[] = []
    for (const suffix of ['00000021', '00000022', '00000023', '00000024']) {
      const file = pendingFile(directory, `${STAMP_ID}-${suffix}.json`)
      await writePendingFile(file, {
        createdAt: STAMP_ISO,
        sessionId: 'someone-else',
        source: 'tool',
        target: 'memory',
        op: 'add',
        text: `planted ${suffix}`,
      })
      planted.push(`${STAMP_ID}-${suffix}.json`)
    }
    entropy.seed = 0x20
    const message = await stageFailure(
      stageInput(directory, [
        { op: 'add', text: 'first' },
        { op: 'add', text: 'second' },
      ]),
    )
    expect(message).toContain('MEMORY_IO')
    expect(message).toContain('kept naming collisions')
    expect(message).toContain('nothing was staged')
    // The operation that did land was removed again; only the planted records remain.
    expect((await readdir(directory)).sort()).toEqual([...planted].sort())
  })
})

describe('approval and rejection edge cases (DESIGN §4.5)', () => {
  it('drops a staged selector whose base entry was never recorded', async () => {
    const created = await home()
    const directory = memoryPending(created.home)
    const location = globalStore('memory', 2200)
    await writeStoreFile(location.path, ['kept entry'])
    const id = `${STAMP_ID}-aaaaaaaa`
    const staged: PendingRecord = {
      // `remove` without `baseEntry`: the guard falls back to an empty base,
      // which no stored entry can equal.
      op: {
        id,
        createdAt: STAMP_ISO,
        sessionId: 'session-memory-test',
        source: 'tool',
        target: 'memory',
        op: 'remove',
        old_text: 'kept',
      },
      file: pendingFile(directory, `${id}.json`),
      directory: { target: 'memory', directory },
    }
    const logger = recordingLogger()
    const outcomes = await approvePending([staged], {
      locationFor: async () => location,
      api,
      lockWaitMs: 5000,
      logger,
    })
    expect(outcomes[0]).toMatchObject({ ok: false, code: 'MEMORY_PENDING_STALE', dropped: true })
    expect(logger.warnings.join('\n')).toContain('dropped the staged operation')
    expect(await readStoreFile(location.path)).toBe('kept entry\n')
  })

  it('reports one record it could not remove without failing the rest', async () => {
    const created = await home()
    const directory = memoryPending(created.home)
    await mkdir(directory, { recursive: true })
    const goneId = `${STAMP_ID}-bbbbbbbb`
    const keptId = `${STAMP_ID}-cccccccc`
    const kept = pendingFile(directory, `${keptId}.json`)
    await writePendingFile(kept, {
      createdAt: STAMP_ISO,
      sessionId: 's',
      source: 'tool',
      target: 'memory',
      op: 'add',
      text: 'dropped by hand',
    })
    const outcomes = await rejectPending([
      {
        op: addOp(goneId, 'already removed'),
        file: pendingFile(directory, `${goneId}.json`),
        directory: { target: 'memory', directory },
      },
      { op: addOp(keptId, 'dropped by hand'), file: kept, directory: { target: 'memory', directory } },
    ])
    expect(outcomes[0]).toMatchObject({ id: goneId, ok: false, code: 'MEMORY_IO' })
    const [first] = outcomes
    assert(first !== undefined && !first.ok)
    expect(first.message).toContain('could not be removed')
    expect(outcomes[1]).toEqual({ id: keptId, target: 'memory', ok: true })
    expect(await readdir(directory)).toEqual([])
  })
})

describe('selection and the approve-all bound', () => {
  it('selects each id once and sorts the selection by id', async () => {
    await home()
    const root = pendingRoot()
    const directory = globalPendingDirectory('memory', root)
    for (const [id, text] of [
      [`${STAMP_ID}-bbbbbbbb`, 'later'],
      [`${STAMP_ID}-aaaaaaaa`, 'earlier'],
    ] as const) {
      await writePendingFile(pendingFile(directory, `${id}.json`), {
        createdAt: STAMP_ISO,
        sessionId: 's',
        source: 'tool',
        target: 'memory',
        op: 'add',
        text,
      })
    }
    const selection = await selectPending(
      [`${STAMP_ID}-bbbbbbbb`, `${STAMP_ID}-aaaaaaaa`, `${STAMP_ID}-bbbbbbbb`],
      pendingDirectories({}, root),
    )
    expect(selection.unknown).toEqual([])
    expect(selection.records.map(entry => entry.op.id)).toEqual([
      `${STAMP_ID}-aaaaaaaa`,
      `${STAMP_ID}-bbbbbbbb`,
    ])
  })

  it('counts text and selector bytes together against the bound', () => {
    const half = Math.floor(ALL_MAX_BYTES / 2) + 1
    const record = (index: number, op: PendingOp): PendingRecord => ({
      op,
      file: `/tmp/${String(index)}.json`,
      directory: { target: 'memory', directory: '/tmp' },
    })
    const add = record(1, addOp(`${STAMP_ID}-00000001`, 'x'.repeat(half)))
    // A remove carries a selector and no text at all.
    const remove = record(2, {
      id: `${STAMP_ID}-00000002`,
      createdAt: STAMP_ISO,
      sessionId: 'session-memory-test',
      source: 'tool',
      target: 'memory',
      op: 'remove',
      old_text: 'y'.repeat(half),
    })
    // Each half fits on its own; together they exceed the bound.
    expect(() => {
      assertAllWithinLimits([add])
    }).not.toThrow()
    expect(() => {
      assertAllWithinLimits([remove])
    }).not.toThrow()
    expect(() => {
      assertAllWithinLimits([add, remove])
    }).toThrow(/MEMORY_PENDING_ALL_LIMIT/u)
  })
})
