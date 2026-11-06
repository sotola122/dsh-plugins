/**
 * Guard edge suite (DESIGN §6.4, §6.6, §5.2): the paths around the ordinary
 * cases — an absolute path with no pinned base, a cancelled inspection, a
 * working directory that cannot be resolved, a path the filesystem refuses to
 * canonicalize, and the global-wiki containment predicate on its own.
 *
 * The cancellation case is what a turn that ends mid-tool-call relies on: the
 * pre-execute policy must never turn a tool call into a failure. The suite
 * reaches that state with a named pipe — `.dsh/wiki.yml` is a FIFO, so the
 * plugin blocks in the settings read after the repository resolved; opening the
 * write end is the rendezvous proving git already answered, and the abort then
 * lands on the ignore probe, the one inspection step that rejects instead of
 * reporting "no wiki".
 * @module @anago-harness/llm-wiki/tests/guard-edges.spec
 */
import { execFileSync } from 'node:child_process'
import { mkdir, open, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { classifyGuardedPath, guardDecision, isInsideGlobalWiki } from '../src/guard.ts'
import {
  cleanupTempDirs,
  fakeAgent,
  fakeToolCall,
  gitAvailable,
  initRepo,
  scaffoldWiki,
  tempDir,
  wikiDir,
  writeRawSource,
} from './support.ts'

const hasGit = gitAvailable()

const hasFifo =
  process.platform !== 'win32' &&
  (() => {
    try {
      execFileSync('sh', ['-c', 'command -v mkfifo'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

afterAll(cleanupTempDirs)

/** A repository with a wiki and one recorded source. */
async function repoWithSource(): Promise<{ root: string; source: string }> {
  const root = await initRepo()
  await scaffoldWiki(root)
  const source = await writeRawSource(root, {
    relative: 'raw/topic/2026-10-19-source.md',
    body: 'the source text\n',
  })
  return { root, source }
}

/** Run the policy and report whether it delegated to `next()`. */
async function passthrough(call: ReturnType<typeof fakeToolCall>, deps = {}): Promise<boolean> {
  let nextCalled = false
  const decision = await guardDecision(call, async () => {
    nextCalled = true
    return { kind: 'allow' }
  }, deps)
  return nextCalled && decision.kind === 'allow'
}

describe.skipIf(!hasGit)('classifyGuardedPath edges (DESIGN §5.2)', () => {
  it('resolves an absolute path with no base pinned, against the process directory', async () => {
    const { root, source } = await repoWithSource()
    // `path.resolve` only consults its base for a relative target, so the
    // absolute form lands on the same source however the process directory has
    // moved since the session started.
    const found = await classifyGuardedPath(source, { cwd: root })
    expect(found.kind).toBe('raw-existing')
    if (found.kind !== 'raw-existing') throw new Error('unreachable')
    expect(found.file).toBe(source)
  })

  it.skipIf(!hasFifo)('treats a cancelled inspection as nothing to protect', async () => {
    const { root } = await repoWithSource()
    // The settings read blocks on the FIFO until the write end opens, which is
    // exactly when the repository has already been resolved.
    const fifo = path.join(root, '.dsh', 'wiki.yml')
    execFileSync('mkfifo', [fifo])
    const controller = new AbortController()
    const pending = classifyGuardedPath(path.join(wikiDir(root), 'pages', 'alpha.md'), {
      cwd: root,
      pathBase: root,
      signal: controller.signal,
    })
    const writer = await open(fifo, 'w')
    controller.abort()
    await writer.close()
    expect(controller.signal.aborted).toBe(true)
    // The policy reports "outside" rather than rejecting: the tool call is left
    // to the filesystem tool, which reports the cancellation itself.
    const target = await pending
    expect(target.kind).toBe('outside')
    // With the pipe out of the way the same repository resolves normally, so the
    // case above is the cancellation and not a missing wiki.
    await rm(fifo, { force: true })
    const found = await classifyGuardedPath(path.join(wikiDir(root), 'raw', 'topic', '2026-10-19-source.md'), {
      cwd: root,
    })
    expect(found.kind).toBe('raw-existing')
  })
})

describe.skipIf(!hasGit)('guardDecision edges (DESIGN §6.4, §6.6)', () => {
  it('delegates when the working-directory service cannot resolve the directory', async () => {
    const { root } = await repoWithSource()
    const delegated = await passthrough(
      fakeToolCall('write', { file_path: '.dsh/wiki/raw/topic/next.md' }, fakeAgent({ cwd: root })),
      {
        workingDirectory: () => ({
          ensure: async () => {
            throw new Error('the directory was removed while the session was running')
          },
        }),
      },
    )
    // The filesystem tool resolves the same directory before it writes, so the
    // call already fails there; the policy adds no second failure.
    expect(delegated).toBe(true)
  })

  it('delegates when the filesystem refuses to canonicalize the path', async () => {
    const { root, source } = await repoWithSource()
    // A NUL byte cannot be resolved by `realpath`, so the classification throws
    // instead of answering; the policy contains that as "nothing to protect".
    const delegated = await passthrough(
      fakeToolCall('write', { file_path: `${source}\u0000` }, fakeAgent({ cwd: root })),
    )
    expect(delegated).toBe(true)
  })
})

describe('isInsideGlobalWiki (DESIGN §6.4 check 6)', () => {
  it('contains a path below the repository top with no base pinned', async () => {
    const repo = await tempDir('dsh-wiki-global-')
    await mkdir(path.join(repo, 'pages'), { recursive: true })
    expect(await isInsideGlobalWiki(path.join(repo, 'pages', 'alpha.md'), repo)).toBe(true)
    expect(await isInsideGlobalWiki(path.join(repo, 'alpha.md'), repo)).toBe(true)
  })

  it('leaves a sibling, a parent, and a sibling sharing the prefix alone', async () => {
    const repo = await tempDir('dsh-wiki-global-')
    expect(await isInsideGlobalWiki(path.join(repo, '..', 'outside.md'), repo)).toBe(false)
    expect(await isInsideGlobalWiki(path.join(`${repo}-other`, 'page.md'), repo)).toBe(false)
  })

  it('judges the parent too, so a symlinked leaf cannot name a file elsewhere', async () => {
    const repo = await tempDir('dsh-wiki-global-')
    const elsewhere = await tempDir('dsh-wiki-global-leaf-')
    await mkdir(path.join(repo, 'pages'), { recursive: true })
    const target = path.join(repo, 'pages', 'alpha.md')
    await symlink(target, path.join(elsewhere, 'alias.md'), 'file')
    // The leaf resolves inside, but the directory holding the alias does not, so
    // a write through the alias would land outside the global wiki.
    expect(await isInsideGlobalWiki(path.join(elsewhere, 'alias.md'), repo)).toBe(false)
    // The parent that really is inside is still accepted.
    expect(await isInsideGlobalWiki(target, repo, repo)).toBe(true)
  })
})
