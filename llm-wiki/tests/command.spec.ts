/**
 * `/wiki` suite (DESIGN §6.6): `status`, `lint`, `reindex`, the unknown
 * subcommand path, and the effective-policy line. The command is exercised
 * through {@link runWikiCommand}, which is exactly what the registered handler
 * calls.
 *
 * `commit` and `repo set`/`repo unset` have their own suite (`commit.test.ts`),
 * because they need a designated repository and a real git history.
 * @module @anago-harness/llm-wiki/tests/command.spec
 */
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  parseLintChecks,
  runWikiCommand,
  WIKI_COMMAND_HINT,
  WIKI_SUBCOMMANDS,
  WIKI_USAGE,
} from '../src/command.ts'
import { createWikiSearchIndex, type WikiSearchIndex } from '../src/search.ts'
import { wikiConfig } from './support.ts'
import {
  cleanupTempDirs,
  fakeAgent,
  fakeApproval,
  fakeInvocation,
  gitAvailable,
  initRepo,
  recordingLogger,
  scaffoldGlobalRepo,
  scaffoldWiki,
  writeGlobalIndex,
  writeGlobalPage,
  tempGlobalState,
  writeGitignore,
  wikiDir,
  writeIndex,
  writePage,
  writeSettings,
} from './support.ts'

const hasGit = gitAvailable()
afterAll(cleanupTempDirs)

/** Run one line through the command, with a real state whose files are temporary. */
async function run(
  line: string,
  options: {
    cwd?: string
    config?: Record<string, unknown>
    approval?: ReturnType<typeof fakeApproval>
    noService?: boolean
    profileRepo?: string
  } = {},
): Promise<{ kind: string; text: string; search: WikiSearchIndex }> {
  const agent = fakeAgent(options.cwd === undefined ? {} : { cwd: options.cwd })
  const profile = options.config?.global as { repo?: string } | undefined
  const profileRepo = options.profileRepo ?? profile?.repo
  const { state } = await tempGlobalState(profileRepo === undefined ? {} : { profileRepo })
  const config = wikiConfig(options.config ?? {})
  const logger = recordingLogger()
  const search = createWikiSearchIndex({ config, logger })
  const result = await runWikiCommand(fakeInvocation(agent, line), {
    config,
    logger,
    global: state,
    search,
    ...(options.noService === true ? {} : { approval: () => options.approval ?? fakeApproval({ policy: 'ask' }) }),
  })
  return { kind: result.kind, text: result.text ?? '', search }
}

describe('metadata', () => {
  it('implements status, lint, repo, commit, and reindex', () => {
    expect([...WIKI_SUBCOMMANDS]).toEqual(['status', 'lint', 'repo', 'commit', 'reindex'])
    expect(WIKI_USAGE).toContain('/wiki <subcommand>')
    expect(WIKI_USAGE).toContain('repo set <path>')
    expect(WIKI_USAGE).toContain('reindex')
    expect(WIKI_COMMAND_HINT).toContain('status')
    expect(WIKI_COMMAND_HINT).toContain('reindex')
  })
})

describe('parseLintChecks', () => {
  it('defaults to every check and accepts a comma list', () => {
    expect(parseLintChecks([])).toEqual({ checks: ['links', 'index', 'raw'] })
    expect(parseLintChecks(['links'])).toEqual({ checks: ['links'] })
    expect(parseLintChecks(['links,raw'])).toEqual({ checks: ['links', 'raw'] })
    expect(parseLintChecks(['index', 'links'])).toEqual({ checks: ['links', 'index'] })
  })

  it('refuses an unknown check rather than silently running everything', () => {
    const parsed = parseLintChecks(['link'])
    expect('error' in parsed && parsed.error).toMatch(/unknown check\(s\): link/u)
  })

  it('uses the configured checks when no name is given', () => {
    expect(parseLintChecks([], ['links', 'index'])).toEqual({ checks: ['links', 'index'] })
    expect(parseLintChecks([], ['index'])).toEqual({ checks: ['index'] })
  })

  it('refuses an empty name list rather than running no check', () => {
    const parsed = parseLintChecks([','])
    expect('error' in parsed && parsed.error).toMatch(/no check given/u)
  })
})

describe.skipIf(!hasGit)('/wiki status', () => {
  it('reports the root, the page count, writability, commit, the ignore state, and the policy', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha' })
    await writeIndex(root, ['alpha'])
    await writeSettings(root, 'version: 1\ncommit: true\n')
    await writeGitignore(root, ['!.dsh/wiki/'])
    const { kind, text } = await run('status', { cwd: root, approval: fakeApproval({ policy: 'ask' }) })
    expect(kind).toBe('success')
    expect(text).toContain(`project wiki: ${path.join(root, '.dsh', 'wiki')}`)
    expect(text).toContain('pages: 1')
    expect(text).toContain('writable: yes')
    expect(text).toContain('commit: true')
    // `!.dsh/wiki/` makes the directory visible, which is what a tracked wiki needs.
    expect(text).toContain('ignore: visible')
    expect(text).toContain('which is what a tracked wiki needs')
    expect(text).toContain('writeApproval: none')
    expect(text).toContain('approval policy now: ask')
    expect(text).toContain('global wiki: none')
    expect(text).toContain('no global wiki repository is designated')
  })

  it('says the wiki is read-only below the checkout root and reports a warning', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writeSettings(root, 'commit: true\n')
    const below = path.join(root, 'packages', 'x')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(below, { recursive: true })
    const { text } = await run('status', { cwd: below })
    expect(text).toContain('writable: no')
    expect(text).toContain('read-only')
    // commit: true while the wiki is not un-ignored is a warning from §6.3.
    expect(text).toContain('warning:')
    expect(text).toContain('commit: true')
  })

  it('prints the never sentence when the session can never be prompted', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const { text } = await run('status', {
      cwd: root,
      config: { writeApproval: 'ask' },
      approval: fakeApproval({ policy: 'never' }),
    })
    expect(text).toContain('writeApproval: ask')
    expect(text).toContain('approval policy now: never')
    expect(text).toContain('cannot be prompted')
    expect(text).toContain('WIKI_APPROVAL_UNAVAILABLE')
  })

  it('prints the ask sentence when the session can be prompted', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const { text } = await run('status', {
      cwd: root,
      config: { writeApproval: 'ask' },
      approval: fakeApproval({ policy: 'ask' }),
    })
    expect(text).toContain('asks for approval before writing')
  })

  it('treats a deployment without the approval service as never', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const { text } = await run('status', {
      cwd: root,
      config: { writeApproval: 'ask' },
      noService: true,
    })
    expect(text).toContain('approval policy now: never')
    expect(text).toContain('no approval service is loaded')
  })

  it('rejects a Profile path that does not exist, and says so', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const { text } = await run('status', { cwd: root, config: { global: { repo: '/tmp/no-such-wiki-repo' } } })
    expect(text).toContain('global wiki: none')
    expect(text).toContain('WIKI_REPO_REJECTED')
    expect(text).toContain('does not exist')
  })

  it('shows the global root, its page count, git status, and source when one is designated', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const global = await initRepo()
    await scaffoldGlobalRepo(global)
    await writeGlobalPage(global, { slug: 'shared' })
    await writeGlobalIndex(global, ['shared'])
    const { state } = await tempGlobalState({ sidecar: { path: global } })
    const agent = fakeAgent({ cwd: root })
    const config = wikiConfig()
    const logger = recordingLogger()
    const result = await runWikiCommand(fakeInvocation(agent, 'status'), {
      config,
      logger,
      global: state,
      search: createWikiSearchIndex({ config, logger }),
      approval: () => fakeApproval({ policy: 'ask' }),
    })
    const text = result.text ?? ''
    expect(text).toContain(`global wiki: ${global}`)
    expect(text).toContain('pages: 1')
    expect(text).toContain('enabled here: yes')
    expect(text).toContain('git status:')
    expect(text).toContain('recorded by /wiki repo set')
    expect(text).toContain('write/edit are refused below the global repository')
  })

  it('reports the session cwd and a missing git worktree', async () => {
    const { text } = await run('status', { cwd: path.join(process.cwd(), 'no-such-repo') })
    expect(text).toContain('project wiki: none')
  })
})

describe.skipIf(!hasGit)('/wiki lint', () => {
  it('runs the same checks the tool runs and prints the issues', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha', body: 'See [[missing]].\n' })
    await writeIndex(root, ['alpha'])
    const { kind, text } = await run('lint', { cwd: root })
    expect(kind).toBe('success')
    expect(text).toContain('.dsh/wiki/: 1 page(s), checks: links, index, raw')
    expect(text).toContain('unresolved-link')
    expect(text).toContain('[[missing]]')
    expect(text).toContain('no global wiki repository is designated')
  })

  it('reports a clean wiki as clean', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha' })
    await writeIndex(root, ['alpha'])
    const { text } = await run('lint', { cwd: root })
    expect(text).toContain('no issues')
  })

  it('honours a check list', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha', body: 'See [[missing]].\n' })
    await writeIndex(root, ['alpha'])
    const { text } = await run('lint index', { cwd: root })
    expect(text).toContain('checks: index')
    expect(text).not.toContain('unresolved-link')
  })

  it('runs the configured checks when no argument names them', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha', body: 'See [[missing]].\n' })
    await writeIndex(root, ['alpha'])
    const { kind, text } = await run('lint', {
      cwd: root,
      config: { lint: { checks: ['links', 'index'] } },
    })
    expect(kind).toBe('success')
    expect(text).toContain('checks: links, index')
    expect(text).not.toContain('checks: links, index, raw')
  })

  it('lets an explicit list override the configured checks', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha', body: 'See [[missing]].\n' })
    await writeIndex(root, ['alpha'])
    const { text } = await run('lint links', {
      cwd: root,
      config: { lint: { checks: ['index'] } },
    })
    expect(text).toContain('checks: links')
    expect(text).toContain('unresolved-link')
  })

  it('refuses an unknown check name', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const { kind, text } = await run('lint nonsense', { cwd: root })
    expect(kind).toBe('error')
    expect(text).toMatch(/unknown check/u)
  })

  it('says there is no wiki rather than reporting a broken one', async () => {
    const root = await initRepo()
    const { kind, text } = await run('lint', { cwd: root })
    expect(kind).toBe('success')
    expect(text).toContain('no project wiki here')
  })
})

describe('reindex (DESIGN §6.5)', () => {
  it('builds the project index and reports what it covers', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha' })
    await writeIndex(root, ['alpha'])
    const { kind, text, search } = await run('reindex', { cwd: root })
    expect(kind).toBe('success')
    expect(text).toContain('project wiki')
    expect(text).toMatch(/1 page\(s\) indexed/u)
    expect(search.state(wikiDir(root))?.pageCount).toBe(1)
  })

  it('reports a missing project wiki and no global wiki without failing', async () => {
    const root = await initRepo()
    const { kind, text } = await run('reindex', { cwd: root })
    expect(kind).toBe('success')
    expect(text).toContain('project wiki: none')
    expect(text).toContain('global wiki: none')
  })
})

describe('unknown subcommands', () => {
  it('shows the usage for no subcommand and for an unknown one', async () => {
    expect((await run('')).text).toContain('usage: /wiki <subcommand>')
    expect((await run('everything')).text).toContain("unknown subcommand 'everything'")
  })

  it('reports a missing working directory', async () => {
    const { kind, text } = await run('status')
    expect(kind).toBe('error')
    expect(text).toMatch(/no working directory/u)
  })
})
