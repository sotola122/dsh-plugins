/**
 * The global wiki's configurable page directory (`global.pagesDir`, DESIGN
 * §6.2, §6.4, §6.5, §6.6).
 *
 * An existing knowledge repository may keep its pages under `concepts/` instead
 * of `pages/`. The setting moves the **page** directory only: the index, the
 * lint, `wiki_write`, `/wiki commit`, `/wiki status`, the notice's count, and
 * the `wiki_search` display paths follow it, while `raw/`, `index.md`, and
 * `WIKI.md` stay put and the project wiki keeps `pages/`.
 *
 * The trust boundary is the point of the refusal cases: the value is a Profile
 * value that reaches a `path.join`, so `/`, `\`, `..`, an empty string, a
 * leading `.`, and an absolute path are refused rather than resolved.
 * @module @anago-harness/llm-wiki/tests/pages-dir.spec
 */
import path from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { afterAll, describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { commitPathspecs, runWikiCommand } from '../src/command.ts'
import {
  createGlobalWikiState,
  ensureGlobalSkeleton,
  type GlobalWikiStateDeps,
} from '../src/global.ts'
import { injectNotice, type PreStepPayload } from '../src/inject.ts'
import { countPages } from '../src/lint.ts'
import {
  assertPagesDirectory,
  isPagesDirectoryName,
  pagePath,
  pagesDirectory,
} from '../src/paths.ts'
import { createWikiSearchIndex } from '../src/search.ts'
import { runWikiSearch } from '../src/search-tool.ts'
import { collectPageSlugs, runWikiLint } from '../src/tool.ts'
import { classifyWritePath, executeWikiWrite, wikiWriteDescription } from '../src/write.ts'
import {
  cleanupTempDirs,
  exists,
  fakeAgent,
  fakeInvocation,
  git,
  gitAvailable,
  initRepo,
  readAt,
  recordingLogger,
  scaffoldGlobalRepo,
  scaffoldWiki,
  tempDir,
  tempGlobalState,
  userMessage,
  wikiConfig,
  writeFileAt,
  writeGlobalIndex,
  writeGlobalPage,
  writeIndex,
  writePage,
} from './support.ts'

const hasGit = gitAvailable()
const api = { withFileLock, writeFileAtomic }
afterAll(cleanupTempDirs)

/** A global repository whose pages live under `concepts/`, and a session outside it. */
async function conceptsWiki(options: { pages?: readonly string[] } = {}) {
  const global = await initRepo()
  await scaffoldGlobalRepo(global, 'concepts')
  const slugs = options.pages ?? ['shared']
  for (const slug of slugs) await writeGlobalPage(global, { slug }, 'concepts')
  await writeGlobalIndex(global, [...slugs])
  const elsewhere = await initRepo()
  const { state, sidecarFile, home } = await tempGlobalState({
    sidecar: { path: global },
    pagesDir: 'concepts',
  })
  const config = wikiConfig({ global: { pagesDir: 'concepts' } })
  return { global, elsewhere, state, sidecarFile, home, config }
}

/** The search index cache for a configuration. */
function makeIndex(config = wikiConfig({ global: { pagesDir: 'concepts' } })) {
  const logger = recordingLogger()
  return { config, logger, index: createWikiSearchIndex({ config, logger }) }
}

describe('global.pagesDir (DESIGN §6.2, §6.4)', () => {
  it('defaults to pages and accepts one non-hidden directory name', () => {
    expect(wikiConfig().global.pagesDir).toBe('pages')
    expect(wikiConfig({ global: { pagesDir: 'concepts' } }).global.pagesDir).toBe('concepts')
    for (const good of ['pages', 'concepts', 'notes', 'concepts-2026']) {
      expect(isPagesDirectoryName(good), good).toBe(true)
    }
  })

  it('refuses a separator, a dot name, an empty value, an absolute path, and a reserved name', () => {
    for (const bad of [
      '..',
      '.',
      '',
      '/abs',
      '/',
      'a/b',
      'a\\b',
      '.hidden',
      'x\u0000y',
      'raw',
      'RAW',
      'index.md',
      'WIKI.md',
    ]) {
      expect(isPagesDirectoryName(bad), bad).toBe(false)
      expect(() => Config({ global: { pagesDir: bad } }), bad).toThrow(/pagesDir/u)
    }
  })

  it('names the directory inside the wiki root, and never outside it', () => {
    expect(pagesDirectory('/repo', 'concepts')).toBe(path.join('/repo', 'concepts'))
    expect(pagePath('/repo', 'alpha', 'concepts')).toBe(path.join('/repo', 'concepts', 'alpha.md'))
    expect(pagesDirectory('/repo')).toBe(path.join('/repo', 'pages'))
    expect(() => pagesDirectory('/repo', '..')).toThrow(/not a usable page directory/u)
    expect(() => assertPagesDirectory('/abs')).toThrow(/not a usable page directory/u)
  })

  it('is carried by the global state and refused when it bypassed the schema', async () => {
    const { state } = await tempGlobalState({ pagesDir: 'concepts' })
    expect(state.pagesDir).toBe('concepts')
    const home = await tempDir()
    const deps = {
      profileRepo: () => '',
      pagesDir: '..',
      logger: recordingLogger(),
      sidecarFile: path.join(home, 'llm-wiki-state', 'repo.json'),
      legacySidecarFile: null,
      dshHome: home,
    } satisfies GlobalWikiStateDeps
    expect(() => createGlobalWikiState(deps)).toThrow(/not a usable page directory/u)
  })
})

describe.skipIf(!hasGit)('the skeleton follows the configured directory (DESIGN §6.4)', () => {
  it('creates concepts/ rather than pages/, keeps index.md, and is idempotent', async () => {
    const repo = await initRepo()
    await writeFileAt(path.join(repo, 'index.md'), '# Mine\n')
    const first = await ensureGlobalSkeleton(
      { repoRoot: repo, source: 'sidecar', needsInit: false },
      { pagesDir: 'concepts' },
    )
    expect(first.created).toContain(path.join(repo, 'concepts'))
    expect(await exists(path.join(repo, 'concepts'))).toBe(true)
    expect(await exists(path.join(repo, 'pages'))).toBe(false)
    expect(await exists(path.join(repo, 'raw'))).toBe(true)
    expect(await readAt(path.join(repo, 'index.md'))).toBe('# Mine\n')
    expect(await exists(path.join(repo, 'WIKI.md'))).toBe(true)
    const second = await ensureGlobalSkeleton(
      { repoRoot: repo, source: 'sidecar', needsInit: false },
      { pagesDir: 'concepts' },
    )
    expect(second.created).toEqual([])
  })
})

describe.skipIf(!hasGit)('the search index and display paths (DESIGN §6.5)', () => {
  it('indexes the global wiki’s concepts/ and returns concepts/<slug>.md', async () => {
    const { global, elsewhere, state } = await conceptsWiki({ pages: ['handbook'] })
    // A stray pages/ tree must not be indexed when the setting names concepts.
    await writeFileAt(path.join(global, 'pages', 'stray.md'), '# Stray\n')
    const { logger, index } = makeIndex()
    const value = await runWikiSearch({
      scope: 'global',
      query: 'handbook',
      logger,
      global: state,
      index,
      agent: fakeAgent({ cwd: elsewhere }),
    })
    expect(value.hits.map(hit => [hit.scope, hit.path, hit.slug])).toEqual([
      ['global', 'concepts/handbook.md', 'handbook'],
    ])
    const stray = await runWikiSearch({
      scope: 'global',
      query: 'stray',
      logger,
      global: state,
      index,
      agent: fakeAgent({ cwd: elsewhere }),
    })
    expect(stray.hits).toEqual([])
    expect(await countPages(global, 'concepts')).toBe(1)
  })

  it('leaves the project wiki on pages/ whatever the global setting is', async () => {
    const project = await initRepo()
    await scaffoldWiki(project)
    await writePage(project, { slug: 'alpha' })
    await writeIndex(project, ['alpha'])
    const { state } = await tempGlobalState()
    const { logger, index } = makeIndex()
    const value = await runWikiSearch({
      cwd: project,
      scope: 'project',
      query: 'alpha',
      logger,
      global: state,
      index,
      agent: fakeAgent({ cwd: project }),
    })
    expect(value.hits[0]?.path).toBe('.dsh/wiki/pages/alpha.md')
    expect(await countPages(path.join(project, '.dsh', 'wiki'))).toBe(1)
  })
})

describe.skipIf(!hasGit)('the lint follows the configured directory (DESIGN §6.6)', () => {
  it('lints concepts/ cleanly and reports issue paths under it', async () => {
    const f = await conceptsWiki({ pages: ['shared'] })
    const logger = recordingLogger()
    const clean = await runWikiLint({
      cwd: f.elsewhere,
      scope: 'global',
      checks: ['links', 'index', 'raw'],
      logger,
      global: f.state,
      agent: fakeAgent({ cwd: f.elsewhere }),
    })
    expect(clean.issues).toEqual([])
    expect(clean.summary).toMatch(/no issues/u)

    await writeFileAt(
      path.join(f.global, 'concepts', 'broken.md'),
      ['---', 'title: broken', '---', '# Broken\n\n[[missing]]\n'].join('\n'),
    )
    await writeFileAt(
      path.join(f.global, 'index.md'),
      '- [[shared]] — about shared\n- [[gone]] — a stale entry\n',
    )
    const value = await runWikiLint({
      cwd: f.elsewhere,
      scope: 'global',
      checks: ['links', 'index', 'raw'],
      logger,
      global: f.state,
      agent: fakeAgent({ cwd: f.elsewhere }),
    })
    expect(value.issues.map(issue => [issue.kind, issue.path])).toEqual([
      ['unresolved-link', 'concepts/broken.md'],
      ['index-stale', 'index.md'],
      ['index-missing', 'concepts/broken.md'],
    ])
    expect(value.issues[1]?.detail).toContain('concepts/gone.md')
  })

  it('resolves [[global:slug]] against concepts/, including the path form', async () => {
    const f = await conceptsWiki({ pages: ['shared'] })
    await scaffoldWiki(f.elsewhere)
    await writePage(f.elsewhere, {
      slug: 'alpha',
      body: '# Alpha\n\nSee [[global:shared]] and [[global:concepts/shared]].\n',
    })
    await writeIndex(f.elsewhere, ['alpha'])
    const slugs = await collectPageSlugs(f.global, recordingLogger(), 'concepts')
    expect([...slugs]).toEqual(['shared'])
    const value = await runWikiLint({
      cwd: f.elsewhere,
      scope: 'project',
      checks: ['links'],
      logger: recordingLogger(),
      global: f.state,
      agent: fakeAgent({ cwd: f.elsewhere }),
    })
    expect(value.issues).toEqual([])
  })

  it('resolves an Obsidian path link ([[concepts/<slug>]]) inside the global wiki', async () => {
    const f = await conceptsWiki({ pages: ['shared'] })
    await writeGlobalPage(
      f.global,
      { slug: 'shared', body: '# Shared\n\nSee [[concepts/other]] and [[concepts/missing]].\n' },
      'concepts',
    )
    await writeGlobalPage(f.global, { slug: 'other' }, 'concepts')
    await writeFileAt(
      path.join(f.global, 'index.md'),
      '- [[concepts/shared|shared]] — about shared\n- [[concepts/other|other]] — about other\n',
    )
    const value = await runWikiLint({
      cwd: f.elsewhere,
      scope: 'global',
      checks: ['links', 'index'],
      logger: recordingLogger(),
      global: f.state,
      agent: fakeAgent({ cwd: f.elsewhere }),
    })
    expect(value.issues.map(issue => [issue.kind, issue.path])).toEqual([
      ['unresolved-link', 'concepts/shared.md'],
    ])
    expect(value.issues[0]?.detail).toContain('concepts/missing')
  })

  it('resolves a path-form link in a project wiki on the default pages/', async () => {
    const project = await initRepo()
    await scaffoldWiki(project)
    await writePage(project, { slug: 'alpha', body: '# Alpha\n\nSee [[pages/beta]] and [[pages/missing]].\n' })
    await writePage(project, { slug: 'beta' })
    await writeIndex(project, ['alpha', 'beta'])
    const { state } = await tempGlobalState()
    const value = await runWikiLint({
      cwd: project,
      scope: 'project',
      checks: ['links', 'index'],
      logger: recordingLogger(),
      global: state,
      agent: fakeAgent({ cwd: project }),
    })
    // Both wikis accept the path form; only the target that exists resolves.
    expect(value.issues.map(issue => [issue.kind, issue.path])).toEqual([
      ['unresolved-link', '.dsh/wiki/pages/alpha.md'],
    ])
    expect(value.issues[0]?.detail).toContain('[[pages/missing]]')
  })
})

describe('wiki_write follows the configured directory (DESIGN §6.4)', () => {
  it('accepts concepts/<slug>.md and refuses pages/<slug>.md under that setting', () => {
    expect(classifyWritePath('concepts/handbook.md', 'concepts')).toEqual({
      kind: 'page',
      relative: 'concepts/handbook.md',
    })
    for (const bad of ['pages/handbook.md', 'concepts/sub/handbook.md']) {
      expect(classifyWritePath(bad, 'concepts'), bad).toMatchObject({
        error: expect.stringMatching(/concepts/u) as string,
      })
    }
    expect(classifyWritePath('concepts/.hidden.md', 'concepts')).toMatchObject({
      error: expect.any(String) as string,
    })
    expect(classifyWritePath('index.md', 'concepts')).toEqual({ kind: 'index', relative: 'index.md' })
    expect(classifyWritePath('WIKI.md', 'concepts')).toEqual({ kind: 'charter', relative: 'WIKI.md' })
    expect(classifyWritePath('raw/database/2026-10-19-pg.md', 'concepts')).toMatchObject({ kind: 'raw' })
  })

  it('describes the configured directory to the model', () => {
    expect(wikiWriteDescription('concepts')).toContain('concepts/<slug>.md')
    expect(wikiWriteDescription('concepts')).not.toContain('must be one of: pages/')
  })

  it.skipIf(!hasGit)('writes concepts/alpha.md and index.md, and creates no pages/', async () => {
    const f = await conceptsWiki({ pages: [] })
    const logger = recordingLogger()
    const write = async (args: Record<string, unknown>) =>
      await executeWikiWrite(args as never, fakeAgent({ cwd: f.elsewhere }), {
        config: f.config,
        logger,
        global: f.state,
        api,
      })
    const page = await write({ path: 'concepts/alpha.md', content: '# Alpha\n' })
    expect(page).toEqual({ path: 'concepts/alpha.md', bytes: 8, created: true, redacted: [] })
    expect(await readAt(path.join(f.global, 'concepts', 'alpha.md'))).toBe('# Alpha\n')
    expect(await exists(path.join(f.global, 'pages'))).toBe(false)
    const index = await write({ path: 'index.md', content: '- [[alpha]] — about alpha\n' })
    expect(index.created).toBe(false)
    expect(await readAt(path.join(f.global, 'index.md'))).toContain('[[alpha]]')
  })
})

describe.skipIf(!hasGit)('/wiki status and /wiki commit (DESIGN §6.4, §6.6)', () => {
  /** Run one `/wiki` line against a concepts global wiki. */
  async function run(line: string, f: Awaited<ReturnType<typeof conceptsWiki>>) {
    const { logger, index } = makeIndex(f.config)
    return await runWikiCommand(fakeInvocation(fakeAgent({ cwd: f.elsewhere }), line), {
      config: f.config,
      logger,
      global: f.state,
      search: index,
    })
  }

  it('shows the configured page directory and counts its pages', async () => {
    const f = await conceptsWiki({ pages: ['one', 'two'] })
    const result = await run('status', f)
    expect(result.kind).toBe('success')
    const text = result.text ?? ''
    expect(text).toContain('page directory: concepts/')
    expect(text).toContain('pages: 2')
  })

  it('commits concepts/ instead of pages/, and never creates pages/', async () => {
    const f = await conceptsWiki({ pages: ['alpha'] })
    git(f.global, ['add', '--', ...commitPathspecs('concepts')])
    git(f.global, ['commit', '--quiet', '-m', 'init wiki'])
    await writeFileAt(path.join(f.global, 'concepts', 'alpha.md'), '# Alpha 2\n')
    const result = await run('commit updated', f)
    expect(result.kind).toBe('success')
    const committed = git(f.global, ['show', '--name-only', '--format=', 'HEAD'])
      .trim()
      .split('\n')
      .filter(Boolean)
    expect(committed).toEqual(['concepts/alpha.md'])
    expect(await exists(path.join(f.global, 'pages'))).toBe(false)
  })

  it('names the conventional pathspecs by default', () => {
    expect(commitPathspecs()).toEqual(['WIKI.md', 'index.md', 'pages', 'raw'])
    expect(commitPathspecs('concepts')).toEqual(['WIKI.md', 'index.md', 'concepts', 'raw'])
  })
})

describe.skipIf(!hasGit)('the notice counts the configured directory (DESIGN §6.6)', () => {
  it('adds the global count from concepts/', async () => {
    const project = await initRepo()
    await scaffoldWiki(project)
    const global = await initRepo()
    await scaffoldGlobalRepo(global, 'concepts')
    await writeGlobalPage(global, { slug: 'one' }, 'concepts')
    await writeGlobalPage(global, { slug: 'two' }, 'concepts')
    const { state } = await tempGlobalState({
      sidecar: { path: global },
      pagesDir: 'concepts',
    })
    const claimed: UserMessage = userMessage('hello')
    const payload: PreStepPayload = {
      agent: fakeAgent({ cwd: project }),
      messages: [claimed],
      turn: 1,
      step: 2,
      signal: new AbortController().signal,
    }
    const result = await injectNotice(
      payload,
      { kind: 'enter', messages: [claimed] },
      { config: wikiConfig(), logger: recordingLogger(), global: state },
    )
    if (result.kind !== 'enter') throw new Error('unreachable')
    const summary = (result.messages[1]?.source as { summary?: string }).summary ?? ''
    expect(summary).toMatch(/global 2 pages/u)
  })
})
