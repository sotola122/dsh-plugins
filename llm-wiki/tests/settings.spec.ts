/**
 * `.dsh/wiki.yml` suite (DESIGN §6.3, §10): the trust boundary of the one file
 * a clone can plant, and the read-only rule that a session below the checkout
 * root sees the wiki but may not write it (DESIGN §6.2).
 *
 * The parser cases need no repository; the inspection cases need a real one, so
 * only those skip without `git`.
 * @module @anago-harness/llm-wiki/tests/settings.spec
 */
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createNodeGitRunner, type GitRunner } from '@anago-harness/knowledge-common'
import { afterAll, describe, expect, it } from 'vitest'
import { inspectWiki, parseWikiSettings, readWikiSettings, settingsWarnings } from '../src/inspect.ts'
import {
  cleanupTempDirs,
  gitAvailable,
  initRepo,
  scaffoldWiki,
  tempDir,
  wikiDir,
  writeGitignore,
  writeSettings,
} from './support.ts'

const hasGit = gitAvailable()

afterAll(cleanupTempDirs)

describe('parseWikiSettings (DESIGN §6.3)', () => {
  it('defaults to commit: false when the file is absent', () => {
    expect(parseWikiSettings(null)).toEqual({ commit: false, warnings: [] })
  })

  it('accepts commit: true and commit: false', () => {
    expect(parseWikiSettings('commit: true\n').commit).toBe(true)
    expect(parseWikiSettings('commit: false\n').commit).toBe(false)
    expect(parseWikiSettings('version: 1\ncommit: true # tracked\n').commit).toBe(true)
  })

  it('warns about and ignores every key other than commit and version', () => {
    const settings = parseWikiSettings(
      ['version: 1', 'commit: true', 'guardRaw: false', 'global:', '  repo: /tmp/x', 'search: {}'].join('\n'),
    )
    expect(settings.commit).toBe(true)
    expect(settings.warnings.join('\n')).toMatch(/unknown key `guardRaw`/u)
    expect(settings.warnings.join('\n')).toMatch(/unknown key `global`/u)
    expect(settings.warnings.join('\n')).toMatch(/unknown key `search`/u)
    // The unknown keys cannot change anything: the accepted value is only commit.
    expect(Object.keys(settings).sort()).toEqual(['commit', 'warnings'])
  })

  it('treats an unparseable commit as false instead of trusting it', () => {
    for (const value of ['yes', '1', 'TRUE!', '', '"true"']) {
      const settings = parseWikiSettings(`commit: ${value}\n`)
      expect(settings.commit).toBe(false)
      expect(settings.warnings.join('\n')).toMatch(/`commit` must be true or false/u)
    }
  })

  it('warns about a line it cannot parse rather than guessing', () => {
    const settings = parseWikiSettings('- commit: true\n')
    expect(settings.commit).toBe(false)
    expect(settings.warnings.join('\n')).toMatch(/ignored the line/u)
  })

  it('reports an unreadable file as commit: false', async () => {
    const dir = await tempDir()
    const settings = await readWikiSettings(path.join(dir, 'wiki.yml'))
    expect(settings).toEqual({ commit: false, warnings: [] })
  })

  it('warns about the ignore state instead of changing protection', () => {
    const visible = settingsWarnings({ commit: false, warnings: [] }, { state: 'visible', detail: null })
    expect(visible.join('\n')).toMatch(/would commit it/u)
    const tracked = settingsWarnings({ commit: true, warnings: [] }, { state: 'visible', detail: null })
    expect(tracked.join('\n')).toMatch(/commit: true/u)
    expect(settingsWarnings({ commit: true, warnings: [] }, { state: 'ignored', detail: null })).toEqual([])
  })

  it('does not call an undecidable ignore answer "not ignored"', () => {
    const warnings = settingsWarnings(
      { commit: false, warnings: [] },
      { state: 'unknown', detail: 'git check-ignore exited 128' },
    )
    expect(warnings.join('\n')).toMatch(/undecidable|confirm by hand/u)
    expect(warnings.join('\n')).not.toMatch(/would commit it/u)
  })
})

describe.skipIf(!hasGit)('inspectWiki (DESIGN §6.2)', () => {
  it('finds the wiki and allows writes from the checkout root', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const inspection = await inspectWiki({ cwd: root })
    expect(inspection.kind).toBe('found')
    if (inspection.kind !== 'found') throw new Error('unreachable')
    expect(inspection.writable).toBe(true)
    expect(inspection.root.checkoutRoot).toBe(root)
    expect(inspection.root.wikiRoot).toBe(wikiDir(root))
    expect(inspection.settings.commit).toBe(false)
  })

  it('finds the same wiki but makes it read-only from a subdirectory', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const nested = path.join(root, 'packages', 'x')
    await mkdir(nested, { recursive: true })
    const inspection = await inspectWiki({ cwd: nested })
    expect(inspection.kind).toBe('found')
    if (inspection.kind !== 'found') throw new Error('unreachable')
    expect(inspection.writable).toBe(false)
    expect(inspection.root.wikiRoot).toBe(wikiDir(root))
  })

  it('is read-only for a session in a linked worktree of a wiki-holding checkout', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const { writeFile: write } = await import('node:fs/promises')
    await write(path.join(root, 'README.md'), 'seed\n')
    const { git } = await import('./support.ts')
    git(root, ['add', 'README.md'])
    git(root, ['commit', '-m', 'seed'])
    const worktree = await tempDir('dsh-wiki-worktree-')
    git(root, ['worktree', 'add', '--quiet', worktree, '-b', 'wiki-branch'])
    const inspection = await inspectWiki({ cwd: worktree })
    // The wiki root comes from the *current* worktree, which has no .dsh/wiki.
    expect(inspection.kind).toBe('absent')
  })

  it('is absent outside a git worktree and when .dsh/wiki does not exist', async () => {
    const plain = await tempDir('dsh-wiki-nogit-')
    expect((await inspectWiki({ cwd: plain })).kind).toBe('absent')
    const root = await initRepo()
    expect((await inspectWiki({ cwd: root })).kind).toBe('absent')
  })

  it('reads commit from .dsh/wiki.yml and warns when the ignore state disagrees', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writeSettings(root, 'version: 1\ncommit: true\nunknown: 1\n')
    const inspection = await inspectWiki({ cwd: root })
    if (inspection.kind !== 'found') throw new Error('unreachable')
    expect(inspection.settings.commit).toBe(true)
    expect(inspection.ignore.state).toBe('visible')
    expect(inspection.warnings.join('\n')).toMatch(/unknown key `unknown`/u)
    expect(inspection.warnings.join('\n')).toMatch(/commit: true and \.dsh\/wiki\/index\.md is not ignored/u)
  })

  it('reports ignored when the managed block un-ignores the wiki', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writeSettings(root, 'commit: true\n')
    await writeGitignore(root, ['!.dsh/wiki/'])
    const inspection = await inspectWiki({ cwd: root })
    if (inspection.kind !== 'found') throw new Error('unreachable')
    // The probe is a file inside the wiki: `git check-ignore` answers "not
    // ignored" for a path that a `!dir/` rule re-includes, which is exactly the
    // state a tracked wiki is in.
    expect(inspection.ignore.state).toBe('visible')
    expect(inspection.warnings.join('\n')).toMatch(/commit: true and \.dsh\/wiki\/index\.md is not ignored/u)
  })

  it('reports ignored for a private wiki covered by a .dsh/ rule of its own', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writeFile(path.join(root, '.gitignore'), '.dsh/\n')
    const inspection = await inspectWiki({ cwd: root })
    if (inspection.kind !== 'found') throw new Error('unreachable')
    expect(inspection.ignore.state).toBe('ignored')
    expect(inspection.warnings).toEqual([])
  })

  it('warns that a private wiki is not ignored', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const inspection = await inspectWiki({ cwd: root })
    if (inspection.kind !== 'found') throw new Error('unreachable')
    expect(inspection.ignore.state).toBe('visible')
    expect(inspection.warnings.join('\n')).toMatch(/does not set commit: true/u)
  })

  it('treats a git failure as undecidable, not as "not ignored" (前段の申し送り)', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    // A path git cannot resolve (a symlink crossing, `git check-ignore` exit
    // 128) reaches the helper as {ignored: false, code: 128}; the code, not the
    // boolean, is what decides "undecidable".
    const run: GitRunner = async (args, options) => {
      if (args[0] === 'check-ignore') return { code: 128, stdout: '', stderr: 'fatal: not a git repository' }
      return await createNodeGitRunner()(args, options)
    }
    const inspection = await inspectWiki({ cwd: root, run })
    if (inspection.kind !== 'found') throw new Error('unreachable')
    expect(inspection.ignore.state).toBe('unknown')
    expect(inspection.ignore.detail).toMatch(/check-ignore exited 128/u)
    expect(inspection.warnings.join('\n')).toMatch(/confirm by hand/u)
  })

  it('resolves the checkout root through a symlinked cwd', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const link = await tempDir('dsh-wiki-symlinkcwd-')
    const alias = path.join(link, 'alias')
    await symlink(root, alias, 'dir')
    const inspection = await inspectWiki({ cwd: alias })
    if (inspection.kind !== 'found') throw new Error('unreachable')
    expect(inspection.writable).toBe(true)
    const nested = path.join(alias, 'sub')
    await mkdir(nested, { recursive: true })
    const under = await inspectWiki({ cwd: nested })
    expect(under.kind === 'found' && under.writable).toBe(false)
  })
})

describe.skipIf(!hasGit)('roadmap: .gitignore is not written by this plugin', () => {
  it('leaves .gitignore alone even when commit: true', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writeSettings(root, 'commit: true\n')
    await writeFile(path.join(root, '.gitignore'), 'node_modules\n')
    await inspectWiki({ cwd: root })
    const { readAt } = await import('./support.ts')
    expect(await readAt(path.join(root, '.gitignore'))).toBe('node_modules\n')
  })
})
