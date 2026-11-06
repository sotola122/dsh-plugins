/**
 * Workspace suite (DESIGN §10 単体: `.gitignore` の前提条件・realpath): the three
 * preconditions, the managed block, the conditional lines, and the realpath
 * normalization of a symlinked checkout.
 *
 * Every case needs a real repository, so the whole file skips without `git`.
 * @module @anago-harness/memory/tests/workspace
 */
import { mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { AtomicWriteApi } from '@anago-harness/knowledge-common'
import { afterAll, describe, expect, it } from 'vitest'
import { ensureWorkspaceWritable, inspectWorkspace, isWikiCommitted } from '../src/workspace.ts'
import {
  cleanupTempDirs,
  exists,
  git,
  gitAvailable,
  initRepo,
  linkTo,
  readStoreFile,
  tempDir,
} from './support.ts'

const api: AtomicWriteApi = { withFileLock, writeFileAtomic }
const hasGit = gitAvailable()

afterAll(cleanupTempDirs)

/** Inspect one directory with the workspace store enabled. */
async function inspect(cwd: string, enabled = true) {
  return await inspectWorkspace({ cwd, enabled })
}

/** Inspect and then turn the result into a writable store. */
async function writable(cwd: string, manageGitignore = true) {
  const inspection = await inspect(cwd)
  return await ensureWorkspaceWritable(inspection, {
    api,
    manageGitignore,
    lockWaitMs: 5000,
  })
}

/** The `.gitignore` of one repository, or null when it does not exist. */
async function gitignoreOf(root: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, '.gitignore'), 'utf8')
  } catch {
    return null
  }
}

/** The managed block's lines, without markers. */
function blockLines(content: string): string[] {
  const lines = content.split('\n')
  const start = lines.findIndex(line => line.startsWith('# >>> dsh-memory'))
  const end = lines.findIndex(line => line.startsWith('# <<< dsh-memory'))
  return start === -1 || end === -1 ? [] : lines.slice(start + 1, end)
}

describe.skipIf(!hasGit)('preconditions', () => {
  it('disables the workspace store outside a git worktree', async () => {
    const dir = await tempDir('dsh-nogit-')
    const inspection = await inspect(dir)
    expect(inspection.kind).toBe('unavailable')
    if (inspection.kind !== 'unavailable') throw new Error('unreachable')
    expect(inspection.reason).toBe('no-git')
    await expect(writable(dir)).rejects.toThrow(/MEMORY_NO_WORKSPACE/u)
    expect(await exists(path.join(dir, '.dsh'))).toBe(false)
    expect(await exists(path.join(dir, '.gitignore'))).toBe(false)
  })

  it('disables the workspace store when workspace.enabled is false', async () => {
    const root = await initRepo()
    const inspection = await inspect(root, false)
    expect(inspection.kind).toBe('unavailable')
    expect(await exists(path.join(root, '.gitignore'))).toBe(false)
  })

  it('reports a missing rule and adds the managed block before the first write', async () => {
    const root = await initRepo()
    const inspection = await inspect(root)
    expect(inspection.kind).toBe('ready')
    if (inspection.kind !== 'ready') throw new Error('unreachable')
    expect(inspection.ignored).toBe(false)

    const store = await writable(root)
    const content = await gitignoreOf(root)
    expect(content).not.toBeNull()
    expect(blockLines(content ?? '')).toEqual(['.dsh/*', '!.dsh/wiki.yml'])
    expect(content).toContain('# >>> dsh-memory (managed by @tep-hardware/dsh-memory)')
    expect(content).toContain('# <<< dsh-memory')
    expect((await stat(path.join(root, '.gitignore'))).mode & 0o777).toBe(0o644)
    // The block is written; the store file itself is not created by this path.
    expect(await exists(store.file)).toBe(false)
    // And the rule now really applies.
    const after = await inspect(root)
    expect(after.kind === 'ready' && after.ignored).toBe(true)
  })

  it('leaves the block unchanged on the second call', async () => {
    const root = await initRepo()
    await writable(root)
    const before = await gitignoreOf(root)
    await writable(root)
    expect(await gitignoreOf(root)).toBe(before)
  })

  it('keeps bytes outside the block', async () => {
    const root = await initRepo()
    await writeFile(path.join(root, '.gitignore'), 'node_modules\n*.log')
    await writable(root)
    const content = (await gitignoreOf(root)) ?? ''
    expect(content.startsWith('node_modules\n*.log\n')).toBe(true)
    expect(blockLines(content)).toEqual(['.dsh/*', '!.dsh/wiki.yml'])
  })

  it('replaces a stale block instead of appending a second one', async () => {
    const root = await initRepo()
    const stale = [
      '# >>> dsh-memory (managed by @tep-hardware/dsh-memory)',
      '.dsh/*',
      '# <<< dsh-memory',
      '',
    ].join('\n')
    await writeFile(path.join(root, '.gitignore'), stale)
    await writable(root)
    const content = (await gitignoreOf(root)) ?? ''
    expect(content.match(/# >>> dsh-memory/gu)).toHaveLength(1)
    expect(blockLines(content)).toEqual(['.dsh/*', '!.dsh/wiki.yml'])
  })

  it('refuses an unusable marker pair with MEMORY_GITIGNORE_CONFLICT', async () => {
    const root = await initRepo()
    await writeFile(
      path.join(root, '.gitignore'),
      '# >>> dsh-memory (managed by @tep-hardware/dsh-memory)\n.dsh/*\n',
    )
    await expect(writable(root)).rejects.toThrow(/MEMORY_GITIGNORE_CONFLICT/u)
    expect(await gitignoreOf(root)).toBe(
      '# >>> dsh-memory (managed by @tep-hardware/dsh-memory)\n.dsh/*\n',
    )
  })

  it('refuses a tracked store with MEMORY_TRACKED and writes nothing', async () => {
    const root = await initRepo()
    await mkdir(path.join(root, '.dsh', 'memory'), { recursive: true })
    await writeFile(path.join(root, '.dsh', 'memory', 'MEMORY.md'), 'tracked\n')
    git(root, ['add', '-f', '.dsh/memory/MEMORY.md'])
    const inspection = await inspect(root)
    expect(inspection.kind).toBe('unavailable')
    if (inspection.kind !== 'unavailable') throw new Error('unreachable')
    expect(inspection.reason).toBe('tracked')
    await expect(writable(root)).rejects.toThrow(/MEMORY_TRACKED/u)
    expect(await exists(path.join(root, '.gitignore'))).toBe(false)
    expect(await readStoreFile(path.join(root, '.dsh', 'memory', 'MEMORY.md'))).toBe('tracked\n')
  })

  it('refuses to write when manageGitignore is false and no rule exists', async () => {
    const root = await initRepo()
    await expect(writable(root, false)).rejects.toThrow(/MEMORY_NO_IGNORE_RULE/u)
    expect(await exists(path.join(root, '.gitignore'))).toBe(false)
  })

  it('accepts a rule that comes from somewhere else', async () => {
    const root = await initRepo()
    await writeFile(path.join(root, '.gitignore'), '.dsh/\n')
    const store = await writable(root)
    expect(store.file).toBe(path.join(root, '.dsh', 'memory', 'MEMORY.md'))
    // A rule of the user's own is enough: the plugin adds no block it does not need.
    expect(await gitignoreOf(root)).toBe('.dsh/\n')
  })

  it('adds the wiki line only when the wiki is committed', async () => {
    const root = await initRepo()
    await mkdir(path.join(root, '.dsh'), { recursive: true })
    await writeFile(path.join(root, '.dsh', 'wiki.yml'), 'version: 1\ncommit: false\n')
    await writable(root)
    expect(blockLines((await gitignoreOf(root)) ?? '')).toEqual(['.dsh/*', '!.dsh/wiki.yml'])

    await writeFile(path.join(root, '.dsh', 'wiki.yml'), 'version: 1\ncommit: true\n')
    await writable(root)
    expect(blockLines((await gitignoreOf(root)) ?? '')).toEqual([
      '.dsh/*',
      '!.dsh/wiki.yml',
      '!.dsh/wiki/',
    ])
    expect(await isWikiCommitted(root)).toBe(true)
  })

  it('adds the skills line only when skill files are tracked', async () => {
    const root = await initRepo()
    await mkdir(path.join(root, '.dsh', 'skills', 'demo'), { recursive: true })
    await writeFile(path.join(root, '.dsh', 'skills', 'demo', 'SKILL.md'), '# demo\n')
    git(root, ['add', '-f', '.dsh/skills/demo/SKILL.md'])
    await writable(root)
    expect(blockLines((await gitignoreOf(root)) ?? '')).toEqual([
      '.dsh/*',
      '!.dsh/wiki.yml',
      '!.dsh/skills/',
    ])
  })
})

describe.skipIf(!hasGit)('realpath', () => {
  it('resolves a symlinked checkout to its real store', async () => {
    const root = await initRepo()
    const link = await linkTo(root)
    const store = await writable(link)
    expect(store.root).toBe(await realpathOf(root))
    expect(store.file).toBe(path.join(await realpathOf(root), '.dsh', 'memory', 'MEMORY.md'))
    // The block landed in the real repository, not next to the symlink.
    expect(await exists(path.join(await realpathOf(root), '.gitignore'))).toBe(true)
  })

  it('resolves two spellings of one checkout to one store', async () => {
    const root = await initRepo()
    const link = await linkTo(root)
    const nested = path.join(root, 'packages')
    await mkdir(nested, { recursive: true })
    const nestedLink = path.join(link, 'packages')
    const fromNested = await inspectWorkspace({ cwd: nested, enabled: true })
    const fromLink = await inspectWorkspace({ cwd: nestedLink, enabled: true })
    if (fromNested.kind !== 'ready' || fromLink.kind !== 'ready') throw new Error('unreachable')
    expect(fromLink.store.file).toBe(fromNested.store.file)
    expect(fromLink.store.root).toBe(fromNested.store.root)
  })

  it('refuses a store path that git cannot answer for, instead of guessing', async () => {
    // `git check-ignore` fails with "beyond a symbolic link" (exit 128) when a
    // path component is a symlink, so the plugin treats the rule as unproven and
    // refuses the write rather than assuming the path is ignored.
    const root = await initRepo()
    const elsewhere = await tempDir('dsh-elsewhere-')
    await mkdir(path.join(root, '.dsh'), { recursive: true })
    await symlink(elsewhere, path.join(root, '.dsh', 'memory'), 'dir')
    await writeFile(path.join(root, '.gitignore'), '.dsh/\n')
    await expect(writable(root)).rejects.toThrow(/MEMORY_NO_IGNORE_RULE/u)
  })
})

/** `realpath` for the assertions above. */
async function realpathOf(target: string): Promise<string> {
  return await realpath(target)
}
