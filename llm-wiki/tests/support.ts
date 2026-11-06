/**
 * Fixtures shared by the dsh-llm-wiki suites: temporary directories under
 * `os.tmpdir()`, throwaway git repositories, wiki scaffolds, fake agents, and a
 * recording logger.
 *
 * Every directory lives under `os.tmpdir()` and a suite that needs a harness
 * home sets `DSH_HOME` to one it created, so a developer's real `~/.dsh` is
 * never touched. Nothing here writes outside those directories.
 * @module @anago-harness/llm-wiki/tests/support
 */

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { Message } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { sha256Hex } from '@anago-harness/knowledge-common'
import type { WikiAgent } from '../src/agents.ts'
import { Config, type WikiConfig } from '../src/config.ts'
import {
  createGlobalWikiState,
  type GlobalWikiState,
  type GlobalWikiStateDeps,
} from '../src/global.ts'
import type { WikiLogger } from '../src/inject.ts'

const tempDirs: string[] = []

/** One fresh directory under the OS temporary directory. */
export async function tempDir(prefix = 'dsh-wiki-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Remove every directory this module created. Call from `afterAll`. */
export async function cleanupTempDirs(): Promise<void> {
  const dirs = tempDirs.splice(0)
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
}

/** Whether a usable `git` is on `PATH`; suites skip their git cases without one. */
export function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Run one git command in `dir` and return its stdout. */
export function git(dir: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: dir, encoding: 'utf8' })
}

/** Create a throwaway repository (or initialize one at `dir`). */
export async function initRepo(dir?: string): Promise<string> {
  const root = dir ?? (await tempDir('dsh-repo-'))
  git(root, ['init', '--quiet'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
  return root
}

/** Create a symlink to a directory target and return its path. */
export async function linkTo(target: string, name = 'link'): Promise<string> {
  const dir = await tempDir('dsh-wiki-link-')
  const link = path.join(dir, name)
  await symlink(target, link, 'dir')
  return link
}

/** Whether a path exists, file or directory. */
export async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/** Write a file, creating parents, at `0644`. */
export async function writeFileAt(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, { mode: 0o644 })
}

/** Read a file as UTF-8. */
export async function readAt(file: string): Promise<string> {
  return await readFile(file, 'utf8')
}

/** The wiki directory of one checkout root. */
export function wikiDir(root: string): string {
  return path.join(root, '.dsh', 'wiki')
}

/** The `raw` directory of one checkout root. */
export function rawDir(root: string): string {
  return path.join(wikiDir(root), 'raw')
}

/** One raw source's frontmatter and body. */
export interface RawSource {
  /** Repository-relative path, such as `raw/database/2026-10-19-pg.md`. */
  readonly relative: string
  /** The body the digest covers. */
  readonly body: string
  /** What to write as `sha256`; defaults to the body's real digest. */
  readonly digest?: string
  /** Extra frontmatter lines, inserted before the digest. */
  readonly extra?: readonly string[]
}

/** Render one raw source exactly as the convention describes. */
export function renderRawSource(source: RawSource): string {
  const digest = source.digest ?? sha256Hex(source.body)
  return [
    '---',
    'source_url: https://example.com/source',
    'retrieved_at: 2026-10-19',
    ...(source.extra ?? []),
    `sha256: ${digest}`,
    '---',
    source.body,
  ].join('\n')
}

/** Write one raw source below the wiki. */
export async function writeRawSource(root: string, source: RawSource): Promise<string> {
  const file = path.join(wikiDir(root), source.relative)
  await writeFileAt(file, renderRawSource(source))
  return file
}

/** One page's frontmatter and body. */
export interface PageFixture {
  /** The slug, i.e. the file name without `.md`. */
  readonly slug: string
  /** The page body; `null` writes a body derived from the slug. */
  readonly body?: string | null
  /** Extra frontmatter lines. */
  readonly extra?: readonly string[]
}

/** Write one page below the wiki. */
export async function writePage(root: string, page: PageFixture): Promise<string> {
  return await writePageAt(wikiDir(root), page)
}

/** Write one page into a wiki root (`<root>/pages/<slug>.md` by default). */
export async function writePageAt(
  wikiRoot: string,
  page: PageFixture,
  pagesDir = 'pages',
): Promise<string> {
  const file = path.join(wikiRoot, pagesDir, `${page.slug}.md`)
  const body = page.body ?? `# ${page.slug}\n\nBody of ${page.slug}.\n`
  await writeFileAt(
    file,
    [
      '---',
      `title: ${page.slug}`,
      'tags: [test]',
      'created: 2026-10-19',
      'updated: 2026-10-19',
      ...(page.extra ?? []),
      '---',
      body,
    ].join('\n'),
  )
  return file
}

/** Write `index.md` with one `- [[slug]] — summary` line per slug. */
export async function writeIndex(root: string, slugs: readonly string[]): Promise<void> {
  const body = slugs.map(slug => `- [[${slug}]] — about ${slug}`).join('\n')
  await writeFileAt(path.join(wikiDir(root), 'index.md'), `${body}\n`)
}

/** Write `index.md` into a wiki root (the global wiki's root is its repository top). */
export async function writeIndexAt(wikiRoot: string, slugs: readonly string[]): Promise<void> {
  const body = slugs.map(slug => `- [[${slug}]] — about ${slug}`).join('\n')
  await writeFileAt(path.join(wikiRoot, 'index.md'), `${body}\n`)
}

/** Write one page of the **global** wiki, whose root is the repository top. */
export async function writeGlobalPage(
  wikiRoot: string,
  page: PageFixture,
  pagesDir = 'pages',
): Promise<string> {
  return await writePageAt(wikiRoot, page, pagesDir)
}

/** Write the global wiki's `index.md`. */
export async function writeGlobalIndex(wikiRoot: string, slugs: readonly string[]): Promise<void> {
  await writeIndexAt(wikiRoot, slugs)
}

/** Write one `raw/` source of the **global** wiki (`relative` starts with `raw/`). */
export async function writeGlobalRawSource(wikiRoot: string, source: RawSource): Promise<string> {
  const file = path.join(wikiRoot, source.relative)
  await writeFileAt(file, renderRawSource(source))
  return file
}

/** Write `.dsh/wiki.yml`. */
export async function writeSettings(root: string, content: string): Promise<void> {
  await writeFileAt(path.join(root, '.dsh', 'wiki.yml'), content)
}

/** Write the minimum a wiki needs to be found: the `pages/` directory. */
export async function scaffoldWiki(root: string): Promise<string> {
  const dir = wikiDir(root)
  await mkdir(path.join(dir, 'pages'), { recursive: true })
  await mkdir(path.join(dir, 'raw'), { recursive: true })
  return dir
}

/** Add the managed `.gitignore` block `dsh-memory` would own (DESIGN §3.2). */
export async function writeGitignore(root: string, lines: readonly string[]): Promise<void> {
  const block = [
    '# >>> dsh-memory (managed by @tep-hardware/dsh-memory)',
    '.dsh/*',
    '!.dsh/wiki.yml',
    ...lines,
    '# <<< dsh-memory',
    '',
  ].join('\n')
  await writeFileAt(path.join(root, '.gitignore'), block)
}

/** A fake agent whose derived history can be grown by the test. */
export interface FakeAgent extends WikiAgent {
  /** Live derived history; push to simulate a committed message. */
  readonly history: Message[]
}

/** Build one fake agent. */
export function fakeAgent(options: {
  cwd?: string
  delegationDepth?: number
  agentPreset?: string
  history?: readonly Message[]
}): FakeAgent {
  const history = [...(options.history ?? [])]
  return {
    history,
    session: {
      id: 'session-wiki-test',
      header: {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.delegationDepth === undefined ? {} : { delegationDepth: options.delegationDepth }),
        ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
      },
      deriveMessages: () => history,
    },
  }
}

/** One plain user message. */
export function userMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** One wiki notice message, as the injection path produces it. */
export function noticeMessage(summary = 'LLM wiki: project 1 page.'): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text: summary }],
    source: { kind: 'llm-wiki', form: 'notice', summary },
  })
}

/** A logger that records what the plugin reported. */
export interface RecordingLogger extends WikiLogger {
  /** Warning-level lines, formatted with their arguments appended. */
  readonly warnings: string[]
  /** Debug-level lines. */
  readonly debugLines: string[]
}

/** Build a recording logger. */
export function recordingLogger(): RecordingLogger {
  const warnings: string[] = []
  const debugLines: string[] = []
  const line = (message: string, args: readonly unknown[]): string => {
    let index = 0
    return message.replace(/%[so]/gu, () =>
      index < args.length
        ? typeof args[index] === 'string'
          ? (args[index++] as string)
          : JSON.stringify(args[index++])
        : '',
    )
  }
  return {
    warnings,
    debugLines,
    warn: (message, ...args) => {
      warnings.push(line(message, args))
    },
    debug: (message, ...args) => {
      debugLines.push(line(message, args))
    },
  }
}

/** Resolved configuration with the schema's own defaults, overridable per test. */
export function wikiConfig(overrides: Record<string, unknown> = {}): WikiConfig {
  return Config(overrides)
}

/** A `ToolRunContext` stub carrying the two fields a tool body reads. */
export function fakeExec(
  agent: WikiAgent | undefined,
  signal?: AbortSignal,
  name = 'wiki_lint',
): ToolRunContext {
  return fakeToolRunContext({
    callId: 'call-1',
    name,
    arguments: {},
    agent,
    signal: signal ?? new AbortController().signal,
    deferContext: () => {},
    concludeTurn: () => {},
  })
}

/** A command invocation carrying one raw line. */
export function fakeInvocation(
  agent: WikiAgent,
  rawInput: string,
  signal?: AbortSignal,
): CommandInvocation {
  return fakeCommandInvocation({
    commandId: 'cmd-1',
    agent,
    rawInput,
    attachments: [],
    signal: signal ?? new AbortController().signal,
  })
}

/**
 * Type one hand-built double as the plugin context `apply` receives.
 *
 * A double carries only the members the code under test reads, so its parameter
 * is the widest object type rather than the whole interface.
 * @param value - the double.
 * @returns the same value, typed as the context.
 */
export function fakeContext(value: object): Context {
  return value as Context
}

/**
 * Type one hand-built double as a tool execution.
 * @param value - the double.
 * @returns the same value, typed as the execution.
 */
export function fakeToolRunContext(value: object): ToolRunContext {
  return value as ToolRunContext
}

/**
 * Type one hand-built double as a command invocation.
 * @param value - the double.
 * @returns the same value, typed as the invocation.
 */
export function fakeCommandInvocation(value: object): CommandInvocation {
  return value as CommandInvocation
}

/** A fake `ctx.approval`, with whatever policy the test wants to resolve. */
export function fakeApproval(service: {
  policy?: 'ask' | 'never'
  override?: 'ask' | 'never'
}): {
  overrideOf(session: unknown): 'ask' | 'never' | undefined
  readonly config: { readonly policy?: 'ask' | 'never' }
} {
  return {
    config: service.policy === undefined ? {} : { policy: service.policy },
    overrideOf: () => service.override,
  }
}

/** The `tools/pre-execute` execution shape the guard reads. */
export function fakeToolCall(
  toolName: string,
  args: unknown,
  agent?: WikiAgent,
): { name: string; arguments: unknown; agent?: unknown } {
  return { name: toolName, arguments: args, ...(agent === undefined ? {} : { agent }) }
}

/** Write the global wiki sidecar, as `/wiki repo set` and `repo unset` do. */
export async function writeSidecar(file: string, value: unknown): Promise<void> {
  await writeFileAt(file, `${JSON.stringify(value)}\n`)
}

/** Create a fresh repository to act as the global wiki (or a plain directory). */
export async function globalRepo(options: { init?: boolean } = {}): Promise<string> {
  const dir = await tempDir('dsh-global-')
  if (options.init !== false) return await initRepo(dir)
  return dir
}

/** The wiki skeleton at the top of a repository (DESIGN §6.4 check 6). */
export async function scaffoldGlobalRepo(root: string, pagesDir = 'pages'): Promise<string> {
  await mkdir(path.join(root, pagesDir), { recursive: true })
  await mkdir(path.join(root, 'raw'), { recursive: true })
  await writeFileAt(path.join(root, 'WIKI.md'), '# Global wiki\n')
  await writeFileAt(path.join(root, 'index.md'), '# Index\n')
  await writeFileAt(path.join(root, '.gitignore'), '*.lock\n')
  return root
}

/** A real global-wiki state whose sidecar and `$DSH_HOME` live in temp dirs. */
export interface TempGlobalState {
  /** The state under test. */
  readonly state: GlobalWikiState
  /** `$DSH_HOME/llm-wiki-state/repo.json` for this state. */
  readonly sidecarFile: string
  /** `$DSH_HOME/llm-wiki/repo.json`, the pre-migration location for this state. */
  readonly legacySidecarFile: string
  /** The temporary harness home. */
  readonly home: string
  /** What the state warned about. */
  readonly logger: RecordingLogger
}

/**
 * Build a real state with everything under `os.tmpdir()`.
 *
 * The current sidecar, the pre-migration path, and `dshHome` are passed
 * explicitly, so no test has to touch `process.env.DSH_HOME` and a developer's
 * real `~/.dsh` is never read or written — including by `/wiki repo set`, whose
 * sidecar write lives in the state, and by the legacy fallback, which would
 * otherwise resolve against the real home.
 */
export async function tempGlobalState(
  options: {
    profileRepo?: string
    /** Written to the current sidecar path, as `/wiki repo set` does. */
    sidecar?: unknown
    /** Written to the pre-migration path, as an older install did. */
    legacySidecar?: unknown
    run?: GlobalWikiStateDeps['run']
    /** `config.global.pagesDir`; `pages` when omitted. */
    pagesDir?: string
  } = {},
): Promise<TempGlobalState> {
  const home = await tempDir('dsh-home-')
  const sidecarFile = path.join(home, 'llm-wiki-state', 'repo.json')
  const legacySidecarFile = path.join(home, 'llm-wiki', 'repo.json')
  if (options.sidecar !== undefined) await writeSidecar(sidecarFile, options.sidecar)
  if (options.legacySidecar !== undefined) await writeSidecar(legacySidecarFile, options.legacySidecar)
  const logger = recordingLogger()
  const state = createGlobalWikiState({
    profileRepo: () => options.profileRepo ?? '',
    logger,
    sidecarFile,
    legacySidecarFile,
    dshHome: home,
    ...(options.pagesDir === undefined ? {} : { pagesDir: options.pagesDir }),
    ...(options.run === undefined ? {} : { run: options.run }),
  })
  return { state, sidecarFile, legacySidecarFile, home, logger }
}
