/**
 * `rev-parse` memo suite (DESIGN §6.2, §6.6): the pre-step listener runs on
 * every proposed step, so the checkout root is cached for two seconds while the
 * parts that can change under the user — `.dsh/wiki.yml` and the ignore state —
 * are re-read every time.
 * @module @anago-harness/llm-wiki/tests/inspect.spec
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createNodeGitRunner, type GitRunner } from '@anago-harness/knowledge-common'
import { afterEach, afterAll, describe, expect, it, vi } from 'vitest'
import { createWikiRootCache, inspectWiki, WIKI_ROOT_CACHE_TTL_MS } from '../src/inspect.ts'
import { cleanupTempDirs, gitAvailable, initRepo, scaffoldWiki, writeSettings } from './support.ts'

const hasGit = gitAvailable()

afterEach(() => {
  vi.useRealTimers()
})

afterAll(cleanupTempDirs)

/** A runner that counts `rev-parse` calls and delegates everything else. */
function countingRunner(): { run: GitRunner; calls: string[] } {
  const calls: string[] = []
  const base = createNodeGitRunner()
  return {
    calls,
    run: async (args, options) => {
      calls.push(args.join(' '))
      return await base(args, options)
    },
  }
}

describe.skipIf(!hasGit)('the rev-parse memo (DESIGN §6.6)', () => {
  it('asks git once for two inspections inside the window', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const cache = createWikiRootCache()
    const counter = countingRunner()
    await inspectWiki({ cwd: root, run: counter.run, cache })
    const afterFirst = counter.calls.filter(call => call.includes('rev-parse')).length
    expect(afterFirst).toBeGreaterThan(0)
    await inspectWiki({ cwd: root, run: counter.run, cache })
    expect(counter.calls.filter(call => call.includes('rev-parse')).length).toBe(afterFirst)
  })

  it('asks git again after the window expires', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const cache = createWikiRootCache()
    const counter = countingRunner()
    await inspectWiki({ cwd: root, run: counter.run, cache })
    const afterFirst = counter.calls.filter(call => call.includes('rev-parse')).length
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + WIKI_ROOT_CACHE_TTL_MS + 1)
    await inspectWiki({ cwd: root, run: counter.run, cache })
    expect(counter.calls.filter(call => call.includes('rev-parse')).length).toBeGreaterThan(afterFirst)
    vi.useRealTimers()
  })

  it('re-reads .dsh/wiki.yml even while the root is cached', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const cache = createWikiRootCache()
    const first = await inspectWiki({ cwd: root, cache })
    expect(first.kind === 'found' && first.settings.commit).toBe(false)
    await writeSettings(root, 'commit: true\n')
    const second = await inspectWiki({ cwd: root, cache })
    expect(second.kind === 'found' && second.settings.commit).toBe(true)
  })

  it('keys the memo by directory, so two sessions do not share one answer', async () => {
    const first = await initRepo()
    const second = await initRepo()
    await scaffoldWiki(first)
    await scaffoldWiki(second)
    const cache = createWikiRootCache()
    const a = await inspectWiki({ cwd: first, cache })
    const b = await inspectWiki({ cwd: second, cache })
    expect(a.kind).toBe('found')
    expect(b.kind).toBe('found')
    if (a.kind !== 'found' || b.kind !== 'found') throw new Error('unreachable')
    expect(a.root.wikiRoot).toBe(path.join(first, '.dsh', 'wiki'))
    expect(b.root.wikiRoot).toBe(path.join(second, '.dsh', 'wiki'))
    expect(cache.entries.size).toBe(2)
  })

  it('reports a git failure in the detail instead of only "absent"', async () => {
    const root = await initRepo()
    const run: GitRunner = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' })
    const inspection = await inspectWiki({ cwd: root, run })
    expect(inspection.kind).toBe('absent')
    if (inspection.kind !== 'absent') throw new Error('unreachable')
    expect(inspection.detail).toMatch(/exited 128/u)
    expect(inspection.detail).toMatch(/fatal: not a git repository/u)
  })

  it('treats a worktree whose .dsh/wiki is a file as absent', async () => {
    const root = await initRepo()
    await writeFile(path.join(root, '.dsh', 'wiki'), 'not a directory\n').catch(async () => {
      await import('node:fs/promises').then(async (fs) => {
        await fs.mkdir(path.join(root, '.dsh'), { recursive: true })
        await fs.writeFile(path.join(root, '.dsh', 'wiki'), 'not a directory\n')
      })
    })
    const inspection = await inspectWiki({ cwd: root })
    expect(inspection.kind).toBe('absent')
    if (inspection.kind !== 'absent') throw new Error('unreachable')
    expect(inspection.detail).toMatch(/is not a directory/u)
  })
})
