/**
 * `raw/` protection suite (DESIGN §6.6, §5.2, §10): the path classification on
 * its own, and the `tools/pre-execute` policy built on it.
 *
 * The rule under test is narrow on purpose — `write` and `edit` only, an
 * **existing** file under the project wiki's `raw/` only — so the suite checks
 * both halves: what is refused, and what must not be touched (`read`, a new
 * source, a `.dsh/memory` path, a path outside the wiki, a symlink out).
 *
 * The paths handed to the guard are mostly absolute with the base pinned
 * explicitly (`pathBase`), because the filesystem tools accept a path relative
 * to the directory the model works in. The guard takes that directory from the
 * working-directory service, so the suite also pins the service and checks a
 * relative path after a change. Pinning the base keeps the assertions
 * independent of the ambient process directory, which is the package directory
 * under `npm test`.
 * @module @anago-harness/llm-wiki/tests/guard.spec
 */
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { afterAll, describe, expect, it } from 'vitest'
import { createWikiApprovalGate } from '../src/approval.ts'
import { classifyGuardedPath, guardDecision, GUARDED_TOOLS, rawImmutableReason } from '../src/guard.ts'
import {
  cleanupTempDirs,
  fakeAgent,
  fakeApproval,
  fakeToolCall,
  gitAvailable,
  initRepo,
  linkTo,
  rawDir,
  recordingLogger,
  scaffoldWiki,
  tempDir,
  wikiDir,
  wikiConfig,
  writeRawSource,
} from './support.ts'

const hasGit = gitAvailable()

afterAll(cleanupTempDirs)

/**
 * A repository with a wiki and one recorded source.
 *
 * The temporary directories are `/tmp/...`, whose `realpath` is itself, so an
 * absolute path and a symlinked path to the same file can be compared directly.
 * (A macOS `/var` → `/private/var` spelling would make the two differ.)
 */
async function repoWithSource(): Promise<{ root: string; source: string }> {
  const root = await initRepo()
  await scaffoldWiki(root)
  const source = await writeRawSource(root, {
    relative: 'raw/topic/2026-10-19-source.md',
    body: 'the source text\n',
  })
  return { root, source }
}

/** Classify one path with both the session directory and the path base pinned. */
async function classify(target: string, root: string) {
  return await classifyGuardedPath(target, { cwd: root, pathBase: root })
}

/** The deny decision, or a readable failure when the guard allowed the call. */
async function decisionOf(
  toolName: string,
  args: unknown,
  cwd: string | undefined,
): Promise<PreToolDecision> {
  let nextCalled = false
  const decision = await guardDecision(
    fakeToolCall(toolName, args, cwd === undefined ? undefined : fakeAgent({ cwd })),
    async () => {
      nextCalled = true
      return { kind: 'allow' }
    },
  )
  if (decision.kind === 'allow' && !nextCalled) throw new Error('the guard allowed without calling next()')
  return decision
}

describe('the guarded tool set (DESIGN §6.6)', () => {
  it('is exactly write and edit', () => {
    expect([...GUARDED_TOOLS]).toEqual(['write', 'edit'])
  })
})

describe.skipIf(!hasGit)('classifyGuardedPath (DESIGN §5.2, §6.6)', () => {
  it('finds an existing raw source that is named absolutely', async () => {
    const { root, source } = await repoWithSource()
    const absolute = await classify(source, root)
    expect(absolute.kind).toBe('raw-existing')
    if (absolute.kind !== 'raw-existing') throw new Error('unreachable')
    expect(absolute.file).toBe(source)
    expect(absolute.wikiRoot).toBe(wikiDir(root))
  })

  it('finds an existing raw source that is named relative to the session', async () => {
    const { root, source } = await repoWithSource()
    const relative = await classify('.dsh/wiki/raw/topic/2026-10-19-source.md', root)
    expect(relative.kind).toBe('raw-existing')
    if (relative.kind !== 'raw-existing') throw new Error('unreachable')
    expect(relative.file).toBe(source)
  })

  it('leaves a raw path that does not exist yet alone, so ingest still works', async () => {
    const { root } = await repoWithSource()
    const absolute = await classify(path.join(wikiDir(root), 'raw', 'topic', '2026-10-20-next.md'), root)
    expect(absolute.kind).toBe('raw-new')
    const relative = await classify('.dsh/wiki/raw/topic/2026-10-20-next.md', root)
    expect(relative.kind).toBe('raw-new')
  })

  it('classifies a direct child of raw/: an existing file, and a path that does not exist yet', async () => {
    const { root } = await repoWithSource()
    // The parent of a direct child is `raw/` itself; that must not make the
    // child the directory.
    const existing = path.join(rawDir(root), '2026-10-19-direct.md')
    await writeFile(existing, '---\nsource_url: u\n---\nbody\n')
    const found = await classify(existing, root)
    expect(found.kind).toBe('raw-existing')
    if (found.kind !== 'raw-existing') throw new Error('unreachable')
    expect(found.file).toBe(existing)
    const relativeFound = await classify('.dsh/wiki/raw/2026-10-19-direct.md', root)
    expect(relativeFound.kind).toBe('raw-existing')
    const fresh = await classify(path.join(rawDir(root), '2026-10-20-direct.md'), root)
    expect(fresh.kind).toBe('raw-new')
  })

  it('leaves the raw directory itself outside the rule', async () => {
    const { root } = await repoWithSource()
    for (const target of [rawDir(root), `${rawDir(root)}${path.sep}`, '.dsh/wiki/raw', '.dsh/wiki/raw/']) {
      expect((await classify(target, root)).kind, target).toBe('outside')
    }
  })

  it('ignores pages, the charter, and the index', async () => {
    const { root } = await repoWithSource()
    for (const relative of ['.dsh/wiki/pages/alpha.md', '.dsh/wiki/index.md', '.dsh/wiki/WIKI.md', '.dsh/wiki.yml']) {
      expect((await classify(relative, root)).kind).toBe('outside')
    }
  })

  it('ignores a path outside the wiki, including a sibling that merely shares a prefix', async () => {
    const { root } = await repoWithSource()
    await mkdir(path.join(root, '.dsh', 'wiki-other', 'raw'), { recursive: true })
    await writeFile(path.join(root, '.dsh', 'wiki-other', 'raw', 'x.md'), 'x\n')
    for (const relative of ['.dsh/wiki-other/raw/x.md', '.dsh/memory/MEMORY.md', '../outside.md']) {
      expect((await classify(relative, root)).kind).toBe('outside')
    }
  })

  it('resolves a symlinked parent before deciding (DESIGN §5.2)', async () => {
    const { root, source } = await repoWithSource()
    const link = await linkTo(root, 'alias')
    const viaLink = path.join(link, '.dsh', 'wiki', 'raw', 'topic', '2026-10-19-source.md')
    const throughLink = await classify(viaLink, root)
    expect(throughLink.kind).toBe('raw-existing')
    if (throughLink.kind !== 'raw-existing') throw new Error('unreachable')
    expect(throughLink.file).toBe(source)
  })

  it('protects a symlink that lives under raw/, so a write cannot replace its target', async () => {
    const { root } = await repoWithSource()
    const outside = await tempDir('dsh-wiki-outside-')
    await writeFile(path.join(outside, 'secret.md'), 'secret\n')
    await mkdir(path.join(wikiDir(root), 'raw', 'topic'), { recursive: true })
    const link = path.join(wikiDir(root), 'raw', 'topic', 'escape.md')
    await symlink(path.join(outside, 'secret.md'), link, 'file')
    // The link is a file under raw/; resolving the leaf would have said
    // "outside" and let the write replace the file it points at.
    const classified = await classify(link, root)
    expect(classified.kind).toBe('raw-existing')
    if (classified.kind !== 'raw-existing') throw new Error('unreachable')
    expect(classified.file).toBe(link)
  })

  it('protects a direct child symlink that points out of raw/', async () => {
    const { root } = await repoWithSource()
    const outside = await tempDir('dsh-wiki-outside-')
    await writeFile(path.join(outside, 'secret.md'), 'secret\n')
    const link = path.join(rawDir(root), 'escape-direct.md')
    await symlink(path.join(outside, 'secret.md'), link, 'file')
    // A direct child's parent is `raw/`, so judging the parent alone used to
    // call this file "the raw directory" and let the overwrite through.
    const classified = await classify(link, root)
    expect(classified.kind).toBe('raw-existing')
    if (classified.kind !== 'raw-existing') throw new Error('unreachable')
    expect(classified.file).toBe(link)
  })

  it('ignores a directory under raw/, which is not an existing source', async () => {
    const { root } = await repoWithSource()
    await mkdir(path.join(wikiDir(root), 'raw', 'topic2'), { recursive: true })
    expect((await classify(path.join(wikiDir(root), 'raw', 'topic2'), root)).kind).toBe('outside')
  })

  it('ignores the whole question when the session has no cwd', async () => {
    const { root, source } = await repoWithSource()
    expect((await classifyGuardedPath(source, {})).kind).toBe('outside')
    expect((await classifyGuardedPath(source, { cwd: '' })).kind).toBe('outside')
    expect((await classifyGuardedPath(source, { cwd: root, pathBase: root })).kind).toBe('raw-existing')
  })

  it('finds nothing to protect outside a git worktree', async () => {
    const plain = await tempDir('dsh-wiki-nogit-guard-')
    await scaffoldWiki(plain)
    const target = path.join(wikiDir(plain), 'raw', 'x.md')
    expect((await classify(target, plain)).kind).toBe('outside')
  })
})

describe.skipIf(!hasGit)('guardDecision (DESIGN §6.6)', () => {
  it('denies write and edit of an existing raw source with WIKI_RAW_IMMUTABLE', async () => {
    const { root, source } = await repoWithSource()
    for (const tool of ['write', 'edit']) {
      const decision = await decisionOf(tool, { file_path: source, content: 'x' }, root)
      expect(decision.kind).toBe('deny')
      if (decision.kind !== 'deny') throw new Error('unreachable')
      expect(decision.reason).toMatch(/^WIKI_RAW_IMMUTABLE:/u)
      expect(decision.reason).toMatch(/\.dsh\/wiki\/raw\/topic\/2026-10-19-source\.md/u)
      expect(decision.reason).toMatch(/immutable/u)
    }
  })

  it('denies an existing direct child of raw/', async () => {
    const { root } = await repoWithSource()
    const direct = path.join(rawDir(root), '2026-10-19-direct.md')
    await writeFile(direct, '---\nsource_url: u\n---\nbody\n')
    const decision = await decisionOf('write', { file_path: direct }, root)
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' ? decision.reason : '').toMatch(/^WIKI_RAW_IMMUTABLE:/u)
  })

  it('resolves a relative path through the working-directory service, not the session header', async () => {
    const { root } = await repoWithSource()
    const nested = path.join(root, 'nested')
    await mkdir(nested, { recursive: true })
    const relative = '.dsh/wiki/raw/topic/2026-10-19-source.md'
    const call = fakeToolCall('write', { file_path: relative }, fakeAgent({ cwd: root }))
    // At the recorded directory the relative path names the existing source.
    const atRoot = await guardDecision(call, async () => ({ kind: 'allow' }), {
      workingDirectory: () => ({ ensure: async () => root }),
    })
    expect(atRoot.kind).toBe('deny')
    // After a change the same relative path names a file under the new
    // directory, which is the path the filesystem tool would write.
    const afterChange = await guardDecision(call, async () => ({ kind: 'allow' }), {
      workingDirectory: () => ({ ensure: async () => nested }),
    })
    expect(afterChange.kind).toBe('allow')
  })

  it('falls back to the process directory when the working-directory service is absent', async () => {
    const { root, source } = await repoWithSource()
    const relative = path.relative(process.cwd(), source)
    // Different Windows drives make a relative path impossible; the other
    // cases already pin the absolute form.
    if (path.isAbsolute(relative)) return
    expect((await decisionOf('write', { file_path: relative }, root)).kind).toBe('deny')
  })

  it('allows a new raw source, pages, and the index', async () => {
    const { root } = await repoWithSource()
    const wiki = wikiDir(root)
    const cases = [
      ['write', path.join(wiki, 'raw', 'topic', 'next.md')],
      ['write', path.join(wiki, 'pages', 'alpha.md')],
      ['edit', path.join(wiki, 'index.md')],
    ] as const
    for (const [tool, file] of cases) {
      expect((await decisionOf(tool, { file_path: file }, root)).kind).toBe('allow')
    }
  })

  it('never touches read (第六次改訂: 変更系のツールだけ)', async () => {
    const { root, source } = await repoWithSource()
    expect((await decisionOf('read', { file_path: source }, root)).kind).toBe('allow')
  })

  it('passes through a write or edit with no usable path', async () => {
    const { root } = await repoWithSource()
    expect((await decisionOf('write', {}, root)).kind).toBe('allow')
    expect((await decisionOf('write', { file_path: '' }, root)).kind).toBe('allow')
    expect((await decisionOf('write', { file_path: 7 }, root)).kind).toBe('allow')
    expect((await decisionOf('write', null, root)).kind).toBe('allow')
  })

  it('passes other tools through without looking at the repository', async () => {
    const decision = await guardDecision(
      fakeToolCall('bash', { command: 'rm -rf .dsh/wiki/raw' }, fakeAgent({ cwd: '/nonexistent' })),
      async () => ({ kind: 'allow' }),
    )
    expect(decision.kind).toBe('allow')
  })

  it('allows everything when there is no agent or no cwd', async () => {
    const noAgent = await guardDecision(
      { name: 'write', arguments: { file_path: '/etc/passwd' } },
      async () => ({ kind: 'allow' }),
    )
    expect(noAgent.kind).toBe('allow')
    expect((await decisionOf('write', { file_path: '/etc/passwd' }, '')).kind).toBe('allow')
    expect((await decisionOf('write', { file_path: '/etc/passwd' }, undefined)).kind).toBe('allow')
  })

  it('keeps its deny when the approval gate is chained behind it (DESIGN §6.4, D2)', async () => {
    const { root, source } = await repoWithSource()
    // `apply` registers the guard first and the gate second; a waterfall's
    // `next()` is exactly this chain. `writeApproval: ask` would ask about a
    // `wiki_write`, but the raw guard's deny must reach the caller unchanged.
    const gate = createWikiApprovalGate({
      config: wikiConfig({ writeApproval: 'ask' }),
      logger: recordingLogger(),
      approval: () => fakeApproval({ policy: 'ask' }),
    })
    const agent = fakeAgent({ cwd: root })
    const decision = await guardDecision(
      fakeToolCall('edit', { file_path: source, old_text: 'a', new_text: 'b' }, agent),
      async () => await gate.decide(fakeToolCall('edit', { file_path: source }, agent) as never, async () => ({ kind: 'allow' })),
    )
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' ? decision.reason : '').toMatch(/^WIKI_RAW_IMMUTABLE:/u)
  })

  it('does not fail the call when the repository cannot be inspected', async () => {
    const broken = await tempDir('dsh-wiki-broken-')
    await mkdir(path.join(broken, 'sub'), { recursive: true })
    const decision = await decisionOf('write', { file_path: path.join(broken, 'sub', 'x.md') }, broken)
    expect(decision.kind).toBe('allow')
  })
})

describe('rawImmutableReason', () => {
  it('names the file relative to the wiki root and points at the recorded source', () => {
    const reason = rawImmutableReason('/repo/.dsh/wiki/raw/a/b.md', '/repo/.dsh/wiki')
    expect(reason).toMatch(/^WIKI_RAW_IMMUTABLE: \.dsh\/wiki\/raw\/a\/b\.md already exists/u)
    expect(reason).toMatch(/record a new one/u)
  })
})
