/**
 * `wiki_lint` suite (DESIGN §6.6, §10): the three checks one by one, the sixth
 * revision's missing `ambiguous` finding, the 50-issue bound, and the whole
 * ingest → lint → fix round trip performed the way the skill describes it.
 *
 * The checks read a real directory tree, so the suite skips without `git` only
 * for the cases that resolve a root through `wiki_lint` itself; `lintWiki` is
 * exercised directly with a `LintTarget`.
 * @module @anago-harness/llm-wiki/tests/lint.spec
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { lintWiki, MAX_LINT_ISSUES, type LintIssue } from '../src/lint.ts'
import { sha256Hex } from '@anago-harness/knowledge-common'
import {
  cleanupTempDirs,
  gitAvailable,
  initRepo,
  renderRawSource,
  scaffoldWiki,
  tempDir,
  wikiDir,
  writeFileAt,
  writeGitignore,
  writePage,
  writeIndex,
  writeRawSource,
  writeSettings,
} from './support.ts'
import { executeWikiLint, type WikiToolDeps } from '../src/tool.ts'
import type { GlobalWikiState } from '../src/global.ts'
import {
  fakeExec,
  recordingLogger,
  scaffoldGlobalRepo,
  tempGlobalState,
  writeGlobalIndex,
  writeGlobalPage,
  writeGlobalRawSource,
} from './support.ts'

/** A state whose global wiki is off, shared by the suites that do not need one. */
let offState: GlobalWikiState | undefined

/** Deps for `executeWikiLint` with no global wiki designated. */
async function depsWithNoGlobal(logger = recordingLogger()): Promise<WikiToolDeps> {
  offState ??= (await tempGlobalState()).state
  return { logger, global: offState }
}

const hasGit = gitAvailable()

afterAll(cleanupTempDirs)

/** A `LintTarget` for one checkout root. */
function target(root: string) {
  return { scope: 'project' as const, wikiRoot: wikiDir(root), displayPrefix: '.dsh/wiki/' }
}

/** Turn issues into `kind path` strings for readable expectations. */
function kinds(issues: readonly LintIssue[]): string[] {
  return issues.map(issue => issue.kind)
}

/** A scaffold with one page, its index entry, and one clean raw source. */
async function healthyWiki(): Promise<string> {
  const root = await tempDir('dsh-wiki-healthy-')
  await scaffoldWiki(root)
  await writePage(root, { slug: 'alpha', body: '# Alpha\n\nSee [[beta]].\n' })
  await writePage(root, { slug: 'beta', body: '# Beta\n\nSee [[alpha]] and [[alpha|the first page]].\n' })
  await writeIndex(root, ['alpha', 'beta'])
  await writeRawSource(root, { relative: 'raw/topic/2026-10-19-source.md', body: 'the source text\n' })
  return root
}

describe('a healthy wiki', () => {
  it('reports nothing for all three checks', async () => {
    const root = await healthyWiki()
    const result = await lintWiki(target(root), { checks: ['links', 'index', 'raw'] })
    expect(result.issues).toEqual([])
    expect(result.summary).toMatch(/2 page\(s\)/u)
    expect(result.summary).toMatch(/no issues/u)
  })

  it('runs only the requested checks', async () => {
    const root = await healthyWiki()
    await writePage(root, { slug: 'orphan', body: '# Orphan\n\n[[nowhere]]\n' })
    const links = await lintWiki(target(root), { checks: ['links'] })
    expect(kinds(links.issues)).toEqual(['unresolved-link'])
    const index = await lintWiki(target(root), { checks: ['index'] })
    expect(kinds(index.issues)).toEqual(['index-missing'])
  })
})

describe('links check (DESIGN §6.6)', () => {
  it('reports an unresolved [[slug]] and stays quiet about a resolved one', async () => {
    const root = await healthyWiki()
    await writePage(root, { slug: 'gamma', body: '# Gamma\n\n[[beta]] and [[missing-page]] and [[beta#section]].\n' })
    const result = await lintWiki(target(root), { checks: ['links'] })
    expect(kinds(result.issues)).toEqual(['unresolved-link'])
    expect(result.issues[0]?.detail).toMatch(/\[\[missing-page\]\]/u)
    expect(result.issues[0]?.path).toBe('.dsh/wiki/pages/gamma.md')
  })

  it('resolves an unqualified link inside the wiki that contains it, with no ambiguous finding', async () => {
    // Both wikis may hold `shared`; the project page links to its own.
    const root = await healthyWiki()
    await writePage(root, { slug: 'shared', body: '# Shared (project)\n' })
    await writeIndex(root, ['alpha', 'beta', 'shared'])
    const result = await lintWiki(target(root), { checks: ['links'] })
    expect(result.issues).toEqual([])
    expect(kinds(result.issues)).not.toContain('ambiguous')
  })

  it('reports [[global:slug]] as unresolved while no global wiki exists', async () => {
    const root = await healthyWiki()
    await writePage(root, { slug: 'delta', body: '# Delta\n\n[[global:handbook]]\n' })
    const withoutGlobal = await lintWiki(target(root), { checks: ['links'] })
    expect(kinds(withoutGlobal.issues)).toEqual(['unresolved-global-link'])
    expect(withoutGlobal.issues[0]?.detail).toMatch(/no global wiki is configured/u)
    const withGlobal = await lintWiki(target(root), {
      checks: ['links'],
      globalEnabled: true,
      globalSlugs: new Set(['handbook']),
    })
    expect(withGlobal.issues).toEqual([])
    const wrongSlug = await lintWiki(target(root), {
      checks: ['links'],
      globalEnabled: true,
      globalSlugs: new Set(['other']),
    })
    expect(kinds(wrongSlug.issues)).toEqual(['unresolved-global-link'])
    expect(wrongSlug.issues[0]?.detail).toMatch(/global wiki has no page/u)
  })
})

/**
 * The referenceable things of a wiki are not only its pages (DESIGN §6.6): an
 * Obsidian-style vault links the catalogue (`[[index#C++]]`) and its raw
 * sources (`[[mcu-rf-update-2026-09-14]]`, `[[raw/articles/X|X]]`) with the same
 * syntax, and C++ pages spell the `[[nodiscard]]` attribute that way too.
 */
describe('link resolution (DESIGN §6.6)', () => {
  it('resolves a page slug, its path form, the index, and raw names and paths', async () => {
    const root = await healthyWiki()
    await writeRawSource(root, { relative: 'raw/articles/ESP32-S31.md', body: 'the source\n' })
    await writePage(root, {
      slug: 'links',
      body: [
        '# Links',
        '',
        '[[alpha]] [[pages/alpha]] [[alpha#section|Alpha]]',
        '[[index]] [[index#C++|C++]]',
        '[[2026-10-19-source]] [[raw/topic/2026-10-19-source]] [[raw/topic/2026-10-19-source.md]]',
        '[[ESP32-S31]] [[raw/articles/ESP32-S31|ESP32-S31]] [[raw/articles/ESP32-S31.md]]',
        '',
      ].join('\n'),
    })
    await writeIndex(root, ['alpha', 'beta', 'links'])
    const result = await lintWiki(target(root), { checks: ['links'] })
    expect(result.issues).toEqual([])
  })

  it('matches targets case-sensitively, like a file name', async () => {
    const root = await tempDir('dsh-wiki-case-')
    await scaffoldWiki(root)
    await writePage(root, { slug: 'stm32', body: '# STM32\n' })
    await writePage(root, { slug: 'esp32-c6', body: '# ESP32-C6\n' })
    await writePage(root, {
      slug: 'alpha',
      body: '# Alpha\n\n[[stm32]] [[esp32-c6]] [[STM32]] [[ESP32-C6]]\n',
    })
    await writeIndex(root, ['alpha', 'esp32-c6', 'stm32'])
    const result = await lintWiki(target(root), { checks: ['links'] })
    expect(kinds(result.issues)).toEqual(['unresolved-link', 'unresolved-link'])
    expect(result.issues.map(issue => issue.detail)).toEqual([
      expect.stringContaining('[[STM32]]'),
      expect.stringContaining('[[ESP32-C6]]'),
    ])
  })

  it('ignores [[...]] inside inline code and fenced blocks', async () => {
    const root = await tempDir('dsh-wiki-code-')
    await scaffoldWiki(root)
    await writePage(root, {
      slug: 'cpp17',
      body: [
        '# C++17',
        '',
        '## `[[nodiscard]]`',
        '',
        'The `[[nodiscard]]` attribute, a double span ``[[nodiscard]]``, and a triple span ```[[nodiscard]]```.',
        '',
        '```cpp',
        '[[nodiscard]] Status start_peripheral();',
        '```',
        '',
        '~~~text',
        '[[tilde-missing]]',
        '~~~',
        '',
        '   ```',
        '   [[indented-missing]]',
        '   ```',
        '',
        'Outside the code: [[missing-outside]].',
        '',
      ].join('\n'),
    })
    await writeIndex(root, ['cpp17'])
    const result = await lintWiki(target(root), { checks: ['links'] })
    expect(kinds(result.issues)).toEqual(['unresolved-link'])
    expect(result.issues[0]?.detail).toContain('[[missing-outside]]')
  })

  it('closes a fenced block in a CRLF document', async () => {
    const root = await tempDir('dsh-wiki-crlf-')
    await scaffoldWiki(root)
    await writePage(root, {
      slug: 'crlf',
      body: ['# CRLF', '', '```cpp', '[[inside]]', '```', '', 'Outside: [[outside]].', ''].join('\r\n'),
    })
    await writeIndex(root, ['crlf'])
    const result = await lintWiki(target(root), { checks: ['links'] })
    expect(kinds(result.issues)).toEqual(['unresolved-link'])
    expect(result.issues[0]?.detail).toContain('[[outside]]')
  })

  it('does not treat an index entry for a raw source or the index as stale', async () => {
    const root = await healthyWiki()
    await writeFileAt(
      path.join(wikiDir(root), 'index.md'),
      [
        '- [[alpha]] — first',
        '- [[pages/beta]] — path form',
        '- [[2026-10-19-source]] — a raw source',
        '- [[raw/topic/2026-10-19-source]] — the same source by path',
        '- [[index#C++|C++]] — the catalogue itself',
        '- `[[ghost]]` — an example in code',
        '- [[also-ghost]] — resolved by nothing',
        '',
      ].join('\n'),
    )
    const result = await lintWiki(target(root), { checks: ['index'] })
    expect(kinds(result.issues)).toEqual(['index-stale'])
    expect(result.issues[0]?.detail).toContain('[[also-ghost]]')
  })
})

describe('index check (DESIGN §6.6)', () => {
  it('reports a page missing from index.md, a stale entry, and a duplicate', async () => {
    const root = await tempDir('dsh-wiki-index-')
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha' })
    await writePage(root, { slug: 'beta' })
    await writeFileAt(
      path.join(wikiDir(root), 'index.md'),
      ['- [[alpha]] — first', '- [[alpha]] — again', '- [[gone]] — stale', ''].join('\n'),
    )
    const result = await lintWiki(target(root), { checks: ['index'] })
    expect(kinds(result.issues).sort()).toEqual(['index-duplicate', 'index-missing', 'index-stale'])
    const duplicate = result.issues.find(issue => issue.kind === 'index-duplicate')
    expect(duplicate?.detail).toMatch(/lines 1, 2/u)
    const missing = result.issues.find(issue => issue.kind === 'index-missing')
    expect(missing?.detail).toMatch(/\[\[beta\]\]/u)
  })

  it('ignores a [[global:slug]] line in index.md', async () => {
    const root = await tempDir('dsh-wiki-index-global-')
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha' })
    await writeFileAt(
      path.join(wikiDir(root), 'index.md'),
      ['- [[alpha]] — first', '- [[global:handbook]] — elsewhere', ''].join('\n'),
    )
    const result = await lintWiki(target(root), { checks: ['index'] })
    expect(result.issues).toEqual([])
  })
})

describe('raw check (DESIGN §6.6)', () => {
  it('reports a body that no longer matches its digest', async () => {
    const root = await tempDir('dsh-wiki-raw-')
    await scaffoldWiki(root)
    const body = 'the source text\n'
    await writeRawSource(root, { relative: 'raw/topic/2026-10-19-source.md', body, digest: sha256Hex('other') })
    const result = await lintWiki(target(root), { checks: ['raw'] })
    expect(kinds(result.issues)).toEqual(['raw-digest-mismatch'])
    expect(result.issues[0]?.detail).toMatch(/immutable/u)
  })

  it('reports a missing or malformed digest', async () => {
    const root = await tempDir('dsh-wiki-raw-missing-')
    await scaffoldWiki(root)
    await writeFileAt(
      path.join(wikiDir(root), 'raw', 'topic', '2026-10-19-a.md'),
      '---\nsource_url: https://example.com\n---\nthe source text\n',
    )
    await writeFileAt(
      path.join(wikiDir(root), 'raw', 'topic', '2026-10-19-b.md'),
      '---\nsha256: not-a-digest\n---\nother\n',
    )
    const result = await lintWiki(target(root), { checks: ['raw'] })
    expect(kinds(result.issues)).toEqual(['raw-digest-missing', 'raw-digest-missing'])
  })

  it('accepts a frontmatter that is absent only by refusing to verify it', async () => {
    const root = await tempDir('dsh-wiki-raw-nofm-')
    await scaffoldWiki(root)
    await writeFileAt(path.join(wikiDir(root), 'raw', 'plain.md'), 'no frontmatter at all\n')
    const result = await lintWiki(target(root), { checks: ['raw'] })
    expect(kinds(result.issues)).toEqual(['raw-digest-missing'])
  })

  it('hashes exactly what the convention writes, so a clean source is silent', async () => {
    const root = await tempDir('dsh-wiki-raw-clean-')
    await scaffoldWiki(root)
    const body = 'line one\nline two\n'
    const rendered = renderRawSource({ relative: 'raw/a.md', body })
    await writeFileAt(path.join(wikiDir(root), 'raw', 'a.md'), rendered)
    const result = await lintWiki(target(root), { checks: ['raw'] })
    expect(result.issues).toEqual([])
  })

  it('walks raw/ through topic directories without following symlinks', async () => {
    const root = await tempDir('dsh-wiki-raw-walk-')
    await scaffoldWiki(root)
    await writeRawSource(root, { relative: 'raw/a/2026-10-19-one.md', body: 'one\n' })
    await writeRawSource(root, { relative: 'raw/b/deep/2026-10-19-two.md', body: 'two\n' })
    await mkdir(path.join(root, 'outside'), { recursive: true })
    await writeFile(path.join(root, 'outside', 'secret.md'), 'not a source\n')
    await import('node:fs/promises').then(
      async (fs) =>{  await fs.symlink(path.join(root, 'outside'), path.join(wikiDir(root), 'raw', 'link'), 'dir') },
    )
    const result = await lintWiki(target(root), { checks: ['raw'] })
    expect(result.issues).toEqual([])
  })
})

describe('the issue bound (DESIGN §6.6)', () => {
  it('returns at most 50 issues and says that it cut the list', async () => {
    const root = await tempDir('dsh-wiki-bound-')
    await scaffoldWiki(root)
    for (let index = 0; index < MAX_LINT_ISSUES + 5; index += 1) {
      await writePage(root, { slug: `page-${String(index)}`, body: `# ${String(index)}\n\n[[missing]]\n` })
    }
    await writeIndex(root, [])
    const result = await lintWiki(target(root), { checks: ['links', 'index', 'raw'] })
    expect(result.issues).toHaveLength(MAX_LINT_ISSUES)
    expect(result.summary).toMatch(/showing the first 50/u)
    expect(result.summary).toMatch(/issue\(s\)/u)
  })
})

/**
 * A repository whose wiki has one finding per check: an unresolved link and a
 * raw source whose digest does not match. The index is healthy, so the set of
 * checks a call runs is visible in the findings and in the summary.
 */
async function wikiWithOneFaultPerCheck(): Promise<string> {
  const root = await initRepo()
  await scaffoldWiki(root)
  await writePage(root, { slug: 'alpha', body: '# Alpha\n\n[[missing]]\n' })
  await writeIndex(root, ['alpha'])
  await writeRawSource(root, {
    relative: 'raw/topic/2026-10-19-source.md',
    body: 'the source text\n',
    digest: 'f'.repeat(64),
  })
  return root
}

describe('an explicit checks argument is never widened (DESIGN §6.6)', () => {
  it('refuses an empty list rather than running the default', async () => {
    await expect(
      executeWikiLint({ checks: [] }, fakeExec(undefined), await depsWithNoGlobal()),
    ).rejects.toThrow(/checks.*empty/u)
  })

  it('refuses an unknown name rather than dropping it', async () => {
    await expect(
      executeWikiLint({ checks: ['bogus'] as never }, fakeExec(undefined), await depsWithNoGlobal()),
    ).rejects.toThrow(/unknown check\(s\): bogus/u)
  })
})

describe.skipIf(!hasGit)('wiki_lint through the tool (DESIGN §6.6)', () => {
  it('checks the project wiki and reports the summary', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha', body: '# Alpha\n\n[[missing]]\n' })
    await writeIndex(root, ['alpha'])
    const logger = recordingLogger()
    const value = await executeWikiLint(
      {},
      fakeExec(fakeAgentAt(root)),
      await depsWithNoGlobal(logger),
    )
    expect(kinds(value.issues)).toEqual(['unresolved-link'])
    expect(value.summary).toMatch(/\.dsh\/wiki\//u)
    expect(value.summary).toMatch(/1 issue/u)
    expect(value.summary).toMatch(/checks: links, index, raw/u)
  })

  it('runs the configured checks when the argument is omitted', async () => {
    const root = await wikiWithOneFaultPerCheck()
    const deps = { ...(await depsWithNoGlobal()), checks: ['links', 'index'] as const }
    const value = await executeWikiLint({}, fakeExec(fakeAgentAt(root)), deps)
    expect(kinds(value.issues)).toEqual(['unresolved-link'])
    expect(value.summary).toMatch(/checks: links, index/u)
    expect(value.summary).not.toMatch(/raw/u)
  })

  it('lets an explicit list override the configured checks', async () => {
    const root = await wikiWithOneFaultPerCheck()
    const deps = { ...(await depsWithNoGlobal()), checks: ['links', 'index'] as const }
    const value = await executeWikiLint({ checks: ['raw'] }, fakeExec(fakeAgentAt(root)), deps)
    expect(kinds(value.issues)).toEqual(['raw-digest-mismatch'])
    expect(value.summary).toMatch(/checks: raw/u)
  })

  it('runs all three when the deployment configures none', async () => {
    const root = await wikiWithOneFaultPerCheck()
    const value = await executeWikiLint({}, fakeExec(fakeAgentAt(root)), await depsWithNoGlobal())
    expect(kinds(value.issues)).toEqual(['unresolved-link', 'raw-digest-mismatch'])
    expect(value.summary).toMatch(/checks: links, index, raw/u)
  })

  it('says so instead of failing when there is no wiki', async () => {
    const root = await initRepo()
    const value = await executeWikiLint({}, fakeExec(fakeAgentAt(root)), await depsWithNoGlobal())
    expect(value.issues).toEqual([])
    expect(value.summary).toMatch(/no project wiki here/u)
  })

  it('says so when the session recorded no cwd', async () => {
    const value = await executeWikiLint({}, fakeExec(undefined), await depsWithNoGlobal())
    expect(value.summary).toMatch(/recorded no working directory/u)
  })

  it('notes that a session below the checkout root is read-only', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const nested = path.join(root, 'packages', 'x')
    await mkdir(nested, { recursive: true })
    const value = await executeWikiLint({}, fakeExec(fakeAgentAt(nested)), await depsWithNoGlobal())
    expect(value.summary).toMatch(/read-only here/u)
  })

  it('notes that a global scope was not checked while no global wiki exists', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const value = await executeWikiLint({ scope: 'all' }, fakeExec(fakeAgentAt(root)), await depsWithNoGlobal())
    expect(value.summary).toMatch(/no global wiki repository is designated/u)
  })

  it('surfaces the wiki.yml warnings in the log', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writeSettings(root, 'commit: true\nsomething: 1\n')
    await writeGitignore(root, ['!.dsh/wiki/'])
    const logger = recordingLogger()
    await executeWikiLint({}, fakeExec(fakeAgentAt(root)), await depsWithNoGlobal(logger))
    expect(logger.warnings.join('\n')).toMatch(/unknown key `something`/u)
  })
})

/**
 * The round trip the design's completion criterion asks for (DESIGN §11 order
 * 3), performed through the tool the model would call: start from a repository
 * with an empty wiki, write the pages and `index.md` the way the skill
 * describes, plant the faults a first draft has, and watch `wiki_lint` find
 * them and then fall silent after the fix.
 */
describe.skipIf(!hasGit)('ingest → lint → fix (DESIGN §11 order 3)', () => {
  it('goes from an empty wiki to a clean one, with the faults found first', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const deps = await depsWithNoGlobal()
    const exec = fakeExec(fakeAgentAt(root))

    // 1. Draft: a source, two pages, and an index — with three deliberate faults.
    const body = 'The upgrade ran on 2026-10-19 and took 40 minutes.\n'
    await writeRawSource(root, { relative: 'raw/database/2026-10-19-pg-upgrade.md', body })
    await writePage(root, {
      slug: 'postgres-migration',
      body: '# Postgres migration\n\nSee [[pg-tuning]] and [[not-yet-written]].\n',
      extra: ['sources: [raw/database/2026-10-19-pg-upgrade.md]'],
    })
    await writePage(root, { slug: 'pg-tuning', body: '# PG tuning\n\n[[postgres-migration]]\n' })
    await writeIndex(root, ['postgres-migration'])

    const first = await executeWikiLint({}, exec, deps)
    expect(kinds(first.issues).sort()).toEqual(['index-missing', 'unresolved-link'])
    expect(first.issues.some(issue => issue.path === '.dsh/wiki/pages/pg-tuning.md')).toBe(true)

    // 2. Fix what the lint reported: the index entry and the dangling link.
    await writeIndex(root, ['postgres-migration', 'pg-tuning'])
    await writePage(root, {
      slug: 'postgres-migration',
      body: '# Postgres migration\n\nSee [[pg-tuning]].\n',
      extra: ['sources: [raw/database/2026-10-19-pg-upgrade.md]'],
    })

    const second = await executeWikiLint({}, exec, deps)
    expect(second.issues).toEqual([])
    expect(second.summary).toMatch(/no issues/u)

    // 3. Hand-edit the source the way a person might, and watch the digest catch it.
    const source = path.join(wikiDir(root), 'raw', 'database', '2026-10-19-pg-upgrade.md')
    const edited = (await import('node:fs/promises').then(async fs => await fs.readFile(source, 'utf8'))).replace(
      '40 minutes',
      '90 minutes',
    )
    await writeFile(source, edited)
    const third = await executeWikiLint({ checks: ['raw'] }, exec, deps)
    expect(kinds(third.issues)).toEqual(['raw-digest-mismatch'])
  })

  it('reports a file whose name cannot be a page slug without treating it as a page', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writeFile(path.join(wikiDir(root), 'pages', 'bad:slug.md'), '# nope\n')
    const value = await executeWikiLint({}, fakeExec(fakeAgentAt(root)), await depsWithNoGlobal())
    expect(kinds(value.issues)).toEqual(['unreadable'])
    expect(value.issues[0]?.detail).toMatch(/not a usable page slug/u)
  })

  it('treats a readable name with spaces as a page, as the convention allows', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writeFile(path.join(wikiDir(root), 'pages', 'Not A Slug.md'), '# nope\n')
    const value = await executeWikiLint({}, fakeExec(fakeAgentAt(root)), await depsWithNoGlobal())
    expect(kinds(value.issues)).toEqual(['index-missing', 'index-missing'])
  })
})

/** A fake agent rooted at one directory. */
function fakeAgentAt(cwd: string) {
  return {
    session: {
      id: 'session-lint',
      header: { cwd },
      deriveMessages: () => [],
    },
  }
}

/**
 * The global wiki's half of the lint (DESIGN §6.6, §6.4): a page of the project
 * wiki may point at the global one with `[[global:slug]]`, so the check has to
 * know the global wiki's real slugs — and the global wiki itself is linted with
 * paths relative to its own repository top.
 */
describe.skipIf(!hasGit)('the global scope (DESIGN §6.6, §6.4)', () => {
  /** A project wiki and a designated global wiki, wired to the tool. */
  async function bothWikis(): Promise<{ project: string; global: string; deps: WikiToolDeps }> {
    const project = await initRepo()
    await scaffoldWiki(project)
    await writePage(project, {
      slug: 'alpha',
      body: '# Alpha\n\nSee [[global:shared]] and [[local]].\n',
    })
    await writePage(project, { slug: 'local' })
    await writeIndex(project, ['alpha', 'local'])
    const global = await initRepo()
    await scaffoldGlobalRepo(global)
    await writeGlobalPage(global, { slug: 'shared', body: '# Shared\n\nSee [[global:other]].\n' })
    await writeGlobalPage(global, { slug: 'other' })
    await writeGlobalIndex(global, ['shared', 'other'])
    const { state } = await tempGlobalState({ sidecar: { path: global } })
    return { project, global, deps: { logger: recordingLogger(), global: state } }
  }

  it('resolves [[global:slug]] from a project page against the real global pages', async () => {
    const { project, deps } = await bothWikis()
    const value = await executeWikiLint({}, fakeExec(fakeAgentAt(project)), deps)
    expect(kinds(value.issues)).toEqual([])
    expect(value.summary).toMatch(/no issues/u)
  })

  it('reports a [[global:slug]] the global wiki does not resolve', async () => {
    const { project, global, deps } = await bothWikis()
    await writePage(project, { slug: 'beta', body: '# Beta\n\n[[global:nowhere]]\n' })
    await writeIndex(project, ['alpha', 'beta', 'local'])
    const value = await executeWikiLint({}, fakeExec(fakeAgentAt(project)), deps)
    expect(kinds(value.issues)).toEqual(['unresolved-global-link'])
    expect(value.issues[0]?.detail).toMatch(/the global wiki has no page with that slug/u)
    expect(value.issues[0]?.scope).toBe('project')
    expect(global).toBeTruthy()
  })

  it('lints the global wiki alone, with paths relative to its repository top', async () => {
    const { project, global, deps } = await bothWikis()
    await writeGlobalPage(global, { slug: 'broken', body: '# Broken\n\n[[missing]] [[global:gone]]\n' })
    const value = await executeWikiLint({ scope: 'global' }, fakeExec(fakeAgentAt(project)), deps)
    // Two link findings on the new page plus the `index-missing` the catalogue
    // check raises for a page `index.md` does not list.
    expect(kinds(value.issues)).toEqual(['unresolved-link', 'unresolved-global-link', 'index-missing'])
    expect(value.issues.slice(0, 2).map(issue => issue.path)).toEqual([
      'pages/broken.md',
      'pages/broken.md',
    ])
    expect(value.issues.every(issue => issue.scope === 'global')).toBe(true)
    expect(value.summary).toContain(`global wiki (${global})`)
  })

  it('lints both with scope all and keeps the project findings first', async () => {
    const { project, global, deps } = await bothWikis()
    await writePage(project, { slug: 'beta', body: '# Beta\n\n[[nowhere]]\n' })
    await writeGlobalPage(global, { slug: 'broken', body: '# Broken\n\n[[missing]]\n' })
    const value = await executeWikiLint({ scope: 'all' }, fakeExec(fakeAgentAt(project)), deps)
    const scopes = value.issues.map(issue => issue.scope)
    expect(scopes).toContain('project')
    expect(scopes).toContain('global')
    // Every project finding comes before the first global one (DESIGN §6.4).
    expect(scopes.indexOf('global')).toBeGreaterThan(scopes.lastIndexOf('project'))
    expect(value.summary).toContain('.dsh/wiki/')
    expect(value.summary).toContain(`global wiki (${global})`)
  })

  it('checks the global raw digests too', async () => {
    const { project, global, deps } = await bothWikis()
    await writeGlobalRawSource(global, {
      relative: 'raw/topic/2026-10-19-source.md',
      body: 'the source text\n',
      digest: 'f'.repeat(64),
    })
    const value = await executeWikiLint({ scope: 'global', checks: ['raw'] }, fakeExec(fakeAgentAt(project)), deps)
    expect(kinds(value.issues)).toEqual(['raw-digest-mismatch'])
    expect(value.issues[0]?.path).toBe('raw/topic/2026-10-19-source.md')
    expect(value.issues[0]?.scope).toBe('global')
  })

  it('says why the global scope could not be checked, rather than failing', async () => {
    const project = await initRepo()
    await scaffoldWiki(project)
    const value = await executeWikiLint({ scope: 'global' }, fakeExec(fakeAgentAt(project)), await depsWithNoGlobal())
    expect(value.issues).toEqual([])
    expect(value.summary).toMatch(/WIKI_GLOBAL_DISABLED/u)
    expect(value.summary).toMatch(/\/wiki repo set/u)
  })

  it('disables the global wiki for a session whose cwd overlaps the repository', async () => {
    const global = await initRepo()
    await scaffoldGlobalRepo(global)
    const { state } = await tempGlobalState({ sidecar: { path: global } })
    const nested = path.join(global, 'sub')
    await mkdir(nested, { recursive: true })
    const value = await executeWikiLint(
      { scope: 'global' },
      fakeExec(fakeAgentAt(nested)),
      { logger: recordingLogger(), global: state },
    )
    expect(value.summary).toMatch(/overlaps this session's working directory/u)
  })
})
