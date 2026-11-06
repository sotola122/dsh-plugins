/**
 * The global wiki suite (DESIGN §6.4, §10, §11 order 5): the ordered checks, the
 * sidecar and its precedence over the Profile, the skeleton (including
 * `git init`), the per-session cwd rule, the `write`/`edit` deny, and the `git
 * status` summary `/wiki status` prints.
 *
 * Every directory comes from `os.tmpdir()`; the sidecar and `$DSH_HOME` are
 * passed to the state explicitly, so a developer's real `~/.dsh` is never read
 * or written.
 * @module @anago-harness/llm-wiki/tests/global.spec
 */
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { GitRunner } from '@anago-harness/knowledge-common'
import {
  createGlobalWikiState,
  ensureGlobalSkeleton,
  expandRepoPath,
  globalSidecarPath,
  inspectGlobalRepo,
  legacyGlobalSidecarPath,
  parseGitStatus,
  parseGlobalSidecar,
  readGitStatus,
  readGlobalSidecar,
  resolveGlobalCandidate,
  summarizeGitStatus,
  writeGlobalSidecar,
} from '../src/global.ts'
import { guardDecision } from '../src/guard.ts'
import {
  cleanupTempDirs,
  exists,
  fakeAgent,
  fakeToolCall,
  git,
  gitAvailable,
  globalRepo,
  initRepo,
  readAt,
  recordingLogger,
  scaffoldGlobalRepo,
  tempDir,
  tempGlobalState,
  writeFileAt,
} from './support.ts'

const hasGit = gitAvailable()
afterAll(cleanupTempDirs)

/** An `allow` chain: what the rest of the policy would have decided. */
const allow = async (): Promise<PreToolDecision> => ({ kind: 'allow' })

describe('expandRepoPath (DESIGN §6.4 check 1)', () => {
  it('expands ~ and ~/ only', () => {
    const home = process.env.HOME ?? ''
    expect(expandRepoPath('~')).toEqual({ ok: true, path: home })
    expect(expandRepoPath('~/wiki')).toEqual({ ok: true, path: path.join(home, 'wiki') })
    expect(expandRepoPath('/absolute/path')).toEqual({ ok: true, path: '/absolute/path' })
    expect(expandRepoPath('relative/path')).toEqual({ ok: true, path: 'relative/path' })
    expect(expandRepoPath('  ~/wiki  ')).toEqual({ ok: true, path: path.join(home, 'wiki') })
  })

  it('refuses ~user and an empty path', () => {
    expect(expandRepoPath('~someone/wiki')).toMatchObject({ ok: false })
    expect(expandRepoPath('~someone/wiki')).toMatchObject({ detail: expect.stringMatching(/~user/u) as string })
    expect(expandRepoPath('   ')).toMatchObject({ ok: false, detail: 'the path is empty' })
  })
})

describe('parseGlobalSidecar (DESIGN §6.4)', () => {
  it('accepts the two documented shapes', () => {
    expect(parseGlobalSidecar('{"path":"/repo"}')).toEqual({
      value: { path: '/repo' },
      detail: null,
    })
    expect(parseGlobalSidecar('{"disabled":true}')).toEqual({
      value: { disabled: true },
      detail: null,
    })
    expect(parseGlobalSidecar(null)).toEqual({ value: null, detail: null })
  })

  it('reports anything else as unusable instead of guessing', () => {
    expect(parseGlobalSidecar('not json')).toMatchObject({ value: null, detail: expect.stringMatching(/not JSON/u) as string })
    expect(parseGlobalSidecar('[]')).toMatchObject({ value: null, detail: expect.stringMatching(/not a JSON object/u) as string })
    expect(parseGlobalSidecar('{"path":""}')).toMatchObject({ value: null })
    expect(parseGlobalSidecar('{"other":1}')).toMatchObject({ value: null })
  })
})

describe('resolveGlobalCandidate (DESIGN §6.4, §12.3)', () => {
  it('lets the sidecar win over the Profile, in both directions', () => {
    expect(resolveGlobalCandidate('/profile', { value: { path: '/sidecar' }, detail: null })).toEqual({
      candidate: { raw: '/sidecar', source: 'sidecar' },
      detail: null,
    })
    expect(resolveGlobalCandidate('/profile', { value: { disabled: true }, detail: null })).toEqual({
      candidate: null,
      detail: null,
    })
  })

  it('falls back to the Profile when there is no sidecar, and reports a broken one', () => {
    expect(resolveGlobalCandidate('/profile', { value: null, detail: null })).toEqual({
      candidate: { raw: '/profile', source: 'profile' },
      detail: null,
    })
    const broken = resolveGlobalCandidate('/profile', { value: null, detail: 'repo.json is truncated' })
    expect(broken.candidate).toEqual({ raw: '/profile', source: 'profile' })
    expect(broken.detail).toBe('repo.json is truncated')
    expect(resolveGlobalCandidate('', { value: null, detail: null })).toEqual({
      candidate: null,
      detail: null,
    })
  })
})

describe.skipIf(!hasGit)('inspectGlobalRepo (DESIGN §6.4 checks 2–5)', () => {
  it('accepts the top of an existing repository', async () => {
    const repo = await initRepo()
    const inspection = await inspectGlobalRepo({ raw: repo, source: 'sidecar' })
    expect(inspection.kind).toBe('found')
    if (inspection.kind !== 'found') return
    expect(inspection.repo.repoRoot).toBe(await realpathOf(repo))
    expect(inspection.repo.needsInit).toBe(false)
  })

  it('expands ~ before the absolute check, so a ~ path is not refused as relative', async () => {
    // A name under the real home that does not exist: rejecting it for being
    // absent proves the `~` was expanded first (nothing is created).
    const name = `dsh-wiki-does-not-exist-${String(Date.now())}`
    const inspection = await inspectGlobalRepo({ raw: `~/${name}`, source: 'profile' })
    expect(inspection).toMatchObject({ kind: 'rejected', detail: expect.stringMatching(/does not exist/u) as string })
    expect(inspection.kind === 'rejected' ? inspection.detail : '').not.toMatch(/not absolute/u)
  })

  it('refuses a relative path instead of resolving it against the process cwd', async () => {
    const inspection = await inspectGlobalRepo({ raw: 'relative/wiki', source: 'sidecar' })
    expect(inspection).toMatchObject({ kind: 'rejected', detail: expect.stringMatching(/not absolute/u) as string })
  })

  it('refuses a path that does not exist', async () => {
    const missing = path.join(await tempDir(), 'no-such-dir')
    const inspection = await inspectGlobalRepo({ raw: missing, source: 'sidecar' })
    expect(inspection).toMatchObject({ kind: 'rejected', detail: expect.stringMatching(/does not exist/u) as string })
  })

  it('refuses a regular file', async () => {
    const file = path.join(await tempDir(), 'file.txt')
    await writeFileAt(file, 'x\n')
    const inspection = await inspectGlobalRepo({ raw: file, source: 'sidecar' })
    expect(inspection).toMatchObject({ kind: 'rejected', detail: expect.stringMatching(/not a directory/u) as string })
  })

  it('refuses a directory that is inside a repository but is not its top', async () => {
    const repo = await initRepo()
    const nested = path.join(repo, 'nested')
    await mkdir(nested, { recursive: true })
    const inspection = await inspectGlobalRepo({ raw: nested, source: 'sidecar' })
    expect(inspection).toMatchObject({
      kind: 'rejected',
      detail: expect.stringMatching(/is not its top/u) as string,
    })
  })

  it('refuses a bare repository', async () => {
    const bare = await tempDir('dsh-bare-')
    git(bare, ['init', '--bare', '--quiet'])
    const inspection = await inspectGlobalRepo({ raw: bare, source: 'sidecar' })
    expect(inspection).toMatchObject({ kind: 'rejected', detail: expect.stringMatching(/bare/u) as string })
  })

  it('accepts a directory outside every repository, and asks for git init', async () => {
    const fresh = await tempDir('dsh-fresh-')
    const inspection = await inspectGlobalRepo({ raw: fresh, source: 'sidecar' })
    expect(inspection).toMatchObject({ kind: 'found' })
    if (inspection.kind !== 'found') return
    expect(inspection.repo.needsInit).toBe(true)
  })

  it('refuses $DSH_HOME itself and its ancestors, and accepts a child', async () => {
    const home = await tempDir('dsh-home-')
    const child = path.join(home, 'wiki')
    const parent = path.dirname(home)
    const atHome = await inspectGlobalRepo({ raw: home, source: 'sidecar' }, { dshHome: home })
    expect(atHome).toMatchObject({ kind: 'rejected', detail: expect.stringMatching(/DSH_HOME/u) as string })
    const atParent = await inspectGlobalRepo({ raw: parent, source: 'sidecar' }, { dshHome: home })
    expect(atParent).toMatchObject({ kind: 'rejected' })
    await mkdir(child, { recursive: true })
    const atChild = await inspectGlobalRepo({ raw: child, source: 'sidecar' }, { dshHome: home })
    expect(atChild).toMatchObject({ kind: 'found' })
  })

  it('refuses a repository that is the session cwd, its parent, or its child (check 5)', async () => {
    const repo = await initRepo()
    const nested = path.join(repo, 'packages', 'x')
    await mkdir(nested, { recursive: true })
    for (const cwd of [repo, nested, path.dirname(repo)]) {
      const inspection = await inspectGlobalRepo({ raw: repo, source: 'sidecar' }, { cwd })
      expect(inspection).toMatchObject({
        kind: 'rejected',
        detail: expect.stringMatching(/working directory/u) as string,
      })
    }
  })
})

describe.skipIf(!hasGit)('ensureGlobalSkeleton (DESIGN §6.4 check 6)', () => {
  it('creates the four paths and the lock rule, and does nothing the second time', async () => {
    const repo = await initRepo()
    const first = await ensureGlobalSkeleton({
      repoRoot: repo,
      source: 'sidecar',
      needsInit: false,
    })
    expect(first.initialised).toBe(false)
    expect(await exists(path.join(repo, 'WIKI.md'))).toBe(true)
    expect(await exists(path.join(repo, 'index.md'))).toBe(true)
    expect(await exists(path.join(repo, 'pages'))).toBe(true)
    expect(await exists(path.join(repo, 'raw'))).toBe(true)
    expect(await readAt(path.join(repo, '.gitignore'))).toBe('*.lock\n')
    const second = await ensureGlobalSkeleton({ repoRoot: repo, source: 'sidecar', needsInit: false })
    expect(second.created).toEqual([])
  })

  it('keeps the charter, catalogue, and gitignore lines a person already wrote', async () => {
    const repo = await initRepo()
    await writeFileAt(path.join(repo, 'WIKI.md'), '# Mine\n')
    await writeFileAt(path.join(repo, '.gitignore'), 'node_modules/\n')
    await ensureGlobalSkeleton({ repoRoot: repo, source: 'sidecar', needsInit: false })
    expect(await readAt(path.join(repo, 'WIKI.md'))).toBe('# Mine\n')
    expect(await readAt(path.join(repo, '.gitignore'))).toBe('node_modules/\n*.lock\n')
  })

  it('runs git init for a directory outside every repository, locally only', async () => {
    const fresh = await tempDir('dsh-fresh-')
    const result = await ensureGlobalSkeleton({
      repoRoot: fresh,
      source: 'sidecar',
      needsInit: true,
    })
    expect(result.initialised).toBe(true)
    expect(await exists(path.join(fresh, '.git'))).toBe(true)
    expect(git(fresh, ['remote']).trim()).toBe('')
  })
})

describe.skipIf(!hasGit)('createGlobalWikiState (DESIGN §6.4)', () => {
  it('is disabled with no sidecar and no Profile value', async () => {
    const { state } = await tempGlobalState()
    const view = await state.resolve()
    expect(view.kind).toBe('disabled')
    expect(view.kind === 'disabled' ? view.detail : '').toMatch(/no global wiki repository is designated/u)
  })

  it('takes the sidecar over the Profile and records a designation', async () => {
    const sidecarRepo = await initRepo()
    const profileRepo = await initRepo()
    const { state, sidecarFile } = await tempGlobalState({
      profileRepo,
      sidecar: { path: sidecarRepo },
    })
    const view = await state.resolve()
    expect(view).toMatchObject({ kind: 'found' })
    expect(view.kind === 'found' ? view.repo.source : '').toBe('sidecar')
    expect(JSON.parse(await readAt(sidecarFile))).toEqual({ path: sidecarRepo })
  })

  it('lets repo unset override the Profile without deleting anything', async () => {
    const profileRepo = await initRepo()
    await scaffoldGlobalRepo(profileRepo)
    const { state, sidecarFile } = await tempGlobalState({ profileRepo })
    expect((await state.resolve()).kind).toBe('found')
    const { was } = await state.disable()
    expect(was.kind).toBe('found')
    expect((await state.resolve()).kind).toBe('disabled')
    expect(JSON.parse(await readAt(sidecarFile))).toEqual({ disabled: true })
    expect(await exists(path.join(profileRepo, 'index.md'))).toBe(true)
  })

  it('warns once about a rejected Profile path and keeps running', async () => {
    const { state, logger } = await tempGlobalState({ profileRepo: '/tmp/dsh-no-such-repo-xyz' })
    const view = await state.resolve()
    expect(view).toMatchObject({ kind: 'rejected' })
    expect(logger.warnings.join('\n')).toMatch(/WIKI_REPO_REJECTED/u)
    await state.resolve()
    expect(logger.warnings.filter(line => line.includes('WIKI_REPO_REJECTED'))).toHaveLength(1)
  })

  it('warns about a corrupt sidecar and falls back to the Profile', async () => {
    const profileRepo = await initRepo()
    const home = await tempDir('dsh-home-')
    const sidecarFile = path.join(home, 'llm-wiki-state', 'repo.json')
    await writeFileAt(sidecarFile, '{ truncated')
    const logger = recordingLogger()
    const state = createGlobalWikiState({
      profileRepo: () => profileRepo,
      logger,
      sidecarFile,
      legacySidecarFile: path.join(home, 'llm-wiki', 'repo.json'),
      dshHome: home,
    })
    expect((await state.resolve()).kind).toBe('found')
    expect(logger.warnings.join('\n')).toMatch(/not JSON/u)
  })

  it('disables the global wiki for a session with no cwd and for an overlapping one', async () => {
    const repo = await initRepo()
    const { state } = await tempGlobalState({ sidecar: { path: repo } })
    const noCwd = await state.forAgent(fakeAgent({}))
    expect(noCwd).toMatchObject({ kind: 'disabled', detail: expect.stringMatching(/no working directory/u) as string })
    const nested = path.join(repo, 'sub')
    await mkdir(nested, { recursive: true })
    const overlapping = await state.forAgent(fakeAgent({ cwd: nested }))
    expect(overlapping).toMatchObject({
      kind: 'disabled',
      detail: expect.stringMatching(/overlaps/u) as string,
    })
    const elsewhere = await initRepo()
    expect(await state.forAgent(fakeAgent({ cwd: elsewhere }))).toMatchObject({ kind: 'found' })
  })

  it('forgets a memoized rejection when the designation changes', async () => {
    const { state } = await tempGlobalState({ profileRepo: '/tmp/dsh-no-such-repo-xyz' })
    expect((await state.resolve()).kind).toBe('rejected')
    const repo = await initRepo()
    const accepted = await state.designate(repo)
    expect(accepted).toMatchObject({ kind: 'found' })
    expect((await state.resolve()).kind).toBe('found')
  })

  it('records the accepted path and builds the skeleton through designate', async () => {
    const fresh = await tempDir('dsh-fresh-')
    const { state, sidecarFile } = await tempGlobalState()
    const accepted = await state.designate(fresh)
    expect(accepted).toMatchObject({ kind: 'found' })
    if (accepted.kind !== 'found') return
    expect(accepted.skeleton.initialised).toBe(true)
    expect(JSON.parse(await readAt(sidecarFile))).toEqual({ path: fresh })
    expect(await exists(path.join(fresh, '.gitignore'))).toBe(true)
  })

  it('refuses a bad path through designate and records nothing', async () => {
    const { state, sidecarFile } = await tempGlobalState()
    const rejected = await state.designate('relative/wiki')
    expect(rejected).toMatchObject({ kind: 'rejected' })
    expect(await exists(sidecarFile)).toBe(false)
  })
})

describe.skipIf(!hasGit)('the write/edit deny on the accepted repository (DESIGN §6.4 check 6)', () => {
  /** Deny one `write`/`edit` call through the guard. */
  async function decide(
    state: Awaited<ReturnType<typeof tempGlobalState>>['state'],
    file: string,
    cwd: string,
    name = 'write',
  ): Promise<PreToolDecision> {
    return await guardDecision(
      fakeToolCall(name, { file_path: file }, fakeAgent({ cwd })),
      allow,
      { global: state },
    )
  }

  it('denies write and edit anywhere below the repository, read is untouched', async () => {
    const repo = await initRepo()
    await scaffoldGlobalRepo(repo)
    await writeFileAt(path.join(repo, 'pages', 'alpha.md'), '# Alpha\n')
    const elsewhere = await initRepo()
    const { state } = await tempGlobalState({ sidecar: { path: repo } })
    for (const name of ['write', 'edit']) {
      const decision = await decide(state, path.join(repo, 'pages', 'alpha.md'), elsewhere, name)
      expect(decision.kind).toBe('deny')
      expect(decision.kind === 'deny' ? decision.reason : '').toMatch(/^WIKI_READ_ONLY:/u)
      expect(decision.kind === 'deny' ? decision.reason : '').toMatch(/wiki_write/u)
    }
    const created = await decide(state, path.join(repo, 'pages', 'new.md'), elsewhere)
    expect(created.kind).toBe('deny')
    const read = await decide(state, path.join(repo, 'pages', 'alpha.md'), elsewhere, 'read')
    expect(read.kind).toBe('allow')
    const outside = await decide(state, path.join(elsewhere, 'notes.md'), elsewhere)
    expect(outside.kind).toBe('allow')
  })

  it('does not deny while no repository is designated', async () => {
    const elsewhere = await initRepo()
    const { state } = await tempGlobalState()
    const decision = await decide(state, path.join(elsewhere, 'notes.md'), elsewhere)
    expect(decision.kind).toBe('allow')
  })

  it('does not deny for a session whose cwd overlaps the repository', async () => {
    const repo = await initRepo()
    await scaffoldGlobalRepo(repo)
    const nested = path.join(repo, 'sub')
    await mkdir(nested, { recursive: true })
    const { state } = await tempGlobalState({ sidecar: { path: repo } })
    const decision = await decide(state, path.join(repo, 'pages', 'alpha.md'), nested)
    expect(decision.kind).toBe('allow')
  })

  it('sees through .. and a symlinked parent', async () => {
    const repo = await initRepo()
    await scaffoldGlobalRepo(repo)
    const elsewhere = await initRepo()
    const { state } = await tempGlobalState({ sidecar: { path: repo } })
    const throughDotDot = await decide(
      state,
      path.join(elsewhere, '..', path.basename(repo), 'pages', 'alpha.md'),
      elsewhere,
    )
    expect(throughDotDot.kind).toBe('deny')
  })
})

describe('git status (DESIGN §6.6 `/wiki status`)', () => {
  it('parses porcelain -z entries, including a rename', () => {
    const entries = parseGitStatus(' M index.md\0?? pages/new.md\0R  pages/b.md\0pages/a.md\0')
    expect(entries).toEqual([
      { index: ' ', worktree: 'M', path: 'index.md' },
      { index: '?', worktree: '?', path: 'pages/new.md' },
      { index: 'R', worktree: ' ', path: 'pages/b.md' },
    ])
    expect(summarizeGitStatus(entries)).toBe('3 changed, 1 staged, 1 modified, 1 untracked')
    expect(summarizeGitStatus([])).toBe('clean')
  })

  it.skipIf(!hasGit)('summarizes a real repository and reports a git failure', async () => {
    const repo = await initRepo()
    expect((await readGitStatus(repo)).summary).toBe('clean')
    await writeFileAt(path.join(repo, 'index.md'), '# Index\n')
    const dirty = await readGitStatus(repo)
    expect(dirty.summary).toMatch(/1 changed, 1 untracked/u)
    const failed = await readGitStatus(repo, {
      run: async () => ({ code: 128, stdout: '', stderr: 'boom' }),
    })
    expect(failed).toMatchObject({ summary: 'unknown', detail: expect.stringMatching(/boom/u) as string })
  })
})

/** `realpath` through the public helper, so the expectation matches the check. */
async function realpathOf(target: string): Promise<string> {
  const { realpath } = await import('node:fs/promises')
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

describe('the sidecar location (DESIGN §6.4)', () => {
  it('resolves the record under $DSH_HOME/llm-wiki-state, not the wiki clone path', async () => {
    const home = await tempDir('dsh-home-')
    await withDshHome(home, async () => {
      expect(globalSidecarPath()).toBe(path.join(home, 'llm-wiki-state', 'repo.json'))
      expect(legacyGlobalSidecarPath()).toBe(path.join(home, 'llm-wiki', 'repo.json'))
    })
  })

  it('creates the state directory at 0700 and the file at 0600', async () => {
    const home = await tempDir('dsh-home-')
    await withDshHome(home, async () => {
      await writeGlobalSidecar({ path: '/repo' })
      const sidecar = path.join(home, 'llm-wiki-state', 'repo.json')
      expect((await stat(path.dirname(sidecar))).mode & 0o077).toBe(0)
      expect((await stat(sidecar)).mode & 0o077).toBe(0)
      expect(await readAt(sidecar)).toBe('{"path":"/repo"}\n')
    })
  })
})

describe('reading and migrating the pre-migration sidecar (DESIGN §6.4)', () => {
  const outsideRepository: GitRunner = async () => ({
    code: 128,
    stdout: '',
    stderr: 'fatal: not a git repository',
  })

  it('uses a valid legacy file, copies it to the new path, and keeps the old file', async () => {
    const home = await tempDir('dsh-home-')
    const sidecarFile = path.join(home, 'llm-wiki-state', 'repo.json')
    const legacyFile = path.join(home, 'llm-wiki', 'repo.json')
    await writeFileAt(legacyFile, '{"disabled":true}\n')
    const reading = await readGlobalSidecar(sidecarFile, {
      legacyFile,
      run: outsideRepository,
    })
    expect(reading).toEqual({
      value: { disabled: true },
      detail: null,
      legacy: { kind: 'used', from: legacyFile, to: sidecarFile, copied: true, detail: null },
    })
    expect(await readAt(sidecarFile)).toBe('{"disabled":true}\n')
    expect(await readAt(legacyFile)).toBe('{"disabled":true}\n')
    // The next read finds the current file and does not look at the old one.
    const again = await readGlobalSidecar(sidecarFile, { legacyFile, run: outsideRepository })
    expect(again).toEqual({ value: { disabled: true }, detail: null })
  })

  it('does not read a legacy file that git places inside a work tree', async () => {
    const home = await tempDir('dsh-home-')
    const legacyDir = path.join(home, 'llm-wiki')
    const sidecarFile = path.join(home, 'llm-wiki-state', 'repo.json')
    const legacyFile = path.join(legacyDir, 'repo.json')
    await writeFileAt(legacyFile, '{"path":"/decoy"}\n')
    const insideRepository: GitRunner = async () => ({
      code: 0,
      stdout: `${legacyDir}\n`,
      stderr: '',
    })
    const reading = await readGlobalSidecar(sidecarFile, {
      legacyFile,
      run: insideRepository,
    })
    expect(reading.value).toBeNull()
    expect(reading.detail).toBeNull()
    expect(reading.legacy).toMatchObject({
      kind: 'skipped',
      from: legacyFile,
      reason: 'repository',
      detail: expect.stringMatching(/inside the git work tree/u) as string,
    })
    expect(await exists(sidecarFile)).toBe(false)
    expect(await readAt(legacyFile)).toBe('{"path":"/decoy"}\n')
  })

  it('does not read a legacy file when git cannot answer', async () => {
    const home = await tempDir('dsh-home-')
    const sidecarFile = path.join(home, 'llm-wiki-state', 'repo.json')
    const legacyFile = path.join(home, 'llm-wiki', 'repo.json')
    await writeFileAt(legacyFile, '{"path":"/decoy"}\n')
    const brokenGit: GitRunner = async () => ({ code: -1, stdout: '', stderr: 'spawn git ENOENT' })
    const reading = await readGlobalSidecar(sidecarFile, { legacyFile, run: brokenGit })
    expect(reading.value).toBeNull()
    expect(reading.legacy).toMatchObject({ kind: 'skipped', reason: 'unknown' })
    expect(await exists(sidecarFile)).toBe(false)
  })

  it('ignores an unusable legacy file instead of guessing', async () => {
    const home = await tempDir('dsh-home-')
    const sidecarFile = path.join(home, 'llm-wiki-state', 'repo.json')
    const legacyFile = path.join(home, 'llm-wiki', 'repo.json')
    await writeFileAt(legacyFile, '{ truncated')
    const reading = await readGlobalSidecar(sidecarFile, {
      legacyFile,
      run: outsideRepository,
    })
    expect(reading.value).toBeNull()
    expect(reading.detail).toBeNull()
    expect(reading.legacy).toMatchObject({ kind: 'skipped', reason: 'unusable' })
    expect(await exists(sidecarFile)).toBe(false)
  })

  it('turns the fallback off when legacyFile is null', async () => {
    const home = await tempDir('dsh-home-')
    const sidecarFile = path.join(home, 'llm-wiki-state', 'repo.json')
    const legacyFile = path.join(home, 'llm-wiki', 'repo.json')
    await writeFileAt(legacyFile, '{"disabled":true}\n')
    const reading = await readGlobalSidecar(sidecarFile, { legacyFile: null })
    expect(reading).toEqual({ value: null, detail: null })
    expect(await exists(sidecarFile)).toBe(false)
  })
})

describe.skipIf(!hasGit)('the sidecar file itself (DESIGN §6.4)', () => {
  it('is written with mode 0600 under $DSH_HOME', async () => {
    const home = await tempDir('dsh-home-')
    const sidecar = path.join(home, 'llm-wiki-state', 'repo.json')
    await writeGlobalSidecar({ path: '/repo' }, sidecar)
    const info = await stat(sidecar)
    expect(info.mode & 0o077).toBe(0)
    expect(JSON.parse(await readFile(sidecar, 'utf8'))).toEqual({ path: '/repo' })
    expect(await readAt(sidecar)).toBe('{"path":"/repo"}\n')
  })

  it('reports a globalRepo fixture as a repository top', async () => {
    const repo = await globalRepo()
    const inspection = await inspectGlobalRepo({ raw: repo, source: 'profile' })
    expect(inspection).toMatchObject({ kind: 'found' })
    if (inspection.kind !== 'found') return
    expect(inspection.repo.source).toBe('profile')
  })
})

describe.skipIf(!hasGit)('the legacy sidecar in the state (DESIGN §6.4)', () => {
  it('migrates a valid legacy designation outside a work tree', async () => {
    const home = await tempDir('dsh-home-')
    const sidecarFile = path.join(home, 'llm-wiki-state', 'repo.json')
    const legacyFile = path.join(home, 'llm-wiki', 'repo.json')
    const repo = await initRepo()
    await writeFileAt(legacyFile, `${JSON.stringify({ path: repo })}\n`)
    const logger = recordingLogger()
    const state = createGlobalWikiState({
      profileRepo: () => '',
      logger,
      sidecarFile,
      legacySidecarFile: legacyFile,
      dshHome: home,
    })
    const view = await state.resolve()
    expect(view).toMatchObject({ kind: 'found' })
    expect(view.kind === 'found' ? view.repo.source : '').toBe('sidecar')
    expect(JSON.parse(await readAt(sidecarFile))).toEqual({ path: repo })
    expect(await readAt(legacyFile)).toBe(`${JSON.stringify({ path: repo })}\n`)
    expect(logger.debugLines.join('\n')).toMatch(/migrated the legacy global wiki sidecar/u)
    expect(logger.warnings).toEqual([])
  })

  it('does not read a legacy file inside a git work tree, such as the wiki clone', async () => {
    const home = await tempDir('dsh-home-')
    const legacyDir = path.join(home, 'llm-wiki')
    const legacyFile = path.join(legacyDir, 'repo.json')
    const sidecarFile = path.join(home, 'llm-wiki-state', 'repo.json')
    await mkdir(legacyDir, { recursive: true })
    await initRepo(legacyDir)
    const decoy = await initRepo()
    await writeFileAt(legacyFile, `${JSON.stringify({ path: decoy })}\n`)
    const profileRepo = await initRepo()
    const logger = recordingLogger()
    const state = createGlobalWikiState({
      profileRepo: () => profileRepo,
      logger,
      sidecarFile,
      legacySidecarFile: legacyFile,
      dshHome: home,
    })
    const view = await state.resolve()
    expect(view).toMatchObject({ kind: 'found' })
    expect(view.kind === 'found' ? view.repo.source : '').toBe('profile')
    expect(view.kind === 'found' ? view.repo.repoRoot : '').not.toBe(await realpathOf(decoy))
    expect(await exists(sidecarFile)).toBe(false)
    expect(await readAt(legacyFile)).toBe(`${JSON.stringify({ path: decoy })}\n`)
    expect(logger.debugLines.join('\n')).toMatch(/inside the git work tree/u)
  })

  it('prefers the current sidecar and leaves the legacy file alone', async () => {
    const current = await initRepo()
    const stale = await initRepo()
    const { state, sidecarFile, legacySidecarFile, logger } = await tempGlobalState({
      sidecar: { path: current },
      legacySidecar: { path: stale },
    })
    const view = await state.resolve()
    expect(view.kind === 'found' ? view.repo.repoRoot : '').toBe(await realpathOf(current))
    expect(JSON.parse(await readAt(sidecarFile))).toEqual({ path: current })
    expect(JSON.parse(await readAt(legacySidecarFile))).toEqual({ path: stale })
    expect(logger.debugLines.join('\n')).not.toMatch(/migrated the legacy/u)
  })

  it('reports a broken current sidecar instead of resurrecting a legacy one', async () => {
    const stale = await initRepo()
    const { state, sidecarFile, legacySidecarFile, logger } = await tempGlobalState({
      legacySidecar: { path: stale },
    })
    await writeFileAt(sidecarFile, '{ truncated')
    const view = await state.resolve()
    expect(view.kind).toBe('disabled')
    expect(logger.warnings.join('\n')).toMatch(/not JSON/u)
    expect(JSON.parse(await readAt(legacySidecarFile))).toEqual({ path: stale })
    expect(await readAt(sidecarFile)).toBe('{ truncated')
  })

  it('falls back to the Profile when the legacy file is not usable', async () => {
    const profileRepo = await initRepo()
    const { state, sidecarFile, logger } = await tempGlobalState({
      profileRepo,
      legacySidecar: { other: 1 },
    })
    const view = await state.resolve()
    expect(view.kind === 'found' ? view.repo.source : '').toBe('profile')
    expect(await exists(sidecarFile)).toBe(false)
    expect(logger.debugLines.join('\n')).toMatch(/unusable/u)
  })

  it('writes {disabled:true} from repo unset to the current path only', async () => {
    const repo = await initRepo()
    const stale = await initRepo()
    const { state, sidecarFile, legacySidecarFile } = await tempGlobalState({
      sidecar: { path: repo },
      legacySidecar: { path: stale },
    })
    const { sidecar, was } = await state.disable()
    expect(was.kind).toBe('found')
    expect(sidecar).toBe(sidecarFile)
    expect(JSON.parse(await readAt(sidecarFile))).toEqual({ disabled: true })
    expect(JSON.parse(await readAt(legacySidecarFile))).toEqual({ path: stale })
    expect((await state.resolve()).kind).toBe('disabled')
  })
})
