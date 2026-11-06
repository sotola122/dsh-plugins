/**
 * Git helper suite (DESIGN §5.1, §10 封じ込め・ルート): the checkout root, the
 * main-worktree root for a linked worktree, the bare and non-repository cases
 * that disable the workspace store, `check-ignore`, and `ls-files`. Runs
 * against throwaway repositories in `os.tmpdir()`; skipped when git is absent.
 * @module knowledge-common/test/git.test
 */
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkIgnored, ensureGitignoreBlock, expectedGitignoreLines, listTrackedFiles, resolveGitRoots } from '../src/index.ts'
import { createTempDir, createTestAtomicWrite, git, GIT_IDENTITY, hasGit, removeTempDirs } from './support.ts'

afterEach(removeTempDirs)

const gitAvailable = hasGit()

/** A runner whose command fails, for the paths that degrade instead of throwing. */
const failingRunner = async (): Promise<{ code: number; stdout: string; stderr: string }> => ({
  code: 128,
  stdout: '',
  stderr: 'fatal',
})

describe.skipIf(!gitAvailable)('resolveGitRoots', () => {
  it('finds the checkout root of a plain repository', async () => {
    const root = await createTempDir()
    git(root, ['init'])
    expect(await resolveGitRoots(root)).toEqual({
      checkoutRoot: await realpath(root),
      root: await realpath(root),
      worktree: false,
    })
  })

  it('finds the same root from a subdirectory', async () => {
    const root = await createTempDir()
    git(root, ['init'])
    const nested = path.join(root, 'packages', 'x')
    await mkdir(nested, { recursive: true })
    const roots = await resolveGitRoots(nested)
    expect(roots?.checkoutRoot).toBe(await realpath(root))
    expect(roots?.root).toBe(await realpath(root))
  })

  it('folds a linked worktree onto the main checkout', async () => {
    const root = await createTempDir()
    git(root, ['init'])
    await writeFile(path.join(root, 'file.txt'), 'x\n')
    git(root, ['add', 'file.txt'])
    git(root, [...GIT_IDENTITY, 'commit', '-m', 'init'])
    const parent = await createTempDir()
    const worktree = path.join(parent, 'wt')
    git(root, ['worktree', 'add', '-b', 'linked', worktree])
    const roots = await resolveGitRoots(worktree)
    expect(roots).toEqual({
      checkoutRoot: await realpath(worktree),
      root: await realpath(root),
      worktree: true,
    })
  })

  it('reports no root outside a repository', async () => {
    const root = await createTempDir()
    expect(await resolveGitRoots(root)).toBeNull()
  })

  it('reports no root for a bare repository', async () => {
    const root = await createTempDir()
    git(root, ['init', '--bare'])
    expect(await resolveGitRoots(root)).toBeNull()
  })

  it('reports no root when git cannot run', async () => {
    const root = await createTempDir()
    const failing = async (): Promise<{ code: number; stdout: string; stderr: string }> => ({
      code: -1,
      stdout: '',
      stderr: 'spawn git ENOENT',
    })
    expect(await resolveGitRoots(root, { run: failing })).toBeNull()
  })
})

describe.skipIf(!gitAvailable)('checkIgnored', () => {
  it('answers for an ignored and an unignored path', async () => {
    const root = await createTempDir()
    git(root, ['init'])
    await writeFile(path.join(root, '.gitignore'), '.dsh/*\n!.dsh/wiki.yml\n')
    expect(await checkIgnored(root, '.dsh/memory/MEMORY.md')).toEqual({ ignored: true, code: 0 })
    expect(await checkIgnored(root, 'src/index.ts')).toEqual({ ignored: false, code: 1 })
  })

  it('accepts a negation line', async () => {
    const root = await createTempDir()
    git(root, ['init'])
    await writeFile(path.join(root, '.gitignore'), '.dsh/*\n!.dsh/wiki.yml\n')
    expect((await checkIgnored(root, '.dsh/wiki.yml')).ignored).toBe(false)
  })

  it('reports a git failure as not ignored', async () => {
    const root = await createTempDir()
    expect(await checkIgnored(root, '.dsh/memory/MEMORY.md', { run: failingRunner })).toEqual({
      ignored: false,
      code: 128,
    })
  })

  it('ignores the store once the managed block is written, and not a committed wiki', async () => {
    const root = await createTempDir()
    git(root, ['init'])
    const api = createTestAtomicWrite()
    await ensureGitignoreBlock(api, { root, lines: expectedGitignoreLines() })
    expect((await checkIgnored(root, '.dsh/memory/MEMORY.md')).ignored).toBe(true)
    expect((await checkIgnored(root, '.dsh/wiki.yml')).ignored).toBe(false)
    // `!.dsh/wiki/` — the directory form, not `!.dsh/wiki/**` — is what re-includes
    // a page under a directory `.dsh/*` just excluded (DESIGN §3.2, T6).
    await ensureGitignoreBlock(api, { root, lines: expectedGitignoreLines({ wikiCommitted: true }) })
    expect((await checkIgnored(root, '.dsh/wiki/pages/a.md')).ignored).toBe(false)
    expect((await checkIgnored(root, '.dsh/memory/MEMORY.md')).ignored).toBe(true)
  })
})

describe.skipIf(!gitAvailable)('listTrackedFiles', () => {
  it('is empty until the path is added, then lists it', async () => {
    const root = await createTempDir()
    git(root, ['init'])
    const store = path.join(root, '.dsh', 'memory')
    await mkdir(store, { recursive: true })
    await writeFile(path.join(store, 'MEMORY.md'), 'entry\n')
    expect(await listTrackedFiles(root, '.dsh/memory')).toEqual([])
    git(root, ['add', '-f', '.dsh/memory/MEMORY.md'])
    expect(await listTrackedFiles(root, '.dsh/memory')).toEqual(['.dsh/memory/MEMORY.md'])
  })

  it('returns nothing when the command fails', async () => {
    const root = await createTempDir()
    expect(await listTrackedFiles(root, '.dsh/memory', { run: failingRunner })).toEqual([])
  })

  it('lists everything when the caller supplies no pathspec', async () => {
    const root = await createTempDir()
    const run = async (args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> => ({
      code: args.join(' ') === 'ls-files -z' ? 0 : 128,
      stdout: args.join(' ') === 'ls-files -z' ? 'a.md\0b.md\0' : '',
      stderr: '',
    })
    expect(await listTrackedFiles(root, undefined, { run })).toEqual(['a.md', 'b.md'])
  })
})

/** Answer one `rev-parse` invocation from a scripted map keyed by its argument text. */
function scriptedRootsRunner(
  answers: Readonly<Record<string, { code: number; stdout: string }>>,
) {
  return async (args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const answer = answers[args.join(' ')] ?? { code: 128, stdout: '' }
    return { ...answer, stderr: '' }
  }
}

describe('resolveGitRoots with a scripted runner', () => {
  it('reports no root when the checkout root is empty', async () => {
    const run = scriptedRootsRunner({ 'rev-parse --show-toplevel': { code: 0, stdout: '  \n' } })
    expect(await resolveGitRoots('/repo', { run })).toBeNull()
  })

  it('reports no root for a bare repository whose toplevel probe succeeds', async () => {
    const run = scriptedRootsRunner({
      'rev-parse --show-toplevel': { code: 0, stdout: '/repo\n' },
      'rev-parse --is-bare-repository': { code: 0, stdout: 'true\n' },
    })
    expect(await resolveGitRoots('/repo', { run })).toBeNull()
  })

  it('keeps the checkout root when the common directory cannot be read', async () => {
    const run = scriptedRootsRunner({
      'rev-parse --show-toplevel': { code: 0, stdout: '/repo\n' },
      'rev-parse --is-bare-repository': { code: 0, stdout: 'false\n' },
    })
    expect(await resolveGitRoots('/repo', { run })).toEqual({
      checkoutRoot: '/repo',
      root: '/repo',
      worktree: false,
    })
  })

  it('keeps the checkout root for a separate git directory', async () => {
    const run = scriptedRootsRunner({
      'rev-parse --show-toplevel': { code: 0, stdout: '/repo\n' },
      'rev-parse --is-bare-repository': { code: 0, stdout: 'false\n' },
      'rev-parse --path-format=absolute --git-common-dir': { code: 0, stdout: '/repo/.git/worktrees\n' },
    })
    expect(await resolveGitRoots('/repo', { run })).toEqual({
      checkoutRoot: '/repo',
      root: '/repo',
      worktree: false,
    })
  })
})
