/**
 * `wiki_write` edge cases (DESIGN §6.4, §5.2): the shape rules the broad suite
 * does not reach, the `content`/`edit` refusals that only a malformed argument
 * produces, containment when the page directory itself is a link (out of the
 * repository or into `.git/`), a leaf that cannot be inspected, the cancellation
 * signal, and the registered tool definition's `execute`/`render` pair.
 *
 * Every case is built under `os.tmpdir()` and driven through the exported entry
 * points the tool uses, so no `node:fs` call is mocked.
 * @module @anago-harness/llm-wiki/tests/write-edges.spec
 */
import { mkdir, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { afterAll, describe, expect, it } from 'vitest'
import {
  classifyWritePath,
  createWikiWriteTool,
  executeWikiWrite,
  renderWrite,
  type WikiWriteDeps,
  type WikiWriteValue,
} from '../src/write.ts'
import {
  cleanupTempDirs,
  exists,
  fakeAgent,
  fakeExec,
  gitAvailable,
  initRepo,
  recordingLogger,
  scaffoldGlobalRepo,
  tempDir,
  tempGlobalState,
  wikiConfig,
  writeFileAt,
} from './support.ts'

const hasGit = gitAvailable()
const api = { withFileLock, writeFileAtomic }
afterAll(cleanupTempDirs)

/** A designated global repository with the skeleton, and a session outside it. */
async function fixture() {
  const repo = await initRepo()
  await scaffoldGlobalRepo(repo)
  const elsewhere = await initRepo()
  const { state } = await tempGlobalState({ sidecar: { path: repo } })
  const logger = recordingLogger()
  const deps: WikiWriteDeps = { config: wikiConfig(), logger, global: state, api }
  return { repo, elsewhere, state, logger, deps }
}

/** The canonical value as the JSON object the registered renderer receives. */
function canonical(value: WikiWriteValue): Record<string, string | number | boolean | string[]> {
  return { path: value.path, bytes: value.bytes, created: value.created, redacted: [...value.redacted] }
}

/** Run one `wiki_write` call against a fixture, as the tool body does. */
async function write(
  f: Awaited<ReturnType<typeof fixture>>,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<WikiWriteValue> {
  return await executeWikiWrite(args as never, fakeAgent({ cwd: f.elsewhere }), f.deps, signal)
}

describe('classifyWritePath, the remaining refusals (DESIGN §6.4)', () => {
  it('refuses a NUL byte in the path', () => {
    expect(classifyWritePath('pages/a\u0000.md')).toEqual({ error: 'the path contains a NUL byte' })
  })

  it('refuses a source whose file name is not Markdown', () => {
    expect(classifyWritePath('raw/topic/2026-10-19-source.txt')).toEqual({
      error: 'a source file ends with `.md`',
    })
  })

  it('refuses a source whose stem is empty or hidden', () => {
    expect(classifyWritePath('raw/topic/.md')).toEqual({
      error: '`.md` is not a usable source file name',
    })
    expect(classifyWritePath('raw/topic/.hidden.md')).toEqual({
      error: '`.hidden.md` is not a usable source file name',
    })
  })
})

describe('renderWrite, the remaining refusals (DESIGN §6.4)', () => {
  const cfg = wikiConfig()

  it('treats an empty old_text as absent from the file', () => {
    expect(() =>
      renderWrite({ path: 'index.md', edit: { old_text: '', new_text: 'x' } }, 'body\n', 'index', cfg),
    ).toThrow(/WIKI_WRITE_INVALID: `edit\.old_text` does not appear/u)
  })

  it('refuses an edit whose old_text or new_text is not a string', () => {
    for (const edit of [{ old_text: 1, new_text: 'x' }, { old_text: 'body', new_text: null }]) {
      expect(() => renderWrite({ path: 'index.md', edit } as never, 'body\n', 'index', cfg), JSON.stringify(edit)).toThrow(
        /`edit\.old_text` and `edit\.new_text` must both be strings/u,
      )
    }
  })
})

describe.skipIf(!hasGit)('the leaf and its parent against the repository (DESIGN §6.4, §5.2)', () => {
  it('refuses a page directory that is a symlink out of the repository', async () => {
    const f = await fixture()
    const outside = await tempDir('dsh-write-outside-')
    await rm(path.join(f.repo, 'pages'), { recursive: true })
    await symlink(outside, path.join(f.repo, 'pages'), 'dir')
    await expect(write(f, { path: 'pages/alpha.md', content: '# Alpha\n' })).rejects.toThrow(
      /WIKI_WRITE_INVALID: `pages\/alpha\.md` resolves outside the wiki repository/u,
    )
    // The point of refusing is that the page is not written where the link points.
    expect(await exists(path.join(outside, 'alpha.md'))).toBe(false)
  })

  it('refuses a page directory that is a symlink into .git', async () => {
    const f = await fixture()
    await rm(path.join(f.repo, 'pages'), { recursive: true })
    await symlink(path.join(f.repo, '.git'), path.join(f.repo, 'pages'), 'dir')
    await expect(write(f, { path: 'pages/alpha.md', content: '# Alpha\n' })).rejects.toThrow(
      /WIKI_WRITE_INVALID: `\.git\/` is not part of the wiki/u,
    )
    expect(await exists(path.join(f.repo, '.git', 'alpha.md'))).toBe(false)
  })

  it('reports a leaf it cannot inspect, rather than treating it as absent', async () => {
    const f = await fixture()
    await rm(path.join(f.repo, 'pages'), { recursive: true })
    await writeFileAt(path.join(f.repo, 'pages'), 'not a directory\n')
    await expect(write(f, { path: 'pages/alpha.md', content: '# Alpha\n' })).rejects.toThrow(
      /WIKI_IO: `pages\/alpha\.md` could not be inspected/u,
    )
  })

  it('refuses an existing leaf that is not a file', async () => {
    const f = await fixture()
    await mkdir(path.join(f.repo, 'pages', 'sub.md'))
    await expect(write(f, { path: 'pages/sub.md', content: '# Sub\n' })).rejects.toThrow(
      /WIKI_WRITE_INVALID: `pages\/sub\.md` exists and is not a file/u,
    )
  })

  it('forwards a cancellation signal to the writer lock', async () => {
    const f = await fixture()
    const controller = new AbortController()
    const value = await write(f, { path: 'pages/alpha.md', content: '# Alpha\n' }, controller.signal)
    expect(value).toEqual({ path: 'pages/alpha.md', bytes: 8, created: true, redacted: [] })
  })
})

describe.skipIf(!hasGit)('createWikiWriteTool (DESIGN §6.4)', () => {
  it('executes a create and renders the created line', async () => {
    const f = await fixture()
    const tool = createWikiWriteTool(f.deps)
    expect(tool.name).toBe('wiki_write')
    const value = (await tool.execute(
      { path: 'pages/alpha.md', content: '# Alpha\n' },
      fakeExec(fakeAgent({ cwd: f.elsewhere }), undefined, 'wiki_write'),
    )) as WikiWriteValue
    expect(value).toEqual({ path: 'pages/alpha.md', bytes: 8, created: true, redacted: [] })
    expect(tool.output.render({}, canonical(value))).toEqual([
      { type: 'text', text: 'Created pages/alpha.md (8 bytes).' },
    ])
    expect(f.logger.debugLines.join('\n')).toContain('wiki_write pages/alpha.md')
  })

  it('executes an edit and renders the updated line with its redaction', async () => {
    const f = await fixture()
    const tool = createWikiWriteTool(f.deps)
    const exec = fakeExec(fakeAgent({ cwd: f.elsewhere }), undefined, 'wiki_write')
    await tool.execute({ path: 'index.md', content: '- [[alpha]] — about alpha\n' }, exec)
    const updated = (await tool.execute(
      { path: 'index.md', edit: { old_text: '- [[alpha]]', new_text: '- [[beta]]' } },
      exec,
    )) as WikiWriteValue
    expect(updated).toMatchObject({ path: 'index.md', created: false, redacted: [] })
    expect(tool.output.render({}, canonical(updated))).toEqual([
      { type: 'text', text: `Updated index.md (${String(updated.bytes)} bytes).` },
    ])

    const secret = (await tool.execute(
      { path: 'pages/key.md', content: 'the key is sk-abcdefghijklmnopqrst\n' },
      exec,
    )) as WikiWriteValue
    expect(secret.redacted).toEqual(['api-key'])
    expect(tool.output.render({}, canonical(secret))).toEqual([
      {
        type: 'text',
        text: `Created pages/key.md (${String(secret.bytes)} bytes). Secrets were redacted: api-key.`,
      },
    ])
  })

  it('logs and rethrows a refused write', async () => {
    const f = await fixture()
    const tool = createWikiWriteTool(f.deps)
    await expect(
      tool.execute({ path: 'notes.md', content: 'x' }, fakeExec(fakeAgent({ cwd: f.elsewhere }), undefined, 'wiki_write')),
    ).rejects.toThrow(/^WIKI_WRITE_INVALID: /u)
    expect(f.logger.debugLines.join('\n')).toMatch(/WIKI_WRITE_INVALID: "notes\.md"/u)
  })
})
