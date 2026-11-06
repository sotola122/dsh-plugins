/**
 * The existence notice suite (DESIGN §6.6, §10): the visibility test that keys
 * on `source.kind`, the truth table the listener follows (the same one
 * `dsh-memory`'s snapshot uses), the wording and its 120-character cut, and the
 * `notice: false` switch.
 *
 * The listener is exercised directly, so the suite needs a repository only for
 * the cases that expect a notice to exist.
 * @module @anago-harness/llm-wiki/tests/notice.spec
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { afterAll, describe, expect, it } from 'vitest'
import { injectNotice, isNoticeVisible, type PreStepPayload } from '../src/inject.ts'
import { composeNoticeSummary, createNoticeMessage, isNoticeMessage, NOTICE_MAX_LENGTH } from '../src/notice.ts'
import type { WikiInspection } from '../src/inspect.ts'
import {
  cleanupTempDirs,
  fakeAgent,
  gitAvailable,
  initRepo,
  noticeMessage,
  recordingLogger,
  scaffoldGlobalRepo,
  scaffoldWiki,
  tempGlobalState,
  userMessage,
  wikiConfig,
  writeGitignore,
  writeGlobalIndex,
  writeGlobalPage,
  writePage,
  writeSettings,
} from './support.ts'

const hasGit = gitAvailable()

afterAll(cleanupTempDirs)

/** A `found` inspection with the fields the notice reads. */
function inspection(overrides: Partial<Extract<WikiInspection, { kind: 'found' }>> = {}) {
  const root = {
    checkoutRoot: '/repo',
    wikiRoot: '/repo/.dsh/wiki',
    settingsFile: '/repo/.dsh/wiki.yml',
  }
  return {
    kind: 'found' as const,
    root,
    settings: { commit: false, warnings: [] },
    writable: true,
    ignore: { state: 'visible' as const, detail: null },
    warnings: [],
    ...overrides,
  }
}

/** One pre-step payload for a fake agent. */
function payloadFor(
  agent: ReturnType<typeof fakeAgent>,
  messages: readonly UserMessage[],
  step = 2,
): PreStepPayload {
  return {
    agent,
    messages,
    turn: 1,
    step,
    signal: new AbortController().signal,
  }
}

/** Run the injection with `next()` returning one enter decision. */
async function inject(
  payload: PreStepPayload,
  decisionMessages: UserMessage[],
  overrides: Record<string, unknown> = {},
  global?: Awaited<ReturnType<typeof tempGlobalState>>['state'],
) {
  const messages = [...decisionMessages]
  return await injectNotice(
    payload,
    { kind: 'enter', messages },
    {
      config: wikiConfig(overrides),
      logger: recordingLogger(),
      ...(global === undefined ? {} : { global }),
    },
  )
}

/**
 * A project wiki with a designated global wiki of `globalPages` pages.
 * @returns the repository, the global root, and the state to hand to `inject`.
 */
async function withGlobalWiki(globalPages: number) {
  const root = await initRepo()
  await scaffoldWiki(root)
  const global = await initRepo()
  await scaffoldGlobalRepo(global)
  const slugs: string[] = []
  for (let index = 0; index < globalPages; index += 1) {
    const slug = `shared-${String(index)}`
    await writeGlobalPage(global, { slug })
    slugs.push(slug)
  }
  await writeGlobalIndex(global, slugs)
  const { state } = await tempGlobalState({ sidecar: { path: global } })
  return { root, global, state }
}

describe('notice wording (DESIGN §6.6)', () => {
  it('says the project page count and stays under the 120-character cut', () => {
    const summary = composeNoticeSummary(7, true)
    expect(summary).toMatch(/^LLM wiki: project 7 pages\./u)
    expect(summary.length).toBeLessThanOrEqual(NOTICE_MAX_LENGTH)
  })

  it('adds (read-only) when the session is below the checkout root', () => {
    expect(composeNoticeSummary(1, false)).toMatch(/project 1 page \(read-only\)/u)
  })

  it('does not mention a global wiki while none exists', () => {
    expect(composeNoticeSummary(3, true)).not.toMatch(/global/u)
  })

  it('adds the global page count when one is designated (DESIGN §6.6)', () => {
    const summary = composeNoticeSummary(3, true, [], 5)
    expect(summary).toMatch(/^LLM wiki: project 3 pages, global 5 pages\./u)
    expect(summary.length).toBeLessThanOrEqual(NOTICE_MAX_LENGTH)
    expect(composeNoticeSummary(1, true, [], 1)).toMatch(/project 1 page, global 1 page\./u)
  })

  it('still fits the cut with a warning and a global count', () => {
    const summary = composeNoticeSummary(12, true, ['y'.repeat(200)], 34)
    expect(summary.length).toBe(NOTICE_MAX_LENGTH)
    expect(summary).toMatch(/global 34 pages/u)
  })

  it('carries the first warning and counts the rest, still under the cut', () => {
    const summary = composeNoticeSummary(2, true, ['warning one', 'warning two'])
    expect(summary).toMatch(/Warning: warning one \(\+1 more\)/u)
    expect(summary.length).toBeLessThanOrEqual(NOTICE_MAX_LENGTH)
  })

  it('cuts a long warning at the bound and strips its control characters', () => {
    const summary = composeNoticeSummary(1, true, [`${'x'.repeat(400)}\u0000\nmore`])
    expect(summary.length).toBe(NOTICE_MAX_LENGTH)
    expect(summary.endsWith('…')).toBe(true)
    expect(summary).not.toMatch(/[\u0000-\u001f]/u)
  })

  it('builds a message whose source declares this producer', () => {
    const message = createNoticeMessage(inspection(), 4)
    expect(message.source).toEqual({
      kind: 'llm-wiki',
      form: 'notice',
      summary: composeNoticeSummary(4, true),
    })
    expect(isNoticeMessage(message)).toBe(true)
    expect(message.role).toBe('user')
  })
})

describe('isNoticeVisible (DESIGN §6.6)', () => {
  it('does not count a memory snapshot or a plain message', () => {
    const agent = fakeAgent({})
    expect(isNoticeVisible(agent, [userMessage('hello')])).toBe(false)
    const memoryish = {
      role: 'user' as const,
      source: { kind: 'memory' },
    }
    expect(isNoticeVisible(agent, [memoryish])).toBe(false)
  })

  it('sees a notice in the batch about to be admitted', () => {
    expect(isNoticeVisible(fakeAgent({}), [noticeMessage()])).toBe(true)
  })

  it('sees a notice restored into the derived history by a resume', () => {
    const agent = fakeAgent({ history: [noticeMessage()] })
    expect(isNoticeVisible(agent, [])).toBe(true)
  })

  it('forgets a notice that compaction shadowed, so the next step re-injects it', () => {
    const agent = fakeAgent({ history: [noticeMessage()] })
    agent.history.length = 0
    expect(isNoticeVisible(agent, [])).toBe(false)
  })

  it('is false for a session that cannot derive its messages', () => {
    const agent = { session: { header: {} } }
    expect(isNoticeVisible(agent, [])).toBe(false)
  })
})

describe.skipIf(!hasGit)('injectNotice (DESIGN §6.6)', () => {
  it('inserts one notice after the last claimed message, before runtime context', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha' })
    const agent = fakeAgent({ cwd: root })
    const claimed = userMessage('what does the wiki say?')
    const runtime = userMessage('runtime context')
    const result = await inject(payloadFor(agent, [claimed]), [claimed, runtime])
    if (result.kind !== 'enter') throw new Error('unreachable')
    expect(result.messages).toHaveLength(3)
    expect(result.messages[1]?.source.kind).toBe('llm-wiki')
    expect(result.messages[0]).toBe(claimed)
    expect(result.messages[2]).toBe(runtime)
    const summary = (result.messages[1]?.source as { summary?: string }).summary ?? ''
    expect(summary).toMatch(/project 1 page\./u)
  })

  it('says nothing when a notice is already visible', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const agent = fakeAgent({ cwd: root, history: [noticeMessage()] })
    const claimed = userMessage('again')
    const result = await inject(payloadFor(agent, [claimed]), [claimed])
    if (result.kind !== 'enter') throw new Error('unreachable')
    expect(result.messages).toHaveLength(1)
  })

  it('says nothing for the step-1 batch with an empty claim', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const agent = fakeAgent({ cwd: root })
    const result = await inject(payloadFor(agent, [], 1), [userMessage('runtime only')])
    if (result.kind !== 'enter') throw new Error('unreachable')
    expect(result.messages).toHaveLength(1)
  })

  it('inserts on step 1 when the batch does claim a message', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const agent = fakeAgent({ cwd: root })
    const claimed = userMessage('first real message')
    const result = await inject(payloadFor(agent, [claimed], 1), [claimed])
    if (result.kind !== 'enter') throw new Error('unreachable')
    expect(result.messages).toHaveLength(2)
  })

  it('does not duplicate a notice that next() already produced', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const agent = fakeAgent({ cwd: root })
    const claimed = userMessage('hello')
    const existing = await (await import('../src/notice.ts')).noticeForInspection(
      inspection({ root: { checkoutRoot: root, wikiRoot: path.join(root, '.dsh', 'wiki'), settingsFile: '' } }),
    )
    if (existing === null) throw new Error('no notice built')
    const result = await inject(payloadFor(agent, [claimed]), [claimed, existing])
    if (result.kind !== 'enter') throw new Error('unreachable')
    expect(result.messages).toHaveLength(2)
  })

  it('leaves a rejected step alone', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const agent = fakeAgent({ cwd: root })
    const decision = await injectNotice(
      payloadFor(agent, [userMessage('x')]),
      { kind: 'reject' } as never,
      { config: wikiConfig(), logger: recordingLogger() },
    )
    expect(decision.kind).toBe('reject')
  })

  it('adds (read-only) for a session started below the checkout root', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const nested = path.join(root, 'packages', 'x')
    await mkdir(nested, { recursive: true })
    const claimed = userMessage('hello')
    const agent = fakeAgent({ cwd: nested })
    const result = await inject(payloadFor(agent, [claimed]), [claimed])
    if (result.kind !== 'enter') throw new Error('unreachable')
    expect(result.messages).toHaveLength(2)
    const summary = (result.messages[1]?.source as { summary?: string }).summary ?? ''
    expect(summary).toMatch(/read-only/u)
  })

  it('says nothing when the session has no wiki', async () => {
    const root = await initRepo()
    const claimed = userMessage('hello')
    const result = await inject(payloadFor(fakeAgent({ cwd: root }), [claimed]), [claimed])
    if (result.kind !== 'enter') throw new Error('unreachable')
    expect(result.messages).toHaveLength(1)
  })

  it('respects notice: false', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const claimed = userMessage('hello')
    const result = await inject(payloadFor(fakeAgent({ cwd: root }), [claimed]), [claimed], { notice: false })
    if (result.kind !== 'enter') throw new Error('unreachable')
    expect(result.messages).toHaveLength(1)
  })

  it('warns in the notice when the ignore state disagrees with commit: true', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writeSettings(root, 'commit: true\n')
    const claimed = userMessage('hello')
    const result = await inject(payloadFor(fakeAgent({ cwd: root }), [claimed]), [claimed])
    if (result.kind !== 'enter') throw new Error('unreachable')
    expect((result.messages[1]?.source as { summary?: string }).summary).toMatch(/Warning:/u)
  })

  it('carries the global page count when a repository is designated', async () => {
    const { root, state } = await withGlobalWiki(3)
    const claimed = userMessage('hello')
    const result = await inject(payloadFor(fakeAgent({ cwd: root }), [claimed]), [claimed], {}, state)
    if (result.kind !== 'enter') throw new Error('unreachable')
    const summary = (result.messages[1]?.source as { summary?: string }).summary ?? ''
    expect(summary).toMatch(/project 0 pages, global 3 pages/u)
  })

  it('leaves the global count out while no repository is designated', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    const { state } = await tempGlobalState()
    const claimed = userMessage('hello')
    const result = await inject(payloadFor(fakeAgent({ cwd: root }), [claimed]), [claimed], {}, state)
    if (result.kind !== 'enter') throw new Error('unreachable')
    const summary = (result.messages[1]?.source as { summary?: string }).summary ?? ''
    expect(summary).not.toMatch(/global/u)
  })

  it('leaves the global count out when the repository overlaps the session cwd', async () => {
    const global = await initRepo()
    await scaffoldGlobalRepo(global)
    await writeGlobalPage(global, { slug: 'shared' })
    await writeGlobalIndex(global, ['shared'])
    const { state } = await tempGlobalState({ sidecar: { path: global } })
    // The session runs inside the repository, so the global wiki is disabled
    // for it — and a project wiki below the same root still gets its notice.
    const nested = path.join(global, 'project')
    await mkdir(nested, { recursive: true })
    await scaffoldWiki(global)
    const claimed = userMessage('hello')
    const result = await inject(payloadFor(fakeAgent({ cwd: nested }), [claimed]), [claimed], {}, state)
    if (result.kind !== 'enter') throw new Error('unreachable')
    const summary = (result.messages[1]?.source as { summary?: string }).summary ?? ''
    expect(summary).toMatch(/project/u)
    expect(summary).not.toMatch(/global/u)
  })

  it('says nothing extra when the wiki is ignored as a private wiki expects', async () => {
    const root = await initRepo()
    await scaffoldWiki(root)
    await writeGitignore(root, [])
    const claimed = userMessage('hello')
    const result = await inject(payloadFor(fakeAgent({ cwd: root }), [claimed]), [claimed])
    if (result.kind !== 'enter') throw new Error('unreachable')
    const summary = (result.messages[1]?.source as { summary?: string }).summary ?? ''
    expect(summary).not.toMatch(/Warning:/u)
  })
})

describe('the listener never ends a turn (S8)', () => {
  it('returns the decision unchanged when the injection throws', async () => {
    const { createNoticeListener } = await import('../src/inject.ts')
    const logger = recordingLogger()
    const listener = createNoticeListener({ config: wikiConfig(), logger })
    const claimed = userMessage('hello')
    const agent = {
      session: {
        header: { cwd: '/nonexistent' },
        deriveMessages: () => {
          throw new Error('surface unavailable')
        },
      },
    } as never
    const decision = { kind: 'enter' as const, messages: [claimed] }
    const result = await listener(
      { agent, messages: [claimed], turn: 1, step: 2, signal: new AbortController().signal },
      async () => decision,
    )
    expect(result).toBe(decision)
    expect(logger.warnings.join('\n')).toMatch(/could not be injected/u)
  })
})
