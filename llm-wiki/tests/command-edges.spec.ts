/**
 * `/wiki`'s edge cases (DESIGN §6.4, §6.5, §6.6): the argument forms and
 * failure replies the main suites do not reach — a UI that supplies no
 * cancellation signal, a `git` that fails, a repository whose wiki paths do not
 * exist yet, a `.dsh` symlink that makes the ignore check undecidable, an
 * index that an overtaking `invalidate` never stored, and a global state that
 * throws.
 *
 * `command.spec.ts` and `commit.spec.ts` own the happy paths; every case here
 * still goes through {@link runWikiCommand}, the entry point the registered
 * handler calls.
 * @module @anago-harness/llm-wiki/tests/command-edges.spec
 */
import { mkdir, readdir, symlink } from 'node:fs/promises'
import path from 'node:path'
import { createNodeGitRunner, type GitRunner } from '@anago-harness/knowledge-common'
import { afterAll, describe, expect, it } from 'vitest'
import { runWikiCommand, type WikiCommandDeps } from '../src/command.ts'
import type { WikiConfig } from '../src/config.ts'
import type { GlobalWikiState } from '../src/global.ts'
import { createWikiSearchIndex, type WikiSearchIndex } from '../src/search.ts'
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
  tempDir,
  tempGlobalState,
  wikiConfig,
  wikiDir,
  writeFileAt,
  writeGlobalIndex,
  writeGlobalPage,
  writeIndex,
  writePage,
} from './support.ts'

const hasGit = gitAvailable()

afterAll(cleanupTempDirs)

/** One recorded logger, for the suites that assert on the warn line. */
type Logger = ReturnType<typeof recordingLogger>

/** What one run needs beyond the line itself. */
interface RunOptions {
  /** The session's cwd; omitted means the session recorded none. */
  readonly cwd?: string
  /** Written to the sidecar, as `/wiki repo set` does. */
  readonly sidecar?: unknown
  /** `config.global.repo`; used when the sidecar says nothing. */
  readonly profileRepo?: string
  /** Resolved configuration; the schema's defaults when omitted. */
  readonly config?: WikiConfig
  /** The git seam, for the failure cases. */
  readonly run?: GitRunner
  /** A prebuilt index; a fresh one over `config` when omitted. */
  readonly search?: WikiSearchIndex
  /** A state to use instead of a fresh one. */
  readonly global?: GlobalWikiState
  /** Drop the invocation's signal, as a dispatching UI that supplies none does. */
  readonly withoutSignal?: boolean
  /** A logger to record into, for the assertion on the warn line. */
  readonly logger?: Logger
}

/** Run one `/wiki` line through the real command entry point. */
async function run(
  line: string,
  options: RunOptions = {},
): Promise<{ readonly kind: string; readonly text: string; readonly search: WikiSearchIndex; readonly logger: Logger }> {
  const agent = fakeAgent(options.cwd === undefined ? {} : { cwd: options.cwd })
  const config = options.config ?? wikiConfig()
  const logger = options.logger ?? recordingLogger()
  const search = options.search ?? createWikiSearchIndex({ config, logger })
  const state = options.global ?? (await tempGlobalState({
    ...(options.sidecar === undefined ? {} : { sidecar: options.sidecar }),
    ...(options.profileRepo === undefined ? {} : { profileRepo: options.profileRepo }),
  })).state
  const deps: WikiCommandDeps = {
    config,
    logger,
    global: state,
    search,
    approval: () => fakeApproval({ policy: 'ask' }),
    ...(options.run === undefined ? {} : { run: options.run }),
  }
  const invocation = fakeInvocation(agent, line)
  if (options.withoutSignal === true) Object.assign(invocation, { signal: undefined })
  const result = await runWikiCommand(invocation, deps)
  return { kind: result.kind, text: result.text ?? '', search, logger }
}

describe.skipIf(!hasGit)('/wiki status: the repository and the session view', () => {
  it('reports a Profile designation and a git status that failed', async () => {
    const project = await initRepo()
    await scaffoldWiki(project)
    const global = await initRepo()
    await scaffoldGlobalRepo(global)
    const failingStatus: GitRunner = async () => ({ code: 3, stdout: '', stderr: 'index.lock exists' })
    const { kind, text } = await run('status', { cwd: project, profileRepo: global, run: failingStatus })
    expect(kind).toBe('success')
    expect(text).toContain(`global wiki: ${global}`)
    expect(text).toContain('the Profile global.repo value (no sidecar record)')
    expect(text).toContain('git status: unknown — git status exited 3: index.lock exists')
    expect(text).toContain('enabled here: yes')
  })

  it('disables the global wiki for a session inside it, without a UI signal', async () => {
    const global = await initRepo()
    await scaffoldGlobalRepo(global)
    const { kind, text } = await run('status', {
      cwd: global,
      sidecar: { path: global },
      withoutSignal: true,
    })
    expect(kind).toBe('success')
    expect(text).toContain('enabled here: no —')
    expect(text).toContain('overlaps this session')
  })

  it('reports an ignore state that git cannot decide behind a symlink', async () => {
    const root = await initRepo()
    const outside = await tempDir('dsh-wiki-outside-')
    await writeFileAt(path.join(outside, 'wiki', 'index.md'), '# Index\n')
    await symlink(outside, path.join(root, '.dsh'), 'dir')
    const { kind, text } = await run('status', { cwd: root })
    expect(kind).toBe('success')
    expect(text).toContain('ignore: unknown — git check-ignore exited 128')
    expect(text).toContain('confirm by hand')
  })

  it('keeps the page count at zero when the page directory is unusable', async () => {
    const project = await initRepo()
    await scaffoldWiki(project)
    const global = await initRepo()
    await scaffoldGlobalRepo(global)
    await writeGlobalPage(global, { slug: 'shared' })
    await writeGlobalIndex(global, ['shared'])
    // The schema refuses `raw`; a config handed to the command directly (the
    // deps seam) can still carry it, and the count must not take the report down.
    const config: WikiConfig = { ...wikiConfig(), global: { repo: '', pagesDir: 'raw' } }
    const { kind, text } = await run('status', { cwd: project, sidecar: { path: global }, config })
    expect(kind).toBe('success')
    expect(text).toContain('page directory: raw/ (the Profile global.pagesDir)')
    expect(text).toContain('  pages: 0')
  })
})

describe.skipIf(!hasGit)('/wiki lint without a signal', () => {
  it('runs the same checks when the invocation carries no cancellation signal', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha' })
    await writeIndex(root, ['alpha'])
    const { kind, text } = await run('lint', { cwd: root, withoutSignal: true })
    expect(kind).toBe('success')
    expect(text).toContain('checks: links, index, raw')
    expect(text).toContain('no issues')
  })
})

describe.skipIf(!hasGit)('/wiki reindex (DESIGN §6.5)', () => {
  it('rebuilds both indexes when the invocation carries no signal', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha' })
    await writeIndex(root, ['alpha'])
    const global = await initRepo()
    await scaffoldGlobalRepo(global)
    await writeGlobalPage(global, { slug: 'shared' })
    await writeGlobalIndex(global, ['shared'])
    const { kind, text } = await run('reindex', {
      cwd: root,
      sidecar: { path: global },
      withoutSignal: true,
    })
    expect(kind).toBe('success')
    expect(text).toMatch(/project wiki \(.*\): 1 page\(s\) indexed/u)
    expect(text).toMatch(/global wiki \(.*\): 1 page\(s\) indexed/u)
  })

  it('warns when the rebuilt index is truncated', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha' })
    await writePage(root, { slug: 'beta' })
    await writeIndex(root, ['alpha', 'beta'])
    const { kind, text } = await run('reindex', {
      cwd: root,
      config: wikiConfig({ search: { maxPages: 1 } }),
    })
    expect(kind).toBe('success')
    expect(text).toContain('the search index is truncated')
  })

  it('reports zero pages for an index an overtaking invalidate never stored', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha' })
    await writeIndex(root, ['alpha'])
    const config = wikiConfig()
    const logger = recordingLogger()
    // The listing runs inside the build, so this is where a concurrent
    // invalidation can land.
    const overtake = { current: (): void => {} }
    const search = createWikiSearchIndex({
      config,
      logger,
      io: {
        listPages: async (directory) => {
          // A second `/wiki reindex` lands while this one is building: the
          // generation moves, so the finished index is not stored and the
          // report's `state()` answers null.
          overtake.current()
          const entries = await readdir(directory, { withFileTypes: true })
          return entries.map(entry => ({
            name: entry.name,
            isFile: entry.isFile(),
            isSymbolicLink: entry.isSymbolicLink(),
          }))
        },
      },
    })
    overtake.current = () => {
      search.invalidate()
    }
    const { kind, text } = await run('reindex', { cwd: root, search })
    expect(kind).toBe('success')
    expect(text).toMatch(/project wiki \(.*\): 0 page\(s\) indexed in \d+ ms, 0 posting bytes/u)
    expect(search.state(wikiDir(root))).toBeNull()
  })
})

describe.skipIf(!hasGit)('/wiki repo set and repo unset (DESIGN §6.4)', () => {
  it('accepts a path from a session with no cwd and no signal', async () => {
    const target = await initRepo()
    const { kind, text } = await run(`repo set ${target}`, { withoutSignal: true })
    expect(kind).toBe('success')
    expect(text).toContain(`global wiki: ${target}`)
    expect(text).toContain('git init: not needed')
  })

  it('says there was nothing to disable', async () => {
    const { kind, text } = await run('repo unset')
    expect(kind).toBe('success')
    expect(text).toContain('there was no enabled repository to leave behind')
  })

  it('asks for set or unset when repo has no action', async () => {
    const { kind, text } = await run('repo')
    expect(kind).toBe('error')
    expect(text).toContain('/wiki repo needs `set <path>` or `unset`')
  })
})

describe.skipIf(!hasGit)('/wiki commit failures (DESIGN §6.4)', () => {
  it('reports nothing to commit when none of the pathspecs exists', async () => {
    const repo = await initRepo()
    const session = await initRepo()
    const { kind, text } = await run('commit', { cwd: session, sidecar: { path: repo } })
    expect(kind).toBe('error')
    expect(text).toBe(`nothing to commit: none of WIKI.md, index.md, pages, raw exists in ${repo}`)
  })

  it('reports a failed git add with its exit status and output', async () => {
    const repo = await initRepo()
    await writeFileAt(path.join(repo, 'WIKI.md'), '# Global wiki\n')
    const session = await initRepo()
    const base = createNodeGitRunner()
    const failingAdd: GitRunner = async (args, options) =>
      args[0] === 'add'
        ? { code: 1, stdout: '', stderr: 'cannot add WIKI.md' }
        : await base(args, options)
    const { kind, text } = await run('commit', {
      cwd: session,
      sidecar: { path: repo },
      run: failingAdd,
    })
    expect(kind).toBe('error')
    expect(text).toBe('git add failed (exit 1): cannot add WIKI.md')
  })

  it('reports nothing to commit when git knows no file under the pathspecs', async () => {
    const repo = await initRepo()
    // Everything under `pages/` is ignored, so `git add` succeeds and stages
    // nothing: the wiki paths exist but git knows none of them.
    await writeFileAt(path.join(repo, '.gitignore'), 'pages/*\n')
    await mkdir(path.join(repo, 'pages'), { recursive: true })
    await writeFileAt(path.join(repo, 'pages', 'ignored.md'), '# Ignored\n')
    const session = await initRepo()
    const { kind, text } = await run('commit', { cwd: session, sidecar: { path: repo } })
    expect(kind).toBe('error')
    expect(text).toBe(
      `nothing to commit: no file under WIKI.md, index.md, pages, raw is known to git in ${repo}`,
    )
  })

  it('falls back to the message when git log fails, and reports a clean tree', async () => {
    const repo = await initRepo()
    await writeFileAt(path.join(repo, 'WIKI.md'), '# Global wiki\n')
    await writeFileAt(path.join(repo, 'index.md'), '- [[alpha]] — about alpha\n')
    const session = await initRepo()
    const base = createNodeGitRunner()
    const failingLog: GitRunner = async (args, options) =>
      args[0] === 'log' ? { code: 128, stdout: '', stderr: 'no commits' } : await base(args, options)
    const { kind, text } = await run('commit write the wiki', {
      cwd: session,
      sidecar: { path: repo },
      run: failingLog,
      withoutSignal: true,
    })
    expect(kind).toBe('success')
    expect(text).toContain(`committed write the wiki in ${repo}`)
    expect(text).toContain('working tree now clean')
    expect(text).toContain('nothing was pushed')
  })
})

describe.skipIf(!hasGit)('/wiki error containment', () => {
  it('reports a throwing global state instead of letting it escape', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const { state } = await tempGlobalState()
    const broken: GlobalWikiState = {
      ...state,
      resolve: async () => {
        throw new Error('the sidecar is on fire')
      },
    }
    const logger = recordingLogger()
    const { kind, text } = await run('status', { cwd: root, global: broken, logger })
    expect(kind).toBe('error')
    expect(text).toBe('/wiki status failed: the sidecar is on fire')
    expect(logger.warnings.join('\n')).toContain('/wiki status failed (the sidecar is on fire)')
  })
})
