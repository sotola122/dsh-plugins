/**
 * Plugin-entry suite: metadata, the config schema's defaults, the
 * registrations `apply` performs, and the skill body that ships as `SKILL.md`
 * (DESIGN §6.1, §6.5, §6.6, §11 orders 3 and 6).
 * @module @anago-harness/llm-wiki/tests/plugin.spec
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterAll, describe, expect, it } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'
import { DEFAULT_MAX_PAGE_BYTES, DEFAULT_MAX_RAW_BYTES } from '../src/config.ts'
import { WIKI_SEARCH_TOOL_NAME } from '../src/search-tool.ts'
import { createSkillRegistration, loadSkillBody, SKILL_NAME, stripFrontmatter } from '../src/skill.ts'
import { WIKI_LINT_TOOL_NAME } from '../src/tool.ts'
import { WIKI_WRITE_TOOL_NAME } from '../src/write.ts'
import { cleanupTempDirs, fakeAgent, fakeContext, fakeInvocation, wikiConfig } from './support.ts'

afterAll(cleanupTempDirs)

interface Harness {
  readonly ctx: Context
  readonly registered: ToolDefinition[]
  readonly skills: SkillRegistration[]
  readonly commands: CommandDefinition[]
  readonly listeners: Map<string, (payload: unknown, next?: () => Promise<unknown>) => unknown>
  /** How many listeners a name has; `apply` registers two for `tools/pre-execute`. */
  listenerCount(name: string): number
}

/** A fake context with the registries `apply` touches. */
function createHarness(): Harness {
  const registered: ToolDefinition[] = []
  const skills: SkillRegistration[] = []
  const commands: CommandDefinition[] = []
  const listeners = new Map<string, (payload: unknown, next?: () => Promise<unknown>) => unknown>()
  const counts = new Map<string, number>()
  const ctx = fakeContext({
    tools: {
      register: (definition: ToolDefinition) => {
        registered.push(definition)
        return () => {}
      },
    },
    skills: {
      register: (skill: SkillRegistration) => {
        skills.push(skill)
        return () => {}
      },
    },
    commands: {
      register: (definition: CommandDefinition) => {
        commands.push(definition)
        return () => {}
      },
    },
    logger: { warn: () => {}, debug: () => {} },
    on: (event: string, listener: (payload: unknown, next?: () => Promise<unknown>) => unknown) => {
      listeners.set(event, listener)
      counts.set(event, (counts.get(event) ?? 0) + 1)
      return () => {}
    },
    get: () => undefined,
  })
  return {
    ctx,
    registered,
    skills,
    commands,
    listeners,
    listenerCount: (name: string) => counts.get(name) ?? 0,
  }
}

describe('plugin metadata', () => {
  it('declares its loader name and required services', () => {
    expect(name).toBe('llm-wiki')
    expect(inject).toEqual(['tools', 'skills', 'commands'])
  })
})

describe('Config schema (DESIGN §6.6)', () => {
  it('defaults every field to the design value', () => {
    const config = Config({}) as ReturnType<typeof wikiConfig>
    expect(config.notice).toBe(true)
    expect(config.global.repo).toBe('')
    expect(config.global.pagesDir).toBe('pages')
    expect(config.writeApproval).toBe('none')
    expect(config.write).toEqual({
      maxPageBytes: DEFAULT_MAX_PAGE_BYTES,
      maxRawBytes: DEFAULT_MAX_RAW_BYTES,
    })
    expect(config.search).toEqual({
      maxPages: 5000,
      maxPageBytes: 65_536,
      maxPostingBytes: 67_108_864,
    })
    expect(config.lint).toEqual({ checks: ['links', 'index', 'raw'] })
  })

  it('accepts a lint.checks subset, in the order the checks run', () => {
    expect(Config({ lint: { checks: ['raw'] } } as never).lint.checks).toEqual(['raw'])
    expect(Config({ lint: { checks: ['index'] } } as never).lint.checks).toEqual(['index'])
    const duplicated = Config({ lint: { checks: ['raw', 'links', 'raw'] } } as never)
    expect(duplicated.lint.checks).toEqual(['links', 'raw'])
  })

  it('rejects an empty lint.checks and an unknown check at load time', () => {
    expect(() => Config({ lint: { checks: [] } })).toThrow(/array length >= 1/u)
    expect(() => Config({ lint: { checks: ['bogus'] } } as never)).toThrow(/expected "links"/u)
  })

  it('has no guardRaw key: raw protection is not switchable (§6.6)', () => {
    const config = Config({ guardRaw: false }) as Record<string, unknown>
    expect(config.guardRaw).toBe(false)
    // The schema does not define it, so nothing in the plugin reads it.
    expect(Object.keys(wikiConfig())).not.toContain('guardRaw')
  })

  it('accepts the keys a Profile may carry', () => {
    const config = Config({
      global: { repo: '/tmp/some-repo' },
      writeApproval: 'ask',
      write: { maxPageBytes: 1024 },
      search: { maxPages: 10 },
    } as never) as ReturnType<typeof wikiConfig>
    expect(config.global.repo).toBe('/tmp/some-repo')
    expect(config.writeApproval).toBe('ask')
    expect(config.write.maxPageBytes).toBe(1024)
    expect(config.write.maxRawBytes).toBe(DEFAULT_MAX_RAW_BYTES)
    expect(config.search.maxPages).toBe(10)
  })

  it('rejects a writeApproval the design does not define', () => {
    expect(() => Config({ writeApproval: 'sometimes' } as never)).toThrow(/expected/u)
  })
})

describe('apply (DESIGN §6.1)', () => {
  it('registers the three tools, the /wiki command, the listeners, and the skill', () => {
    const harness = createHarness()
    apply(harness.ctx, wikiConfig())
    expect(harness.registered.map(tool => tool.name)).toEqual([
      WIKI_LINT_TOOL_NAME,
      WIKI_SEARCH_TOOL_NAME,
      WIKI_WRITE_TOOL_NAME,
    ])
    // Two `tools/pre-execute` registrations: the raw guard (with the global
    // deny) and the approval gate. The harness keeps the last one per name.
    expect([...harness.listeners.keys()].sort()).toEqual([
      'agent/created',
      'agent/pre-step',
      'tools/pre-execute',
    ])
    expect(harness.listenerCount('tools/pre-execute')).toBe(2)
    expect(harness.listenerCount('agent/created')).toBe(1)
    expect(harness.skills.map(skill => skill.name)).toEqual([SKILL_NAME])
    expect(harness.commands.map(command => command.name)).toEqual(['wiki'])
    expect(harness.commands[0]?.input?.hint).toContain('status')
  })

  it('wires /wiki to the plugin configuration', async () => {
    const harness = createHarness()
    apply(harness.ctx, wikiConfig())
    const handler = harness.commands[0]?.handler
    if (handler === undefined) throw new Error('no command handler')
    // No cwd on the fake agent, so the command reports it rather than throwing.
    const result = await handler(fakeInvocation(fakeAgent({}), 'status'))
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' ? result.text : '').toMatch(/no working directory/u)
  })

  it('resolves the global wiki for a new agent without ever throwing (S6)', async () => {
    const harness = createHarness()
    apply(harness.ctx, wikiConfig({ global: { repo: '/tmp/dsh-no-such-wiki-repo' } }))
    const listener = harness.listeners.get('agent/created')
    if (listener === undefined) throw new Error('no agent/created listener')
    expect(() => listener({ agent: fakeAgent({ cwd: '/tmp' }) })).not.toThrow()
    // The resolution is asynchronous; let it settle so a rejection would surface.
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  it('routes repo and commit through /wiki instead of refusing them', async () => {
    const harness = createHarness()
    apply(harness.ctx, wikiConfig())
    const handler = harness.commands[0]?.handler
    if (handler === undefined) throw new Error('no command handler')
    const repo = await handler(fakeInvocation(fakeAgent({}), 'repo everywhere'))
    expect(repo.kind).toBe('error')
    expect(repo.kind === 'error' ? repo.text : '').toMatch(/repo needs/u)
    expect(repo.kind === 'error' ? repo.text : '').not.toMatch(/not implemented yet/u)
    // `reindex` is implemented now: without a cwd it reports both wikis rather
    // than refusing, and it never throws.
    const reindex = await handler(fakeInvocation(fakeAgent({}), 'reindex'))
    expect(reindex.kind).toBe('success')
    expect(reindex.kind === 'success' ? reindex.text : '').toContain('project wiki: skipped')
  })

  it('registers the skill with a body that keeps its convention', () => {
    const harness = createHarness()
    apply(harness.ctx, wikiConfig())
    const skill = harness.skills[0]
    expect(skill?.source).toBe('runtime')
    expect(skill?.description).toMatch(/\.dsh\/wiki/u)
    expect(skill?.whenToUse).toMatch(/ingest/u)
    expect(skill?.content).toContain('raw/<topic>/<YYYY-MM-DD>-<source>.md')
    expect(skill?.content).toContain('[[global:slug]]')
    expect(skill?.content).toContain('wiki_lint')
    expect(skill?.content).toContain('wiki_write')
    expect(skill?.content).toContain('/wiki commit')
    expect(skill?.content).toContain('wiki_search')
    expect(skill?.content).not.toContain('name: llm-wiki')
  })

  it('wires the pre-execute policy to the raw guard', async () => {
    const harness = createHarness()
    apply(harness.ctx, wikiConfig())
    const listener = harness.listeners.get('tools/pre-execute')
    if (listener === undefined) throw new Error('no pre-execute listener')
    // No agent means no cwd, so the policy passes the call through.
    const decision = (await listener({ name: 'write', arguments: { file_path: '/x' } }, async () => ({
      kind: 'allow',
    }))) as { kind: string }
    expect(decision.kind).toBe('allow')
  })
})

describe('SKILL.md', () => {
  const file = fileURLToPath(new URL('../SKILL.md', import.meta.url))

  it('is readable, has the skill name in its frontmatter, and a body', () => {
    const text = readFileSync(file, 'utf8')
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toMatch(/^name: llm-wiki$/mu)
    expect(text).toMatch(/^description: /mu)
    expect(text).toMatch(/^whenToUse: /mu)
    const body = stripFrontmatter(text)
    expect(body.startsWith('# LLM wiki')).toBe(true)
    expect(body).not.toContain('---\nname: llm-wiki')
  })

  it('is what loadSkillBody returns for the module that ships it', () => {
    const body = loadSkillBody(import.meta.url)
    expect(body).toBe(stripFrontmatter(readFileSync(file, 'utf8')))
    expect(body.length).toBeGreaterThan(500)
  })

  it('carries the conventions the design delegates to the skill (§6.2, §6.6)', () => {
    const body = loadSkillBody(import.meta.url)
    // frontmatter fields of a page and of a raw source
    for (const field of ['title', 'aliases', 'tags', 'created', 'updated', 'sources']) {
      expect(body).toContain(field)
    }
    for (const field of ['source_url', 'retrieved_at', 'sha256']) {
      expect(body).toContain(field)
    }
    // the link grammar, the ingest order, immutability, and the index shape
    expect(body).toContain('[[slug]]')
    expect(body).toContain('[[global:slug]]')
    expect(body).toContain('immutable')
    expect(body).toContain('- [[postgres-migration]] — ')
    // the judgement the checker leaves to the model
    for (const word of ['Orphans', 'Duplicates', 'Staleness', 'Truth']) {
      expect(body).toContain(word)
    }
    // the read-only and commit wording the design asks the skill to carry
    expect(body).toContain('read-only')
    expect(body).toContain('commit: true')
  })

  it('creates the registration from the same text', () => {
    const registration = createSkillRegistration(import.meta.url)
    const body = loadSkillBody(import.meta.url)
    expect(registration.content).toBe(body)
    expect(registration.name).toBe(SKILL_NAME)
  })
})
