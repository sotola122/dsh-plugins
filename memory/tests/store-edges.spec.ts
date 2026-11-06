/**
 * Store edge cases (DESIGN §4.1, §4.2): a store file whose path is a directory
 * (an unreadable store rather than a missing one), the `MEMORY_IO` mapping for
 * a filesystem failure inside the locked update, and the snapshot's formatting
 * branches — a zero limit, a store with no entries, and the plural refused
 * count.
 * @module @anago-harness/memory/tests/store-edges
 */
import { mkdir, stat } from 'node:fs/promises'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { AtomicWriteApi } from '@anago-harness/knowledge-common'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { isMemoryError } from '../src/errors.ts'
import {
  buildSnapshot,
  renderStoreSection,
  storeHeading,
  type RenderedStore,
} from '../src/snapshot.ts'
import { globalStore, readStore, updateStore } from '../src/store.ts'
import { cleanupTempDirs, type DshHome, useDshHome } from './support.ts'

const api: AtomicWriteApi = { withFileLock, writeFileAtomic }
const homes: DshHome[] = []

afterEach(() => {
  for (const home of homes.splice(0).reverse()) home.restore()
})
afterAll(cleanupTempDirs)

/** A harness home with `$DSH_HOME` redirected. */
async function home(): Promise<DshHome> {
  const created = await useDshHome()
  homes.push(created)
  return created
}

/** The code and message of a refused promise. */
async function refusal(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run()
  } catch (error) {
    if (isMemoryError(error)) return { code: error.code, message: error.message }
    throw error
  }
  throw new Error('the call was expected to fail')
}

describe('a store that exists but cannot be read (DESIGN §4.1)', () => {
  /** A memory store whose path is a directory instead of a file. */
  async function blockedStore(): Promise<ReturnType<typeof globalStore>> {
    await home()
    const location = globalStore('memory', 2200)
    await mkdir(location.path, { recursive: true, mode: 0o700 })
    return location
  }

  it('reports MEMORY_IO instead of treating the store as absent', async () => {
    const location = await blockedStore()
    const refused = await refusal(async () => await readStore(location))
    expect(refused.code).toBe('MEMORY_IO')
    expect(refused.message).toContain(location.path)
    expect(refused.message).toContain('could not be read')
  })

  it('maps a filesystem failure during a locked update to MEMORY_IO', async () => {
    const location = await blockedStore()
    const refused = await refusal(
      async () => await updateStore(location, [{ op: 'add', text: 'never written' }], {
        api,
        lockWaitMs: 5000,
      }),
    )
    expect(refused.code).toBe('MEMORY_IO')
    expect(refused.message).toContain('could not be written')
    // The directory is still there: nothing replaced the unusable store.
    expect((await stat(location.path)).isDirectory()).toBe(true)
  })
})

describe('snapshot formatting (DESIGN §4.2)', () => {
  /** A rendered store with nothing kept and nothing refused. */
  function rendered(overrides: Partial<RenderedStore> & Pick<RenderedStore, 'location'>): RenderedStore {
    return { name: 'global-memory', entries: [], refused: 0, ...overrides }
  }

  it('reports a zero limit as 100% rather than dividing by zero', () => {
    const location = globalStore('user', 0)
    expect(storeHeading(location, 10)).toBe(
      '## User profile (USER.md) — 10/0 chars (100%, over the limit; shown in full)',
    )
  })

  it('renders the heading alone for a store with no entries', () => {
    const location = globalStore('memory', 2200)
    expect(renderStoreSection(rendered({ location }), 0)).toBe(
      '## Global memory (MEMORY.md) — 0/2,200 chars (0%)',
    )
  })

  it('counts the refused entries in the plural', () => {
    const location = globalStore('memory', 2200)
    const section = renderStoreSection(rendered({ location, entries: ['kept note'], refused: 2 }), 9)
    expect(section).toContain('kept note')
    expect(section).toContain('(2 entries were refused by the injection scan and are not shown)')
  })

  it('assembles an empty store as a heading-only section', () => {
    const location = globalStore('user', 1375)
    const snapshot = buildSnapshot([{ rendered: rendered({ name: 'user-profile', location }), chars: 0 }])
    expect(snapshot.sections).toEqual([
      { name: 'user-profile', text: '## User profile (USER.md) — 0/1,375 chars (0%)' },
    ])
    expect(snapshot.text.endsWith('\n</memory-snapshot>')).toBe(true)
  })
})
