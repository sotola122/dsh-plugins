/**
 * `search-tool.ts` suite: `wiki_search`'s scope resolution, its rendering, and
 * its tool definition.
 *
 * `search.spec.ts` owns the index itself; this suite owns the layer above it —
 * how a call resolves the two wikis (a missing cwd, a cwd without a wiki, an
 * absent global wiki), how the merged list is ordered, what the model reads,
 * and what the registered tool does with the arguments and with a failure.
 * @module @anago-harness/llm-wiki/tests/search-tool.spec
 */
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { GlobalWikiState } from '../src/global.ts'
import {
  createWikiSearchIndex,
  MAX_SEARCH_HITS,
  type IndexHit,
  type IndexedPage,
  type SearchHit,
  type WikiIndex,
  type WikiScope,
  type WikiSearchIndex,
} from '../src/search.ts'
import {
  createWikiSearchTool,
  mergeHits,
  renderWikiSearchResult,
  runWikiSearch,
  WIKI_SEARCH_PREAMBLE,
  WIKI_SEARCH_TOOL_NAME,
  type WikiSearchValue,
} from '../src/search-tool.ts'
import {
  cleanupTempDirs,
  fakeAgent,
  fakeExec,
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
} from './support.ts'

const hasGit = gitAvailable()
afterAll(cleanupTempDirs)

/** One page as the index holds it; only the fields a merge or a hit reads matter. */
function pageOf(slug: string, scope: WikiScope = 'project'): IndexedPage {
  return {
    slug,
    file: `/wiki/pages/${slug}.md`,
    display: `${scope === 'project' ? '.dsh/wiki/' : ''}pages/${slug}.md`,
    mtimeMs: 0,
    size: 0,
    title: slug,
    aliases: [],
    tags: [],
    body: '',
    terms: new Map(),
    length: 0,
    postingBytes: 0,
  }
}

/** One ranked page, before the §9 scan. */
function hitOf(scope: WikiScope, slug: string, score: number): IndexHit {
  return { scope, page: pageOf(slug, scope), score }
}

/** An empty index record, for the stub that only records how it was opened. */
function emptyIndex(scope: WikiScope, root: string): WikiIndex {
  return {
    scope,
    root,
    displayPrefix: scope === 'project' ? '.dsh/wiki/' : '',
    pages: new Map(),
    documentFrequency: new Map(),
    totalLength: 0,
    postingBytes: 0,
    truncated: false,
    builtAt: 0,
    lastScanAt: 0,
  }
}

/** Write one page with the frontmatter fields a case wants to control. */
async function writePageFile(
  wikiRoot: string,
  options: { slug: string; title?: string; tags?: readonly string[]; body?: string },
): Promise<void> {
  const lines = [
    '---',
    `title: ${options.title ?? options.slug}`,
    ...(options.tags === undefined ? [] : [`tags: [${options.tags.join(', ')}]`]),
    '---',
    options.body ?? `# ${options.slug}\n\nBody of ${options.slug}.\n`,
  ]
  await writeFileAt(path.join(wikiRoot, 'pages', `${options.slug}.md`), lines.join('\n'))
}

/** A checkout root holding a project wiki with a `pages/` directory. */
async function projectWiki(): Promise<string> {
  const root = await initRepo()
  await scaffoldWiki(root)
  return root
}

/** A search cache built the way the plugin builds it. */
function makeIndex(): { index: WikiSearchIndex; logger: ReturnType<typeof recordingLogger> } {
  const logger = recordingLogger()
  return { index: createWikiSearchIndex({ config: wikiConfig(), logger }), logger }
}

describe('mergeHits (DESIGN §6.4, §6.5)', () => {
  it('orders by score, then the project wiki, then the slug', () => {
    const merged = mergeHits(
      [hitOf('global', 'beta', 2), hitOf('global', 'alpha', 1), hitOf('project', 'gamma', 1)],
      MAX_SEARCH_HITS,
    )
    expect(merged.map(hit => [hit.scope, hit.page.slug])).toEqual([
      ['global', 'beta'],
      ['project', 'gamma'],
      ['global', 'alpha'],
    ])
  })

  it('breaks a tie inside one wiki by slug, whatever order it was handed', () => {
    const merged = mergeHits([hitOf('project', 'beta', 1), hitOf('project', 'alpha', 1)], MAX_SEARCH_HITS)
    expect(merged.map(hit => hit.page.slug)).toEqual(['alpha', 'beta'])
  })

  it('treats two entries for one page as equal and keeps their order', () => {
    const first = hitOf('project', 'alpha', 1)
    const second = hitOf('project', 'alpha', 1)
    expect(mergeHits([first, second], MAX_SEARCH_HITS)).toEqual([first, second])
  })

  it('keeps at most eight hits and clamps the limit', () => {
    const many = Array.from({ length: 10 }, (_, number) => hitOf('project', `page-${String(number)}`, 10 - number))
    expect(mergeHits(many, 100)).toHaveLength(MAX_SEARCH_HITS)
    expect(mergeHits(many, 2)).toHaveLength(2)
    expect(mergeHits(many, -1)).toEqual([])
  })
})

describe('renderWikiSearchResult (DESIGN §6.5, §9)', () => {
  it('names the limit when the returned list is full', () => {
    const hit: SearchHit = { scope: 'global', slug: 'handbook', path: 'pages/handbook.md', score: 0.5 }
    const text = renderWikiSearchResult({ query: 'handbook', limit: 1 }, { hits: [hit], truncated: false })
    expect(text).toContain('1 hit(s), best first (limit 1):')
  })

  it('omits a title, a tag list, and a snippet the scan refused', () => {
    const hit: SearchHit = { scope: 'project', slug: 'alpha', path: '.dsh/wiki/pages/alpha.md', score: 1 }
    const text = renderWikiSearchResult({ query: 'alpha' }, { hits: [hit], truncated: false })
    const line = text.split('\n').find(entry => entry.startsWith('1. '))
    expect(line).toBe('1. [project] .dsh/wiki/pages/alpha.md score 1.000')
    expect(text).not.toContain('(tags:')
  })

  it('renders the title, the tags, and a one-line snippet', () => {
    const hit: SearchHit = {
      scope: 'global',
      slug: 'handbook',
      path: 'pages/handbook.md',
      title: 'Handbook',
      tags: ['ops', 'db'],
      score: 0.5,
      snippet: 'a  snippet\n  here',
    }
    const text = renderWikiSearchResult({ query: 'handbook' }, { hits: [hit], truncated: false })
    expect(text).toContain('1. [global] pages/handbook.md — "Handbook" (tags: ops, db) score 0.500')
    expect(text).toContain('   a snippet here')
  })
})

describe('runWikiSearch scope notes (DESIGN §6.5)', () => {
  it('notes a session that recorded no working directory instead of failing', async () => {
    const { index, logger } = makeIndex()
    const { state } = await tempGlobalState()
    const value = await runWikiSearch({ scope: 'project', query: 'alpha', logger, global: state, index })
    expect(value).toEqual({ hits: [], truncated: false })
    expect(logger.debugLines.join('\n')).toContain(
      'wiki_search skipped project: the session recorded no working directory',
    )
  })

  it('notes a working directory that holds no wiki', async () => {
    const root = await tempDir('dsh-search-nowhere-')
    const { index, logger } = makeIndex()
    const { state } = await tempGlobalState()
    const value = await runWikiSearch({ cwd: root, scope: 'project', query: 'alpha', logger, global: state, index })
    expect(value).toEqual({ hits: [], truncated: false })
    expect(logger.debugLines.join('\n')).toContain('wiki_search skipped project:')
  })

  it.skipIf(!hasGit)('hands the cancellation signal to the inspection and to each index', async () => {
    const root = await projectWiki()
    const global = await initRepo()
    await scaffoldGlobalRepo(global)
    const { state } = await tempGlobalState({ sidecar: { path: global } })
    const opened: { scope: WikiScope; signal: AbortSignal | undefined }[] = []
    const index: WikiSearchIndex = {
      ensure: async (scope, indexRoot, _prefix, options) => {
        opened.push({ scope, signal: options?.signal })
        return emptyIndex(scope, indexRoot)
      },
      state: () => null,
      invalidate: () => {},
    }
    const controller = new AbortController()
    const value = await runWikiSearch({
      cwd: root,
      scope: 'all',
      query: 'alpha',
      logger: recordingLogger(),
      global: state,
      index,
      agent: fakeAgent({ cwd: root }),
      signal: controller.signal,
    })
    expect(value).toEqual({ hits: [], truncated: false })
    expect(opened.map(entry => entry.scope)).toEqual(['project', 'global'])
    expect(opened.every(entry => entry.signal === controller.signal)).toBe(true)
  })
})

describe.skipIf(!hasGit)('the wiki_search tool (DESIGN §6.5)', () => {
  it('runs a call carrying every argument, and renders the value', async () => {
    const root = await projectWiki()
    const wiki = wikiDir(root)
    await writePageFile(wiki, { slug: 'alpha', title: 'Alpha', tags: ['database'], body: 'alpha body' })
    await writePageFile(wiki, { slug: 'beta', title: 'Alpha', tags: ['ops'], body: 'alpha body' })
    const { state } = await tempGlobalState()
    const logger = recordingLogger()
    const config = wikiConfig()
    const index = createWikiSearchIndex({ config, logger })
    const tool = createWikiSearchTool({ config, logger, global: state, index })
    expect(tool.name).toBe(WIKI_SEARCH_TOOL_NAME)

    const value = (await tool.execute(
      { query: 'alpha', scope: 'project', tags: ['database'], limit: 1 },
      fakeExec(fakeAgent({ cwd: root }), undefined, WIKI_SEARCH_TOOL_NAME),
    )) as WikiSearchValue
    expect(value.hits.map(hit => [hit.scope, hit.slug, hit.tags])).toEqual([['project', 'alpha', ['database']]])

    const content = tool.output.render({ query: 'alpha', limit: 1 }, value as never)
    expect(content).toHaveLength(1)
    expect(content[0]).toMatchObject({ type: 'text' })
    const text = JSON.stringify(content)
    expect(text).toContain(WIKI_SEARCH_PREAMBLE)
    expect(text).toContain('[project] .dsh/wiki/pages/alpha.md')
  })

  it('runs without an agent and with no scope, tags, or limit', async () => {
    const root = await projectWiki()
    await writePageFile(wikiDir(root), { slug: 'alpha', title: 'Alpha' })
    const { state } = await tempGlobalState()
    const logger = recordingLogger()
    const config = wikiConfig()
    const index = createWikiSearchIndex({ config, logger })
    const tool = createWikiSearchTool({ config, logger, global: state, index })

    const value = (await tool.execute(
      { query: 'alpha' },
      fakeExec(undefined, undefined, WIKI_SEARCH_TOOL_NAME),
    )) as WikiSearchValue
    // `scope` defaulted to `all`, so both wikis were consulted and both were
    // skipped: the call has no agent, so it has neither a cwd nor a global wiki.
    expect(value).toEqual({ hits: [], truncated: false })
    const noted = logger.debugLines.join('\n')
    expect(noted).toContain('wiki_search skipped project: the session recorded no working directory')
    expect(noted).toContain('wiki_search skipped global')

    const text = JSON.stringify(tool.output.render({ query: 'alpha' }, value as never))
    expect(text).toContain('No page matched')
  })

  it('logs a failed search and rethrows it', async () => {
    const logger = recordingLogger()
    const config = wikiConfig()
    const index = createWikiSearchIndex({ config, logger })
    const { state } = await tempGlobalState()
    const failing: GlobalWikiState = {
      ...state,
      forAgent: async () => {
        throw new Error('the global wiki could not be resolved')
      },
    }
    const tool = createWikiSearchTool({ config, logger, global: failing, index })
    await expect(
      tool.execute({ query: 'alpha', scope: 'global' }, fakeExec(fakeAgent({}), undefined, WIKI_SEARCH_TOOL_NAME)),
    ).rejects.toThrow(/the global wiki could not be resolved/u)
    expect(logger.debugLines.join('\n')).toContain('the global wiki could not be resolved')
  })
})
