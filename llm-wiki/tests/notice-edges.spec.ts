/**
 * Notice edge suite (DESIGN §6.6, S14): the summary's fallback for a `warnings`
 * list whose first entry is missing, and `noticeForInspection`'s two answers —
 * no wiki to announce, and a `found` inspection whose page count is measured
 * from its own root.
 *
 * The page count comes from the real wiki root, so the found cases build the
 * inspection around a directory this suite wrote.
 * @module @anago-harness/llm-wiki/tests/notice-edges.spec
 */
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { WikiInspection } from '../src/inspect.ts'
import { composeNoticeSummary, noticeForInspection } from '../src/notice.ts'
import { cleanupTempDirs, scaffoldWiki, tempDir, wikiDir, writePage } from './support.ts'

afterAll(cleanupTempDirs)

type FoundInspection = Extract<WikiInspection, { kind: 'found' }>

/** A `found` inspection around one wiki root; only `wikiRoot` reaches the count. */
function foundAt(wikiRoot: string): FoundInspection {
  return {
    kind: 'found',
    root: { checkoutRoot: path.dirname(wikiRoot), wikiRoot, settingsFile: '' },
    settings: { commit: false, warnings: [] },
    writable: true,
    ignore: { state: 'visible', detail: null },
    warnings: [],
  }
}

describe('composeNoticeSummary without a first warning (DESIGN §6.6)', () => {
  it('renders the warning slot empty instead of "undefined"', () => {
    // A findings list is a plain array; an empty first slot must not become the
    // word "undefined" in the line a model reads.
    const warnings: string[] = []
    warnings.length = 1
    const summary = composeNoticeSummary(1, true, warnings)
    expect(summary).toContain('Warning:')
    expect(summary).not.toContain('undefined')
  })
})

describe('noticeForInspection (DESIGN §6.6)', () => {
  it('reports nothing for an absent inspection', async () => {
    expect(await noticeForInspection({ kind: 'absent', detail: 'there is no wiki at /repo/.dsh/wiki' })).toBeNull()
  })

  it('measures the page count from the inspection root', async () => {
    const root = await tempDir('dsh-wiki-notice-')
    await scaffoldWiki(root)
    await writePage(root, { slug: 'alpha' })
    await writePage(root, { slug: 'beta' })
    const message = await noticeForInspection(foundAt(wikiDir(root)))
    if (message === null) throw new Error('expected a notice')
    expect((message.source as { summary?: string }).summary).toMatch(/^LLM wiki: project 2 pages\./u)
  })

  it('reports zero pages when the page directory is gone', async () => {
    const root = await tempDir('dsh-wiki-notice-')
    const message = await noticeForInspection(foundAt(wikiDir(root)))
    if (message === null) throw new Error('expected a notice')
    expect((message.source as { summary?: string }).summary).toMatch(/^LLM wiki: project 0 pages\./u)
  })
})
