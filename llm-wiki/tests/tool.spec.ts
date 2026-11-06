/**
 * `wiki_lint`'s reporting edges (DESIGN §6.5, §6.6): the page-directory listing
 * that feeds `[[global:slug]]`, the truncated-index warning for the global
 * wiki, the 50-issue cut, and the tool definition's own render and execute
 * hooks.
 *
 * The checks themselves and the tool's happy paths live in `lint.spec.ts`; this
 * suite covers the branches that need a directory git does not produce, a tiny
 * index cap, or a call the schema accepts but the body refuses.
 * @module @anago-harness/llm-wiki/tests/tool.spec
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MAX_LINT_ISSUES } from '../src/lint.ts'
import { createWikiSearchIndex } from '../src/search.ts'
import {
  collectPageSlugs,
  createWikiLintTool,
  executeWikiLint,
  runWikiLint,
} from '../src/tool.ts'
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
  writeGlobalIndex,
  writeGlobalPage,
  writeIndex,
  writePage,
} from './support.ts'

const hasGit = gitAvailable()

afterAll(cleanupTempDirs)

describe('collectPageSlugs (DESIGN §6.6)', () => {
  it('lists the page files and skips hidden and non-page entries', async () => {
    const root = await tempDir('dsh-wiki-slugs-')
    await mkdir(path.join(root, 'pages'), { recursive: true })
    await writeFileAt(path.join(root, 'pages', 'alpha.md'), '# Alpha\n')
    await writeFileAt(path.join(root, 'pages', 'beta.md'), '# Beta\n')
    await writeFileAt(path.join(root, 'pages', '.hidden.md'), '# Hidden\n')
    await writeFileAt(path.join(root, 'pages', 'notes.txt'), 'not a page\n')
    const logger = recordingLogger()
    const slugs = await collectPageSlugs(root, logger)
    expect([...slugs].sort()).toEqual(['alpha', 'beta'])
    expect(logger.warnings).toEqual([])
  })

  it('treats a page directory that is not a directory as no pages, and says why', async () => {
    const root = await tempDir('dsh-wiki-slugs-file-')
    await writeFileAt(path.join(root, 'pages'), 'not a directory\n')
    const logger = recordingLogger()
    const slugs = await collectPageSlugs(root, logger)
    expect(slugs.size).toBe(0)
    expect(logger.warnings.join('\n')).toMatch(/the pages of .* could not be listed/u)
  })

  it('treats a missing page directory as no pages, silently', async () => {
    const root = await tempDir('dsh-wiki-slugs-missing-')
    const logger = recordingLogger()
    const slugs = await collectPageSlugs(root, logger)
    expect(slugs.size).toBe(0)
    expect(logger.warnings).toEqual([])
  })
})

describe.skipIf(!hasGit)('runWikiLint reporting (DESIGN §6.5, §6.6)', () => {
  it('warns about a truncated global index in the global scope', async () => {
    const project = await initRepo()
    await scaffoldWiki(project)
    const global = await initRepo()
    await scaffoldGlobalRepo(global)
    await writeGlobalPage(global, { slug: 'one' })
    await writeGlobalPage(global, { slug: 'two' })
    await writeGlobalIndex(global, ['one', 'two'])
    const config = wikiConfig({ search: { maxPages: 1 } })
    const logger = recordingLogger()
    const index = createWikiSearchIndex({ config, logger })
    await index.ensure('global', global, '')
    const { state } = await tempGlobalState({ sidecar: { path: global } })
    const value = await runWikiLint({
      cwd: project,
      scope: 'global',
      checks: ['links'],
      logger,
      global: state,
      agent: fakeAgent({ cwd: project }),
      search: index,
    })
    expect(value.summary).toContain(`global wiki (${global})`)
    expect(value.summary).toContain('the search index is truncated')
  })

  it('says how many findings across both wikis were cut at the issue bound', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const projectLinks = Array.from(
      { length: 40 },
      (_, index) => `[[missing-project-${String(index)}]]`,
    ).join(' ')
    await writePage(root, { slug: 'alpha', body: `${projectLinks}\n` })
    await writeIndex(root, ['alpha'])
    const global = await initRepo()
    await scaffoldGlobalRepo(global)
    const globalLinks = Array.from(
      { length: 20 },
      (_, index) => `[[missing-global-${String(index)}]]`,
    ).join(' ')
    await writeGlobalPage(global, { slug: 'shared', body: `${globalLinks}\n` })
    await writeGlobalIndex(global, ['shared'])
    const { state } = await tempGlobalState({ sidecar: { path: global } })
    const value = await runWikiLint({
      cwd: root,
      scope: 'all',
      checks: ['links'],
      logger: recordingLogger(),
      global: state,
      agent: fakeAgent({ cwd: root }),
    })
    expect(value.issues).toHaveLength(MAX_LINT_ISSUES)
    expect(value.summary).toContain(
      `60 issue(s) in total, showing the first ${String(MAX_LINT_ISSUES)}`,
    )
  })
})

describe.skipIf(!hasGit)('executeWikiLint (DESIGN §6.6)', () => {
  it('reads the search index it was handed so a truncated project index is reported', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha' })
    await writePage(root, { slug: 'beta' })
    await writeIndex(root, ['alpha', 'beta'])
    const config = wikiConfig({ search: { maxPages: 1 } })
    const logger = recordingLogger()
    const index = createWikiSearchIndex({ config, logger })
    await index.ensure('project', wikiDir(root), '.dsh/wiki/')
    expect(index.state(wikiDir(root))?.truncated).toBe(true)
    const { state } = await tempGlobalState()
    const value = (await executeWikiLint({ scope: 'project' }, fakeExec(fakeAgent({ cwd: root })), {
      logger,
      global: state,
      search: index,
      checks: ['links'],
    })) as { readonly summary: string }
    expect(value.summary).toContain('the search index is truncated')
  })
})

describe.skipIf(!hasGit)('createWikiLintTool (DESIGN §6.6)', () => {
  it('renders the accepted value and runs the same lint the command runs', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha', body: 'See [[missing]].\n' })
    await writeIndex(root, ['alpha'])
    const logger = recordingLogger()
    const { state } = await tempGlobalState()
    const tool = createWikiLintTool({ logger, global: state, checks: ['links'] })
    const rendered = tool.output.render({}, { issues: [], summary: 'wiki_lint (project): clean' })
    expect(rendered).toEqual([
      {
        type: 'text',
        text: 'wiki_lint (project): clean\nNo issues found by the checks that ran.',
      },
    ])
    const value = (await tool.execute(
      { scope: 'project' },
      fakeExec(fakeAgent({ cwd: root })),
    )) as { readonly issues: readonly { readonly kind: string }[]; readonly summary: string }
    expect(value.issues.map(issue => issue.kind)).toEqual(['unresolved-link'])
    expect(value.summary).toContain('.dsh/wiki/: 1 page(s)')
  })

  it('reports a refused argument list and rethrows it', async () => {
    const logger = recordingLogger()
    const { state } = await tempGlobalState()
    const tool = createWikiLintTool({ logger, global: state })
    await expect(
      tool.execute({ checks: [] }, fakeExec(fakeAgent({}))),
    ).rejects.toThrow(/`checks` is empty/u)
    expect(logger.debugLines.join('\n')).toMatch(/`checks` is empty/u)
  })
})
