/**
 * The global wiki's edge cases (DESIGN §6.4, §6.6): what the pre-migration
 * sidecar does when the current record cannot be written, when the old file is a
 * directory or cannot be read, and when git cannot answer the "is this inside a
 * work tree?" question; the ordered checks when `realpath` or `git rev-parse`
 * fails in the ways those catches exist for; the memoization `invalidate` and
 * `noteAgent` own; and the `git status` line for a change set with nothing
 * untracked.
 *
 * Everything is a real temporary directory, a real git repository, or an
 * injected `GitRunner` — the seams the plugin is built around.
 * @module @anago-harness/llm-wiki/tests/global-edges.spec
 */
import { chmod, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { GitRunner } from '@anago-harness/knowledge-common'
import {
  createGlobalWikiState,
  ensureGlobalSkeleton,
  globalDisabledReason,
  inspectGlobalRepo,
  readGitStatus,
  readGlobalSidecar,
  summarizeGitStatus,
} from '../src/global.ts'
import {
  cleanupTempDirs,
  exists,
  fakeAgent,
  gitAvailable,
  initRepo,
  readAt,
  recordingLogger,
  tempDir,
  tempGlobalState,
  writeFileAt,
  writeSidecar,
} from './support.ts'

const hasGit = gitAvailable()
afterAll(cleanupTempDirs)

/** Whether permission bits are enforced for this process (a root process bypasses them). */
const rootUser = process.getuid?.() === 0

/** A runner that answers "this directory is outside every git work tree". */
const outsideWorkTree: GitRunner = async () => ({
  code: 128,
  stdout: '',
  stderr: 'fatal: not a git repository',
})

/** The canonical form of a temporary directory, for an expectation on a git answer. */
async function realpathOf(target: string): Promise<string> {
  return await realpath(target)
}

/** Run `callback` with `$DSH_HOME` pointed at `home`, restoring the old value afterwards. */
async function withDshHome<T>(home: string, callback: () => Promise<T>): Promise<T> {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await callback()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

/** A home with an absent current sidecar and one pre-migration file. */
async function legacyHome(content: string): Promise<{
  home: string
  sidecarFile: string
  legacyFile: string
}> {
  const home = await tempDir('dsh-home-')
  const legacyFile = path.join(home, 'llm-wiki', 'repo.json')
  await writeFileAt(legacyFile, content)
  return { home, sidecarFile: path.join(home, 'llm-wiki-state', 'repo.json'), legacyFile }
}

describe('the pre-migration sidecar, the remaining outcomes (DESIGN §6.4)', () => {
  it('falls back to the $DSH_HOME path when the caller names no legacy file', async () => {
    const home = await tempDir('dsh-home-')
    await withDshHome(home, async () => {
      const legacyFile = path.join(home, 'llm-wiki', 'repo.json')
      await writeFileAt(legacyFile, '{"disabled":true}\n')
      const sidecarFile = path.join(home, 'llm-wiki-state', 'repo.json')
      const reading = await readGlobalSidecar(sidecarFile, { run: outsideWorkTree })
      expect(reading).toEqual({
        value: { disabled: true },
        detail: null,
        legacy: { kind: 'used', from: legacyFile, to: sidecarFile, copied: true, detail: null },
      })
      expect(await readAt(sidecarFile)).toBe('{"disabled":true}\n')
    })
  })

  it('ignores a legacy path that is a directory', async () => {
    const home = await tempDir('dsh-home-')
    const legacyFile = path.join(home, 'llm-wiki', 'repo.json')
    await mkdir(legacyFile, { recursive: true })
    const reading = await readGlobalSidecar(path.join(home, 'llm-wiki-state', 'repo.json'), {
      legacyFile,
      run: outsideWorkTree,
    })
    expect(reading).toEqual({ value: null, detail: null })
  })

  it.skipIf(rootUser)('ignores a legacy file it cannot read', async () => {
    const { sidecarFile, legacyFile } = await legacyHome('{"disabled":true}\n')
    await chmod(legacyFile, 0o000)
    try {
      const reading = await readGlobalSidecar(sidecarFile, { legacyFile, run: outsideWorkTree })
      expect(reading.value).toBeNull()
      expect(reading.legacy).toMatchObject({ kind: 'skipped', reason: 'unusable' })
      expect(reading.legacy?.kind === 'skipped' ? reading.legacy.detail : '').toMatch(/could not be read/u)
    } finally {
      await chmod(legacyFile, 0o600)
    }
  })

  it.skipIf(rootUser)('keeps a legacy value whose copy to the current path failed, and warns', async () => {
    // The record's directory exists but denies writing, so the value is used and
    // the copy is the only step that fails.
    const home = await tempDir('dsh-home-')
    const stateDir = path.join(home, 'llm-wiki-state')
    await mkdir(stateDir, { mode: 0o500 })
    const legacyFile = path.join(home, 'llm-wiki', 'repo.json')
    await writeFileAt(legacyFile, '{"disabled":true}\n')
    const logger = recordingLogger()
    const state = createGlobalWikiState({
      profileRepo: () => '',
      logger,
      sidecarFile: path.join(stateDir, 'repo.json'),
      legacySidecarFile: legacyFile,
      dshHome: home,
      run: outsideWorkTree,
    })
    expect(await state.resolve()).toMatchObject({ kind: 'disabled' })
    // The value is used even though the copy failed, and the copy is really absent.
    expect(await exists(path.join(stateDir, 'repo.json'))).toBe(false)
    expect(logger.warnings.join('\n')).toMatch(/copying it to .* failed/u)
    expect(logger.warnings.join('\n')).toMatch(/the old file is still the only record/u)
  })

  it('reports a sidecar it cannot open instead of treating it as absent', async () => {
    const home = await tempDir('dsh-home-')
    await writeFileAt(path.join(home, 'blocked'), 'not a directory\n')
    const reading = await readGlobalSidecar(path.join(home, 'blocked', 'repo.json'), { legacyFile: null })
    expect(reading.value).toBeNull()
    expect(reading.detail).toMatch(/could not be read/u)
  })
})

describe('the work-tree question the legacy file needs (DESIGN §6.4)', () => {
  it('passes the cancellation and reads an empty answer as the directory itself', async () => {
    const { sidecarFile, legacyFile } = await legacyHome('{"path":"/decoy"}\n')
    const reading = await readGlobalSidecar(sidecarFile, {
      legacyFile,
      signal: new AbortController().signal,
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    })
    expect(reading.value).toBeNull()
    expect(reading.legacy).toMatchObject({ kind: 'skipped', reason: 'repository' })
    expect(reading.legacy?.kind === 'skipped' ? reading.legacy.detail : '').toContain(path.dirname(legacyFile))
  })

  it('reports an unanswered question when git fails and nothing was cancelled', async () => {
    const { sidecarFile, legacyFile } = await legacyHome('{"path":"/decoy"}\n')
    const reading = await readGlobalSidecar(sidecarFile, {
      legacyFile,
      run: async () => {
        throw new Error('git exploded')
      },
    })
    expect(reading.value).toBeNull()
    expect(reading.legacy).toMatchObject({ kind: 'skipped', reason: 'unknown' })
    expect(reading.legacy?.kind === 'skipped' ? reading.legacy.detail : '').toMatch(/git rev-parse could not run/u)
  })

  it('rethrows a git failure once the caller has cancelled', async () => {
    const { sidecarFile, legacyFile } = await legacyHome('{"path":"/decoy"}\n')
    await expect(
      readGlobalSidecar(sidecarFile, {
        legacyFile,
        signal: AbortSignal.abort(),
        run: async () => {
          throw new Error('git exploded')
        },
      }),
    ).rejects.toThrow(/git exploded/u)
  })

  it('reports the exit status without a stderr suffix when git stayed silent', async () => {
    const { sidecarFile, legacyFile } = await legacyHome('{"path":"/decoy"}\n')
    const reading = await readGlobalSidecar(sidecarFile, {
      legacyFile,
      run: async () => ({ code: 1, stdout: '', stderr: '' }),
    })
    expect(reading.legacy).toMatchObject({ kind: 'skipped', reason: 'unknown' })
    expect(reading.legacy?.kind === 'skipped' ? reading.legacy.detail : '').toBe(
      `git rev-parse exited 1 in ${path.dirname(legacyFile)}`,
    )
  })
})

describe.skipIf(!hasGit)('inspectGlobalRepo, the remaining answers (DESIGN §6.4 checks 2–5)', () => {
  it('refuses a path whose ~ expansion fails', async () => {
    const inspection = await inspectGlobalRepo({ raw: '~someone/wiki', source: 'sidecar' })
    expect(inspection).toMatchObject({
      kind: 'rejected',
      detail: expect.stringMatching(/~user.*is not expanded/u) as string,
    })
  })

  it('reports a path through a regular file as unresolvable, not absent', async () => {
    const dir = await tempDir('dsh-inspect-')
    await writeFileAt(path.join(dir, 'file.txt'), 'x\n')
    const inspection = await inspectGlobalRepo({ raw: path.join(dir, 'file.txt', 'child'), source: 'sidecar' })
    expect(inspection).toMatchObject({
      kind: 'rejected',
      detail: expect.stringMatching(/could not be resolved/u) as string,
    })
  })

  it('reports git failing to answer, with and without a stderr line', async () => {
    const dir = await tempDir('dsh-inspect-git-')
    const canonical = await realpathOf(dir)
    const silent = await inspectGlobalRepo(
      { raw: dir, source: 'sidecar' },
      { run: async () => ({ code: 1, stdout: '', stderr: '' }) },
    )
    expect(silent.kind === 'rejected' ? silent.detail : '').toBe(`git rev-parse exited 1 in ${canonical}`)
    const noisy = await inspectGlobalRepo(
      { raw: dir, source: 'sidecar' },
      { run: async () => ({ code: 1, stdout: '', stderr: 'boom' }) },
    )
    expect(noisy.kind === 'rejected' ? noisy.detail : '').toBe(`git rev-parse exited 1 in ${canonical}: boom`)
  })

  it('refuses a git answer that names a directory which does not exist', async () => {
    const dir = await tempDir('dsh-inspect-top-')
    const missing = path.join(await tempDir('dsh-inspect-missing-'), 'gone')
    const inspection = await inspectGlobalRepo(
      { raw: dir, source: 'sidecar' },
      { run: async () => ({ code: 0, stdout: `${missing}\n`, stderr: '' }) },
    )
    expect(inspection).toMatchObject({
      kind: 'rejected',
      detail: expect.stringMatching(/but is not its top/u) as string,
    })
  })
})

describe.skipIf(!hasGit)('ensureGlobalSkeleton, the remaining outcomes (DESIGN §6.4 check 6)', () => {
  it('reports a git init that failed', async () => {
    const fresh = await tempDir('dsh-fresh-')
    await expect(
      ensureGlobalSkeleton(
        { repoRoot: fresh, source: 'sidecar', needsInit: true },
        { run: async () => ({ code: 1, stdout: '', stderr: 'boom' }) },
      ),
    ).rejects.toThrow(/git init failed in .*\(exit 1\): boom/u)
  })

  it('adds the lock rule to a .gitignore that has no trailing newline', async () => {
    const repo = await initRepo()
    await writeFileAt(path.join(repo, '.gitignore'), 'node_modules')
    await ensureGlobalSkeleton({ repoRoot: repo, source: 'sidecar', needsInit: false })
    expect(await readAt(path.join(repo, '.gitignore'))).toBe('node_modules\n*.lock\n')
  })
})

describe('globalDisabledReason (DESIGN §6.4)', () => {
  it('names the refusal for a rejected repository and the command for a disabled one', () => {
    expect(globalDisabledReason({ kind: 'rejected', detail: 'it is inside another repository' })).toBe(
      'WIKI_REPO_REJECTED: the global wiki repository was refused: it is inside another repository',
    )
    expect(globalDisabledReason({ kind: 'disabled', detail: 'no designation' })).toMatch(
      /^WIKI_GLOBAL_DISABLED: .*\/wiki repo set/u,
    )
  })
})

describe.skipIf(!hasGit)('createGlobalWikiState, the remaining paths (DESIGN §6.4)', () => {
  it('re-reads the sidecar after invalidate', async () => {
    const { state, sidecarFile } = await tempGlobalState()
    expect((await state.resolve()).kind).toBe('disabled')
    const repo = await initRepo()
    await writeSidecar(sidecarFile, { path: repo })
    state.invalidate()
    expect(await state.resolve()).toMatchObject({ kind: 'found' })
    expect(state.pagesDir).toBe('pages')
  })

  it('reports a rejected sidecar path as coming from /wiki repo set', async () => {
    const missing = path.join(await tempDir('dsh-state-'), 'not-here')
    const { state } = await tempGlobalState({ sidecar: { path: missing } })
    const view = await state.resolve()
    expect(view.kind).toBe('rejected')
    expect(view.kind === 'rejected' ? view.detail : '').toMatch(/\(from \/wiki repo set\)$/u)
  })

  it('passes its git runner to the inspection', async () => {
    const repo = await initRepo()
    const { state } = await tempGlobalState({
      profileRepo: repo,
      run: async () => ({ code: 0, stdout: `${repo}\n`, stderr: '' }),
    })
    expect(await state.resolve()).toMatchObject({ kind: 'found' })
  })

  it('notes a session, and reports a view it could not derive', async () => {
    const repo = await initRepo()
    const elsewhere = await initRepo()
    const home = await tempDir('dsh-home-')
    const sidecarFile = path.join(home, 'llm-wiki-state', 'repo.json')
    await writeSidecar(sidecarFile, { path: repo })
    const logger = recordingLogger()
    const state = createGlobalWikiState({
      profileRepo: () => '',
      logger,
      sidecarFile,
      legacySidecarFile: null,
      dshHome: home,
      run: async () => {
        throw new Error('git exploded')
      },
    })
    // A call without an agent has no session to check, and says nothing.
    state.noteAgent(undefined)
    state.noteAgent(null)
    expect(logger.warnings).toEqual([])
    state.noteAgent(fakeAgent({ cwd: elsewhere }))
    await vi.waitFor(() => {
      expect(logger.warnings.join('\n')).toMatch(/the global wiki could not be inspected/u)
    })
    expect(logger.warnings.join('\n')).toMatch(/git exploded/u)
  })
})

describe('the git status line (DESIGN §6.6)', () => {
  it('leaves out the counts that are zero', () => {
    expect(summarizeGitStatus([{ index: ' ', worktree: 'M', path: 'index.md' }])).toBe('1 changed, 1 modified')
    expect(summarizeGitStatus([{ index: 'A', worktree: ' ', path: 'pages/a.md' }])).toBe('1 changed, 1 staged')
  })

  it.skipIf(!hasGit)('reports a git failure without a stderr suffix when git stayed silent', async () => {
    const result = await readGitStatus(await tempDir('dsh-status-'), {
      run: async () => ({ code: 3, stdout: '', stderr: '' }),
    })
    expect(result).toEqual({ summary: 'unknown', detail: 'git status exited 3' })
  })
})
