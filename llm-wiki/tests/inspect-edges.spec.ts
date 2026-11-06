/**
 * Edge cases of the wiki inspection (DESIGN §6.2, §6.3, §6.6): the `rev-parse`
 * memo's eviction and cancellation rules, the diagnostics for a git that fails
 * without a message, the one cached answer that carries no reason, and the
 * `.dsh/wiki.yml` read failure that is not "the file is absent".
 *
 * The happy paths live in `inspect.spec.ts` and `settings.spec.ts`; the cases
 * here are the ones a real repository or an injected runner can produce but the
 * main suites do not visit.
 * @module @anago-harness/llm-wiki/tests/inspect-edges.spec
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createNodeGitRunner, type GitRunner } from '@anago-harness/knowledge-common'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createWikiRootCache,
  inspectWiki,
  readWikiSettings,
  settingsWarnings,
} from '../src/inspect.ts'
import { cleanupTempDirs, gitAvailable, initRepo, scaffoldWiki, tempDir } from './support.ts'

const hasGit = gitAvailable()

afterAll(cleanupTempDirs)

/** A runner that counts its calls and runs the real git without the signal. */
function countingRunner(): { readonly run: GitRunner; readonly calls: string[] } {
  const calls: string[] = []
  const base = createNodeGitRunner()
  return {
    calls,
    run: async (args, options) => {
      calls.push(args.join(' '))
      return await base(args, { cwd: options.cwd })
    },
  }
}

describe.skipIf(!hasGit)('the rev-parse memo (DESIGN §6.6)', () => {
  it('drops the oldest answer once the memo holds more than 64 directories', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const cache = createWikiRootCache()
    // Sixty-five answers, oldest first, so the new answer has to evict one.
    for (let index = 0; index < 65; index += 1) {
      cache.entries.set(`/cached/${String(index)}`, { at: index, roots: null, detail: 'cached' })
    }
    const inspection = await inspectWiki({ cwd: root, cache })
    expect(inspection.kind).toBe('found')
    expect(cache.entries.size).toBe(65)
    expect(cache.entries.has('/cached/0')).toBe(false)
    expect(cache.entries.has('/cached/1')).toBe(true)
    expect(cache.entries.has(root)).toBe(true)
  })

  it('re-asks git when the signal is already aborted, even inside the window', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const cache = createWikiRootCache()
    const counter = countingRunner()
    await inspectWiki({ cwd: root, run: counter.run, cache })
    const asked = counter.calls.filter(call => call.includes('rev-parse')).length
    expect(asked).toBeGreaterThan(0)
    const controller = new AbortController()
    controller.abort()
    // A cancelled inspection must not answer from the memo: the answer is
    // reused only while the caller still wants it.
    await inspectWiki({ cwd: root, run: counter.run, cache, signal: controller.signal })
    expect(counter.calls.filter(call => call.includes('rev-parse')).length).toBeGreaterThan(asked)
  })

  it('answers from a cached "no worktree" with no reason attached', async () => {
    const root = await initRepo()
    const cache = createWikiRootCache()
    // The memo's own type allows a negative answer without a reason; the caller
    // must still get a usable line rather than an empty parenthesis.
    cache.entries.set(root, { at: Date.now(), roots: null, detail: null })
    const inspection = await inspectWiki({ cwd: root, cache })
    expect(inspection.kind).toBe('absent')
    if (inspection.kind !== 'absent') throw new Error('unreachable')
    expect(inspection.detail).toBe(`no git worktree could be resolved from ${root}`)
  })
})

describe.skipIf(!hasGit)('a git that cannot answer (DESIGN §6.2)', () => {
  it('reports the exit status alone when git wrote nothing to stderr', async () => {
    const root = await initRepo()
    const run: GitRunner = async () => ({ code: 1, stdout: '', stderr: '' })
    const inspection = await inspectWiki({ cwd: root, run })
    expect(inspection.kind).toBe('absent')
    if (inspection.kind !== 'absent') throw new Error('unreachable')
    expect(inspection.detail).toContain('git rev-parse --show-toplevel exited 1 in')
    expect(inspection.detail).not.toContain(': ')
  })

  it('reports a repository git names but refuses as a bare one', async () => {
    const root = await initRepo()
    const run: GitRunner = async args =>
      args.includes('--is-bare-repository')
        ? { code: 0, stdout: 'true\n', stderr: '' }
        : { code: 0, stdout: `${root}\n`, stderr: '' }
    const inspection = await inspectWiki({ cwd: root, run })
    expect(inspection.kind).toBe('absent')
    if (inspection.kind !== 'absent') throw new Error('unreachable')
    expect(inspection.detail).toContain(`${root} is not a usable git worktree`)
  })

  it('reports a runner that threw an Error, with its message', async () => {
    const root = await initRepo()
    const run: GitRunner = async () => {
      throw new Error('git could not be spawned')
    }
    const inspection = await inspectWiki({ cwd: root, run })
    expect(inspection.kind).toBe('absent')
    if (inspection.kind !== 'absent') throw new Error('unreachable')
    expect(inspection.detail).toBe(
      `no git worktree could be resolved from ${root}: git could not be spawned`,
    )
  })

  it('reports a runner that threw something that is not an Error', async () => {
    const root = await initRepo()
    const run: GitRunner = async () => {
      throw { exitCode: 127 }
    }
    const inspection = await inspectWiki({ cwd: root, run })
    expect(inspection.kind).toBe('absent')
    if (inspection.kind !== 'absent') throw new Error('unreachable')
    expect(inspection.detail).toBe(`no git worktree could be resolved from ${root}: [object Object]`)
  })
})

describe('readWikiSettings failures (DESIGN §6.3)', () => {
  it('warns when the settings file exists but cannot be read', async () => {
    const dir = await tempDir()
    const file = path.join(dir, '.dsh', 'wiki.yml')
    // A directory where the file belongs: the read fails with EISDIR, not ENOENT.
    await mkdir(file, { recursive: true })
    const settings = await readWikiSettings(file)
    expect(settings.commit).toBe(false)
    expect(settings.warnings.join('\n')).toMatch(/could not be read/u)
    expect(settings.warnings.join('\n')).toMatch(/treated as commit: false/u)
  })
})

describe('settingsWarnings (DESIGN §6.3)', () => {
  it('says the ignore state is undecidable when git gave no reason', () => {
    const warnings = settingsWarnings({ commit: false, warnings: [] }, { state: 'unknown', detail: null })
    expect(warnings).toEqual([
      'the ignore state is undecidable; confirm by hand that .dsh/wiki/index.md is handled as intended',
    ])
  })
})
