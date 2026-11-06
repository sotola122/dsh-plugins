/**
 * `/wiki repo set`・`repo unset`・`commit` (DESIGN §6.4, D4, §11 order 5).
 *
 * The commit is the one path by which wiki content enters git, and it is a
 * person who runs it. The suite's central case is the sixth revision's finding
 * 1: `git add` and `git commit --only` are limited to the four wiki paths, so an
 * **unrelated staged file stays staged and is not in the new commit**.
 * @module @anago-harness/llm-wiki/tests/commit.spec
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  COMMIT_PATHSPECS,
  DEFAULT_COMMIT_MESSAGE,
  runWikiCommand,
  type WikiCommandDeps,
} from '../src/command.ts'
import { createWikiSearchIndex, type WikiSearchIndex } from '../src/search.ts'
import {
  cleanupTempDirs,
  exists,
  fakeAgent,
  fakeApproval,
  fakeInvocation,
  git,
  gitAvailable,
  initRepo,
  readAt,
  recordingLogger,
  scaffoldGlobalRepo,
  tempGlobalState,
  wikiConfig,
  writeFileAt,
  writeGlobalIndex,
  writeGlobalPage,
} from './support.ts'

const hasGit = gitAvailable()
afterAll(cleanupTempDirs)

/** Run one line through the command against a real state. */
async function run(
  line: string,
  options: {
    cwd?: string
    profileRepo?: string
    sidecar?: unknown
    legacySidecar?: unknown
    config?: Record<string, unknown>
    global?: string
  } = {},
): Promise<{
  kind: string
  text: string
  sidecarFile: string
  legacySidecarFile: string
  global: string
  search: WikiSearchIndex
}> {
  const global = options.global ?? (await initRepo())
  const { state, sidecarFile, legacySidecarFile } = await tempGlobalState({
    ...(options.sidecar === undefined ? {} : { sidecar: options.sidecar }),
    ...(options.legacySidecar === undefined ? {} : { legacySidecar: options.legacySidecar }),
    ...(options.profileRepo === undefined ? {} : { profileRepo: options.profileRepo }),
  })
  const agent = fakeAgent(options.cwd === undefined ? {} : { cwd: options.cwd })
  const config = wikiConfig(options.config ?? {})
  const logger = recordingLogger()
  const search = createWikiSearchIndex({ config, logger })
  const deps: WikiCommandDeps = {
    config,
    logger,
    global: state,
    search,
    approval: () => fakeApproval({ policy: 'ask' }),
  }
  const result = await runWikiCommand(fakeInvocation(agent, line), deps)
  return { kind: result.kind, text: result.text ?? '', sidecarFile, legacySidecarFile, global, search }
}

/**
 * A repository with a committed wiki, one unrelated staged file, and a **second
 * repository** to run the session from: a session whose cwd sits inside the
 * global wiki has the global wiki disabled for the model (DESIGN §6.4 check 5),
 * so `/wiki commit` is exercised from outside it.
 */
async function committedWiki(): Promise<{ repo: string; session: string }> {
  const repo = await initRepo()
  await scaffoldGlobalRepo(repo)
  await writeGlobalPage(repo, { slug: 'alpha' })
  await writeGlobalIndex(repo, ['alpha'])
  git(repo, ['add', '--', ...COMMIT_PATHSPECS])
  git(repo, ['commit', '--quiet', '-m', 'init wiki'])
  await writeFileAt(path.join(repo, 'unrelated.txt'), 'unrelated\n')
  git(repo, ['add', '--', 'unrelated.txt'])
  return { repo, session: await initRepo() }
}

describe.skipIf(!hasGit)('/wiki repo set and repo unset (DESIGN §6.4)', () => {
  it('accepts an existing repository top, records it, and creates the skeleton', async () => {
    const repo = await initRepo()
    const other = await initRepo()
    const { kind, text, sidecarFile, legacySidecarFile } = await run(`repo set ${repo}`, {
      cwd: other,
      sidecar: undefined,
    })
    expect(kind).toBe('success')
    expect(text).toContain(`global wiki: ${repo}`)
    expect(text).toContain('recorded in')
    expect(text).toMatch(/llm-wiki-state[\\/]repo\.json/u)
    expect(text).toContain('git init: not needed')
    expect(JSON.parse(await readAt(sidecarFile))).toEqual({ path: repo })
    // The record is never written where a wiki clone would live.
    expect(await exists(legacySidecarFile)).toBe(false)
    expect(await exists(path.join(repo, 'WIKI.md'))).toBe(true)
    expect(await readAt(path.join(repo, '.gitignore'))).toBe('*.lock\n')
  })

  it('drops the index of the repository that a designation change leaves behind (DESIGN §6.5)', async () => {
    // One state and one index across the calls, as the plugin has: a
    // designation change must not keep answering from the previous root's index.
    const repo = await initRepo()
    await scaffoldGlobalRepo(repo)
    await writeGlobalPage(repo, { slug: 'alpha' })
    await writeGlobalIndex(repo, ['alpha'])
    const other = await initRepo()
    const { state } = await tempGlobalState({ sidecar: { path: repo } })
    const config = wikiConfig()
    const logger = recordingLogger()
    const search = createWikiSearchIndex({ config, logger })
    const deps: WikiCommandDeps = {
      config,
      logger,
      global: state,
      search,
      approval: () => fakeApproval({ policy: 'ask' }),
    }
    const agent = fakeAgent({ cwd: other })

    // repo set: the root designated until now loses its index.
    await search.ensure('global', repo, '')
    expect(search.state(repo)?.pageCount).toBe(1)
    const moved = await initRepo()
    await scaffoldGlobalRepo(moved)
    await writeGlobalPage(moved, { slug: 'beta' })
    await writeGlobalIndex(moved, ['beta'])
    const set = await runWikiCommand(fakeInvocation(agent, `repo set ${moved}`), deps)
    expect(set.kind).toBe('success')
    expect(search.state(repo)).toBeNull()

    // repo unset: the repository it disables loses its index, and the files stay.
    await search.ensure('global', moved, '')
    expect(search.state(moved)?.pageCount).toBe(1)
    const unset = await runWikiCommand(fakeInvocation(agent, 'repo unset'), deps)
    expect(unset.kind).toBe('success')
    expect(search.state(moved)).toBeNull()
    expect(await exists(path.join(moved, 'pages', 'alpha.md'))).toBe(false)
    expect(await exists(path.join(repo, 'pages', 'alpha.md'))).toBe(true)
  })

  it('initialises a directory that is outside every repository', async () => {
    const fresh = await (await import('./support.ts')).tempDir('dsh-fresh-')
    const other = await initRepo()
    const { kind, text } = await run(`repo set ${fresh}`, { cwd: other })
    expect(kind).toBe('success')
    expect(text).toContain('git init: ran')
    expect(git(fresh, ['remote']).trim()).toBe('')
  })

  it('refuses a relative path, a mismatched top, and an overlapping session', async () => {
    const repo = await initRepo()
    const other = await initRepo()
    const relative = await run('repo set relative/wiki', { cwd: other })
    expect(relative.kind).toBe('error')
    expect(relative.text).toMatch(/WIKI_REPO_REJECTED/u)
    expect(relative.text).toMatch(/not absolute/u)

    const nested = path.join(repo, 'nested')
    await mkdir(nested, { recursive: true })
    const mismatch = await run(`repo set ${nested}`, { cwd: other })
    expect(mismatch.kind).toBe('error')
    expect(mismatch.text).toMatch(/is not its top/u)

    const overlap = await run(`repo set ${repo}`, { cwd: nested })
    expect(overlap.kind).toBe('error')
    expect(overlap.text).toMatch(/working directory/u)
  })

  it('needs a path argument', async () => {
    const other = await initRepo()
    const { kind, text } = await run('repo set', { cwd: other })
    expect(kind).toBe('error')
    expect(text).toMatch(/needs a path/u)
  })

  it('turns the wiki off without deleting anything, overriding the Profile', async () => {
    const repo = await initRepo()
    await scaffoldGlobalRepo(repo)
    await writeGlobalPage(repo, { slug: 'alpha' })
    const other = await initRepo()
    const { kind, text, sidecarFile, legacySidecarFile } = await run('repo unset', {
      cwd: other,
      profileRepo: repo,
    })
    expect(kind).toBe('success')
    expect(text).toContain('global wiki: off')
    expect(text).toContain('untouched')
    expect(text).toMatch(/llm-wiki-state[\\/]repo\.json/u)
    expect(JSON.parse(await readAt(sidecarFile))).toEqual({ disabled: true })
    expect(await exists(legacySidecarFile)).toBe(false)
    expect(await exists(path.join(repo, 'pages', 'alpha.md'))).toBe(true)
  })

  it('reports an unknown repo action', async () => {
    const other = await initRepo()
    const { kind, text } = await run('repo everywhere', { cwd: other })
    expect(kind).toBe('error')
    expect(text).toMatch(/repo needs/u)
  })
})

describe.skipIf(!hasGit)('/wiki commit (DESIGN §6.4, D4)', () => {
  it('commits only pages/, raw/, index.md, and WIKI.md, and leaves an unrelated staged file staged', async () => {
    const { repo, session } = await committedWiki()
    await writeGlobalPage(repo, { slug: 'beta' })
    await writeGlobalIndex(repo, ['alpha', 'beta'])
    await writeFileAt(path.join(repo, 'WIKI.md'), '# Global wiki v2\n')
    await writeFileAt(path.join(repo, 'unrelated.txt'), 'unrelated v2\n')
    git(repo, ['add', '--', 'unrelated.txt'])

    const { kind, text } = await run('commit wiki: add beta', { cwd: session, sidecar: { path: repo } })
    expect(kind).toBe('success')
    expect(text).toContain('committed')
    expect(text).toContain('wiki: add beta')
    // `raw/` holds no file git knows, so it is dropped from the `--only`
    // pathspec list rather than making the commit fail.
    expect(text).toContain('paths: WIKI.md, index.md, pages (git commit --only')
    expect(text).toContain('nothing was pushed')

    // The new commit holds the wiki paths and nothing else.
    const files = git(repo, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').filter(line => line !== '')
    expect(files.sort()).toEqual(['WIKI.md', 'index.md', 'pages/beta.md'])
    // The unrelated file is still staged, exactly as it was.
    const status = git(repo, ['status', '--porcelain'])
    expect(status).toContain('A  unrelated.txt')
    expect(status).not.toContain('beta.md')
    // The skeleton's `.gitignore` is outside the four paths D4 allows, so it
    // stays untracked for a person to commit.
    expect(status).toContain('?? .gitignore')
  })

  it('uses a default message when none is given', async () => {
    const { repo, session } = await committedWiki()
    await writeFileAt(path.join(repo, 'WIKI.md'), '# v2\n')
    const { kind, text } = await run('commit', { cwd: session, sidecar: { path: repo } })
    expect(kind).toBe('success')
    expect(text).toContain(DEFAULT_COMMIT_MESSAGE)
  })

  it('reports nothing to commit as an error rather than a failure', async () => {
    const { repo, session } = await committedWiki()
    const { kind, text } = await run('commit', { cwd: session, sidecar: { path: repo } })
    expect(kind).toBe('error')
    // git's own words are forwarded; the exit status is what the design asks to
    // see, and it does not depend on the machine's locale.
    expect(text).toMatch(/git commit failed \(exit 1\): \S/u)
  })

  it('works with an empty pages/ and raw/, where git has no such pathspec', async () => {
    const repo = await initRepo()
    await scaffoldGlobalRepo(repo)
    await writeFileAt(path.join(repo, 'WIKI.md'), '# Charter v1\n')
    const session = await initRepo()
    const { kind, text } = await run('commit first', { cwd: session, sidecar: { path: repo } })
    expect(kind).toBe('success')
    expect(text).toContain('paths: WIKI.md, index.md')
    const files = git(repo, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n')
    expect(files).toContain('WIKI.md')
  })

  it('refuses when no global wiki is enabled', async () => {
    const other = await initRepo()
    const { kind, text } = await run('commit', { cwd: other })
    expect(kind).toBe('error')
    expect(text).toMatch(/WIKI_GLOBAL_DISABLED|WIKI_REPO_REJECTED/u)
  })

  it('commits from inside the wiki repository too, where the model may not write', async () => {
    const { repo } = await committedWiki()
    await writeFileAt(path.join(repo, 'WIKI.md'), '# v3\n')
    const { kind, text } = await run('commit from inside', { cwd: repo, sidecar: { path: repo } })
    expect(kind).toBe('success')
    expect(text).toContain('committed')
  })

  it('leaves an unrelated staged file staged (DESIGN §13 finding 1)', async () => {
    const { repo, session } = await committedWiki()
    expect(git(repo, ['status', '--porcelain'])).toContain('A  unrelated.txt')
    await writeFileAt(path.join(repo, 'index.md'), '- [[alpha]] — about alpha\n')
    await run('commit', { cwd: session, sidecar: { path: repo } })
    // Still staged, and still not in any commit.
    expect(git(repo, ['status', '--porcelain'])).toContain('A  unrelated.txt')
    expect(git(repo, ['log', '--all', '--name-only', '--format='])).not.toContain('unrelated.txt')
  })
})
