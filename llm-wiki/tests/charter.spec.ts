/**
 * The global wiki's charter (DESIGN §6.4): which file is recognized, what the
 * skeleton writes, and what `/wiki status` says.
 *
 * A repository may already keep its agent instructions in `AGENTS.md` — the
 * user's `~/.dsh/llm-wiki` does — and then that file is the charter. The plugin
 * must not create a second one beside it, so the skeleton writes `WIKI.md` only
 * when neither exists. The template follows `global.pagesDir`, because a wiki
 * whose pages live under `concepts/` must not be told to write `pages/`.
 *
 * Every directory comes from `os.tmpdir()` and the sidecar and `$DSH_HOME` are
 * passed to the state explicitly, so a developer's real `~/.dsh` is never read
 * or written.
 * @module @anago-harness/llm-wiki/tests/charter.spec
 */
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runWikiCommand } from '../src/command.ts'
import { ensureGlobalSkeleton, findGlobalCharter, globalCharterTemplate } from '../src/global.ts'
import { WIKI_AGENTS_FILE, WIKI_CHARTER_FILE } from '../src/paths.ts'
import { createWikiSearchIndex } from '../src/search.ts'
import { wikiWriteDescription } from '../src/write.ts'
import {
  cleanupTempDirs,
  exists,
  fakeAgent,
  fakeInvocation,
  gitAvailable,
  initRepo,
  readAt,
  recordingLogger,
  tempDir,
  tempGlobalState,
  wikiConfig,
  writeFileAt,
} from './support.ts'

const hasGit = gitAvailable()
afterAll(cleanupTempDirs)

/** Write a file at the top of a temporary repository. */
async function writeAt(root: string, name: string, content: string): Promise<void> {
  await writeFileAt(path.join(root, name), content)
}

describe('findGlobalCharter (DESIGN §6.4)', () => {
  it('prefers AGENTS.md, falls back to WIKI.md, and reports none', async () => {
    const repo = await tempDir('dsh-charter-')
    expect(await findGlobalCharter(repo)).toBeNull()
    await writeAt(repo, WIKI_CHARTER_FILE, '# Wiki\n')
    expect(await findGlobalCharter(repo)).toBe(WIKI_CHARTER_FILE)
    await writeAt(repo, WIKI_AGENTS_FILE, '# Agents\n')
    expect(await findGlobalCharter(repo)).toBe(WIKI_AGENTS_FILE)
  })
})

describe('ensureGlobalSkeleton and the charter (DESIGN §6.4 check 6)', () => {
  it('does not create WIKI.md when AGENTS.md is the repository charter', async () => {
    const repo = await tempDir('dsh-charter-')
    await writeAt(repo, WIKI_AGENTS_FILE, '# Agents\n')
    const first = await ensureGlobalSkeleton({
      repoRoot: repo,
      source: 'sidecar',
      needsInit: false,
    })
    expect(first.charter).toBe(WIKI_AGENTS_FILE)
    expect(first.created).not.toContain(path.join(repo, WIKI_CHARTER_FILE))
    expect(await exists(path.join(repo, WIKI_CHARTER_FILE))).toBe(false)
    expect(await readAt(path.join(repo, WIKI_AGENTS_FILE))).toBe('# Agents\n')
    // The rest of the skeleton is unchanged, index.md included.
    expect(await exists(path.join(repo, 'index.md'))).toBe(true)
    expect(await exists(path.join(repo, 'pages'))).toBe(true)
    expect(await exists(path.join(repo, 'raw'))).toBe(true)
    // A second call is still a no-op, and still reports AGENTS.md.
    const second = await ensureGlobalSkeleton({
      repoRoot: repo,
      source: 'sidecar',
      needsInit: false,
    })
    expect(second.created).toEqual([])
    expect(second.charter).toBe(WIKI_AGENTS_FILE)
  })

  it('creates WIKI.md when neither AGENTS.md nor WIKI.md exists', async () => {
    const repo = await tempDir('dsh-charter-')
    const result = await ensureGlobalSkeleton({
      repoRoot: repo,
      source: 'sidecar',
      needsInit: false,
    })
    expect(result.charter).toBe(WIKI_CHARTER_FILE)
    expect(result.created).toContain(path.join(repo, WIKI_CHARTER_FILE))
    const charter = await readAt(path.join(repo, WIKI_CHARTER_FILE))
    expect(charter).toContain('`pages/<slug>.md`')
    expect(await exists(path.join(repo, WIKI_AGENTS_FILE))).toBe(false)
  })

  it('keeps a WIKI.md a person wrote and does not add AGENTS.md', async () => {
    const repo = await tempDir('dsh-charter-')
    await writeAt(repo, WIKI_CHARTER_FILE, '# Mine\n')
    const result = await ensureGlobalSkeleton({
      repoRoot: repo,
      source: 'sidecar',
      needsInit: false,
    })
    expect(result.charter).toBe(WIKI_CHARTER_FILE)
    expect(result.created).not.toContain(path.join(repo, WIKI_CHARTER_FILE))
    expect(await readAt(path.join(repo, WIKI_CHARTER_FILE))).toBe('# Mine\n')
    expect(await exists(path.join(repo, WIKI_AGENTS_FILE))).toBe(false)
  })

  it('reflects global.pagesDir in the template it writes', async () => {
    const repo = await tempDir('dsh-charter-')
    await ensureGlobalSkeleton(
      { repoRoot: repo, source: 'sidecar', needsInit: false },
      { pagesDir: 'concepts' },
    )
    const charter = await readAt(path.join(repo, WIKI_CHARTER_FILE))
    expect(charter).toContain('`concepts/<slug>.md`')
    expect(charter).not.toContain('pages/')
  })

  it('renders the template for the requested directory and refuses a bad one', () => {
    expect(globalCharterTemplate()).toContain('`pages/<slug>.md`')
    expect(globalCharterTemplate('concepts')).toContain('`concepts/<slug>.md`')
    expect(() => globalCharterTemplate('..')).toThrow(/not a usable page directory/u)
  })
})

describe('the guidance names the charter without hard-coding it (DESIGN §6.4)', () => {
  it('tells the model to read the charter, SCHEMA.md, and index.md before writing', () => {
    const description = wikiWriteDescription('concepts')
    expect(description).toContain('AGENTS.md when it exists, otherwise WIKI.md')
    expect(description).toContain('SCHEMA.md')
    expect(description).toContain('index.md')
    expect(description).toContain('Never add a second charter')
    expect(description).toContain('concepts/<slug>.md')
  })
})

describe.skipIf(!hasGit)('/wiki status names the charter (DESIGN §6.6)', () => {
  /** Run `status` against a designated repository that is outside the session's cwd. */
  async function statusOf(global: string): Promise<string> {
    const elsewhere = await initRepo()
    const { state } = await tempGlobalState({ sidecar: { path: global } })
    const config = wikiConfig()
    const logger = recordingLogger()
    const result = await runWikiCommand(fakeInvocation(fakeAgent({ cwd: elsewhere }), 'status'), {
      config,
      logger,
      global: state,
      search: createWikiSearchIndex({ config, logger }),
    })
    return result.text ?? ''
  }

  it('reports AGENTS.md when the repository has one', async () => {
    const global = await initRepo()
    await writeAt(global, WIKI_AGENTS_FILE, '# Agents\n')
    const text = await statusOf(global)
    expect(text).toContain(`charter: ${WIKI_AGENTS_FILE}`)
  })

  it('reports WIKI.md when that is the only charter', async () => {
    const global = await initRepo()
    await writeAt(global, WIKI_CHARTER_FILE, '# Wiki\n')
    const text = await statusOf(global)
    expect(text).toContain(`charter: ${WIKI_CHARTER_FILE}`)
  })

  it('prefers AGENTS.md when both files exist', async () => {
    const global = await initRepo()
    await writeAt(global, WIKI_AGENTS_FILE, '# Agents\n')
    await writeAt(global, WIKI_CHARTER_FILE, '# Wiki\n')
    const text = await statusOf(global)
    expect(text).toContain(`charter: ${WIKI_AGENTS_FILE}`)
  })

  it('says none when neither file exists', async () => {
    const global = await initRepo()
    const text = await statusOf(global)
    expect(text).toContain('charter: none')
    expect(text).toContain('neither AGENTS.md nor WIKI.md')
  })
})
