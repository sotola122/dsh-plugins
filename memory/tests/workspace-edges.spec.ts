/**
 * Workspace edges (DESIGN §5.1): the paths the main suite leaves to the git seam
 * and to the filesystem — a git that cannot run, a linked worktree's wiki
 * switch, the disabled switch reaching the write path, a `.gitignore` the plugin
 * cannot read or replace, and the `manageGitignore: false` skip.
 * @module @anago-harness/memory/tests/workspace-edges
 */
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { AtomicWriteApi, GitRunner } from '@anago-harness/knowledge-common'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ensureWorkspaceWritable,
  gitignoreLinesFor,
  inspectWorkspace,
  type ReadyWorkspace,
  syncGitignoreBlock,
} from '../src/workspace.ts'
import { cleanupTempDirs, git, gitAvailable, initRepo, tempDir } from './support.ts'

const api: AtomicWriteApi = { withFileLock, writeFileAtomic }
const hasGit = gitAvailable()

/** The write options the workspace store uses, with the gitignore block managed. */
const writeOptions = { api, manageGitignore: true, lockWaitMs: 5000 }

afterAll(cleanupTempDirs)

/** Inspect one directory and require the workspace to be ready. */
async function ready(cwd: string): Promise<ReadyWorkspace> {
  const inspection = await inspectWorkspace({ cwd, enabled: true })
  if (inspection.kind !== 'ready') {
    throw new Error(`expected a ready workspace, got: ${inspection.detail}`)
  }
  return inspection
}

/** The message one refused write reports. */
async function refusalOf(write: Promise<unknown>): Promise<string> {
  try {
    await write
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('the write was expected to be refused')
}

/** Read one repository's `.gitignore`. */
async function gitignoreOf(root: string): Promise<string> {
  return await readFile(path.join(root, '.gitignore'), 'utf8')
}

describe('the git seam', () => {
  it('reports no workspace when git cannot run at all', async () => {
    const dir = await tempDir('dsh-noexec-')
    // A runner that rejects is what the default one does when the executable
    // itself is missing; the inspection must report "no worktree", not throw.
    const run: GitRunner = () => Promise.reject(new Error('spawn git ENOENT'))
    const inspection = await inspectWorkspace({ cwd: dir, enabled: true, run })
    expect(inspection.kind).toBe('unavailable')
    if (inspection.kind !== 'unavailable') throw new Error('unreachable')
    expect(inspection.reason).toBe('no-git')
    expect(inspection.detail).toBe('spawn git ENOENT')
  })
})

describe.skipIf(!hasGit)('a linked worktree', () => {
  it('reads the wiki switch from the worktree and writes the block in the main checkout', async () => {
    const root = await initRepo()
    await writeFile(path.join(root, 'README.md'), '# repo\n')
    git(root, ['add', 'README.md'])
    git(root, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'])
    const linked = path.join(await tempDir('dsh-linked-'), 'worktree')
    git(root, ['worktree', 'add', '--detach', linked])
    await mkdir(path.join(linked, '.dsh'), { recursive: true })
    await writeFile(path.join(linked, '.dsh', 'wiki.yml'), 'version: 1\ncommit: true\n')

    const inspection = await ready(linked)
    expect(inspection.store.worktree).toBe(true)
    expect(inspection.store.root).toBe(await realpath(root))
    expect(inspection.store.checkoutRoot).toBe(await realpath(linked))

    // The conditional line comes from the worktree's own `wiki.yml`, although
    // the block is shared and therefore lives in the main checkout (Q8).
    expect([...await gitignoreLinesFor(inspection.store)]).toEqual([
      '.dsh/*',
      '!.dsh/wiki.yml',
      '!.dsh/wiki/',
    ])
    await ensureWorkspaceWritable(inspection, writeOptions)
    expect(await gitignoreOf(inspection.store.root)).toContain('!.dsh/wiki/')
  })
})

describe.skipIf(!hasGit)('the write path', () => {
  it('refuses a write when the workspace store is switched off', async () => {
    const root = await initRepo()
    const inspection = await inspectWorkspace({ cwd: root, enabled: false })
    expect(inspection.kind).toBe('unavailable')
    if (inspection.kind !== 'unavailable') throw new Error('unreachable')
    expect(inspection.reason).toBe('disabled')
    await expect(ensureWorkspaceWritable(inspection, writeOptions)).rejects.toThrow(
      /MEMORY_NO_WORKSPACE: workspace\.enabled is false; the workspace store needs a git worktree/u,
    )
  })

  it('refuses the block when .gitignore cannot be read and cannot be replaced', async () => {
    const root = await initRepo()
    // A directory where the file belongs: reading it fails with EISDIR, so the
    // block state is unknown and the edit attempt reports the real failure.
    await mkdir(path.join(root, '.gitignore'), { recursive: true })
    const inspection = await ready(root)

    const message = await refusalOf(ensureWorkspaceWritable(inspection, writeOptions))
    expect(message).toMatch(/^MEMORY_NO_IGNORE_RULE: /u)
    // The refusal still hands the person the block the repository needs.
    expect(message).toContain('Add this block to .gitignore by hand')
    expect(message).toContain('!.dsh/wiki.yml')
  })

  it('skips the block when manageGitignore is false and a rule already ignores the store', async () => {
    const root = await initRepo()
    await writeFile(path.join(root, '.gitignore'), '.dsh/\n')
    const inspection = await ready(root)
    expect(inspection.ignored).toBe(true)

    const result = await syncGitignoreBlock(inspection, { ...writeOptions, manageGitignore: false })
    expect(result.edited).toBe(false)
    expect(result.created).toBe(false)
    expect(result.skipped).toBe('workspace.manageGitignore is false, so the block is never written')
    expect([...result.lines]).toEqual(['.dsh/*', '!.dsh/wiki.yml'])
    // The user's own rule is left exactly as it was.
    expect(await gitignoreOf(root)).toBe('.dsh/\n')
  })
})
