/**
 * Fixtures shared by the dsh-memory suites: temporary directories under
 * `os.tmpdir()`, `$DSH_HOME` redirection, throwaway git repositories, fake
 * agents, and a recording logger.
 *
 * The suites use the **real** `@deepseek-ai/dsh-atomic-write` (a peer of this
 * package, installed for development): the lock, the temp-file rename, and the
 * `0600`/`0700` modes are part of what is under test, so a stand-in would prove
 * the wrong thing. Every directory lives under `os.tmpdir()`, and a suite that
 * needs a harness home sets `DSH_HOME` to one it created, so a developer's real
 * `~/.dsh` is never touched.
 * @module @anago-harness/memory/tests/support
 */

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { Message, ToolCallId, UserMessage } from '@deepseek-ai/dsh-llm'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { serializeDocument } from '@anago-harness/knowledge-common'
import type { MemoryAgent } from '../src/agents.ts'
import type { ApprovalPolicy, ApprovalServiceLike } from '../src/approval.ts'
import { Config, type MemoryConfig } from '../src/config.ts'
import type { MemoryLogger } from '../src/inject.ts'
import type { PendingOp } from '../src/pending.ts'
import type { ReviewAgent } from '../src/review-input.ts'

const tempDirs: string[] = []

/** One fresh directory under the OS temporary directory. */
export async function tempDir(prefix = 'dsh-memory-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Remove every directory this module created. Call from `afterAll`. */
export async function cleanupTempDirs(): Promise<void> {
  const dirs = tempDirs.splice(0)
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
}

/** A harness home for one test, with `$DSH_HOME` pointed at it. */
export interface DshHome {
  /** The directory that now plays `$DSH_HOME`. */
  readonly home: string
  /** Restore the previous environment value. */
  restore(): void
}

/** Redirect `$DSH_HOME` into a temporary directory. */
export async function useDshHome(): Promise<DshHome> {
  const home = await tempDir('dsh-home-')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return {
    home,
    restore: () => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    },
  }
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

/** Make a symlink to `target` and return its path. */
export async function linkTo(target: string, name = 'link'): Promise<string> {
  const dir = await tempDir('dsh-link-')
  const link = path.join(dir, name)
  await symlink(target, link, 'dir')
  return link
}

/** Write a store in the canonical format. */
export async function writeStoreFile(
  file: string,
  entries: readonly string[],
  header?: string,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, serializeDocument({ header: header ?? null, entries: [...entries] }), {
    mode: 0o600,
  })
}

/** Write raw bytes to a store path. */
export async function writeRawFile(file: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, content, { mode })
}

/** Read a store path as UTF-8. */
export async function readStoreFile(file: string): Promise<string> {
  return await readFile(file, 'utf8')
}

/** Whether a path exists. */
export async function exists(target: string): Promise<boolean> {
  try {
    await readFile(target)
    return true
  } catch {
    return false
  }
}

/** The memory store inside one harness home. */
export function memoryStorePath(home: string, target: 'memory' | 'user' = 'memory'): string {
  return path.join(home, 'memories', target === 'memory' ? 'MEMORY.md' : 'USER.md')
}

/** A fake agent whose derived history can be grown by the test. */
export interface FakeAgent extends MemoryAgent {
  /** Live derived history; push to simulate a committed message. */
  readonly history: Message[]
}

/** Build one fake agent. */
export function fakeAgent(options: {
  cwd?: string
  delegationDepth?: number
  agentPreset?: string
  history?: readonly Message[]
  id?: string
}): FakeAgent {
  const history = [...(options.history ?? [])]
  return {
    history,
    session: {
      id: options.id ?? 'session-memory-test',
      header: {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.delegationDepth === undefined ? {} : { delegationDepth: options.delegationDepth }),
        ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
      },
      deriveMessages: () => history,
    },
  }
}

/** A fake agent as the turn-end review reads one (DESIGN §4.7). */
export interface FakeReviewAgent extends ReviewAgent {
  /** Live derived history; push to simulate a committed message. */
  readonly history: Message[]
  /** The notices the review queued through `agent.inject`, in order. */
  readonly injected: UserMessage[]
  /** The events the review appended through `session.append`, in order. */
  readonly appended: { readonly type: string; readonly data: unknown }[]
}

/** Build one fake review agent. */
export function fakeReviewAgent(
  options: {
    id?: string
    cwd?: string
    delegationDepth?: number
    agentPreset?: string
    history?: readonly Message[]
    provider?: string
    model?: string
    headerRoute?: { readonly provider: string; readonly model: string }
    injectThrows?: boolean
  } = {},
): FakeReviewAgent {
  const history = [...(options.history ?? [])]
  const injected: UserMessage[] = []
  const appended: { readonly type: string; readonly data: unknown }[] = []
  return {
    history,
    injected,
    appended,
    options: {
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
    },
    session: {
      id: options.id ?? 'session-review-test',
      header: {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.delegationDepth === undefined ? {} : { delegationDepth: options.delegationDepth }),
        ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
      },
      deriveMessages: () => history,
      requestHeader: () =>
        options.headerRoute === undefined
          ? undefined
          : { config: { provider: options.headerRoute.provider, model: options.headerRoute.model } },
      append: (type, data) => {
        appended.push({ type, data })
        return undefined
      },
    },
    inject: (message) => {
      if (options.injectThrows === true) throw new Error('the agent is gone')
      injected.push(message)
    },
  }
}

/** A fake `ctx.agents` exposing the counted hold the plugin takes on a review. */
export interface FakeAgentRegistry {
  /**
   * Hold one live agent, counted like the real registry.
   * @param agent - the agent the plugin wants to keep alive.
   * @returns an idempotent disposable that releases this hold.
   * @throws when the test marked the agent disposed.
   */
  hold(agent: ReviewAgent): Disposable
  /**
   * Count the outstanding holds of one agent.
   * @param agent - the agent to inspect.
   * @returns the hold count, or zero for a disposed agent.
   */
  holds(agent: ReviewAgent): number
  /**
   * Mark one agent disposed; later holds throw and outstanding ones are dropped.
   * @param agent - the agent that left the registry.
   */
  dispose(agent: ReviewAgent): void
  /** Every agent whose hold was released through the returned disposable. */
  readonly released: ReviewAgent[]
}

/**
 * Build the fake registry.
 * @param onRelease - runs synchronously when a hold is released, so a suite can
 *   await a barrier instead of polling.
 * @returns the registry double.
 */
export function fakeAgentRegistry(onRelease?: (agent: ReviewAgent) => void): FakeAgentRegistry {
  const counts = new Map<ReviewAgent, number>()
  const disposed = new Set<ReviewAgent>()
  const released: ReviewAgent[] = []
  return {
    hold(agent) {
      if (disposed.has(agent)) {
        throw new Error(`agent "${agent.session.id ?? ''}" is not live and cannot be held`)
      }
      counts.set(agent, (counts.get(agent) ?? 0) + 1)
      let once = false
      return {
        [Symbol.dispose]: () => {
          if (once) return
          once = true
          // A disposed agent's entry is gone; the registry released the hold with it.
          if (disposed.has(agent)) return
          counts.set(agent, (counts.get(agent) ?? 1) - 1)
          released.push(agent)
          onRelease?.(agent)
        },
      }
    },
    holds(agent) {
      return disposed.has(agent) ? 0 : counts.get(agent) ?? 0
    },
    dispose(agent) {
      disposed.add(agent)
      counts.delete(agent)
    },
    released,
  }
}

/** One derived assistant message, as `deriveMessages()` carries it. */
export function assistantMessage(text: string): Message {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'test-provider', model: 'test-model' },
  })
}

/** One derived tool-result message. */
export function toolMessage(text: string): Message {
  return createToolResultMessage({
    callId: 'call-1' as ToolCallId,
    content: [{ type: 'text', text }],
    isError: false,
  })
}

/** A fake `ctx.approval`, with whatever policy the test wants to resolve. */
export function fakeApproval(service: {
  policy?: ApprovalPolicy
  override?: ApprovalPolicy
  throws?: boolean
}): ApprovalServiceLike {
  return {
    config: service.policy === undefined ? {} : { policy: service.policy },
    overrideOf: () => {
      if (service.throws === true) throw new Error('unreadable session log')
      return service.override
    },
  }
}

/** The pending root inside one harness home. */
export function pendingRootOf(home: string): string {
  return path.join(home, 'memories', 'pending')
}

/** Write one pending file the way the staging path does, for a test that needs a fixture. */
export async function writePendingFile(
  file: string,
  op: Record<string, unknown>,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const id = path.basename(file, '.json')
  await writeFile(file, `${JSON.stringify({ id, ...op }, null, 2)}\n`, { mode: 0o600 })
}

/** The pending file of one id inside a store's pending directory. */
export function pendingFile(directory: string, id: string): string {
  return path.join(directory, id)
}

/** A fully populated `PendingOp`, overridable per test. */
export function pendingOp(overrides: Partial<PendingOp> & { id: string }): PendingOp {
  return {
    createdAt: '2026-10-19T10:12:03.000Z',
    sessionId: 'session-memory-test',
    source: 'tool',
    target: 'memory',
    op: 'add',
    text: 'a staged note',
    ...overrides,
  }
}

/** A command invocation carrying one raw line. */
export function fakeInvocation(
  agent: MemoryAgent,
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

/** One plain user message. */
export function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** One memory-snapshot message, as the injection path produces it. */
export function snapshotMessage(text = '<memory-snapshot>\nold\n</memory-snapshot>'): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'memory', form: 'snapshot', sections: [{ name: 'global-memory', text }] },
  })
}

/**
 * Type one message double as a message.
 *
 * A case that exercises what the review does with content the model layer would
 * never produce still has to pass a message, so the double keeps only the
 * members under test.
 * @param value - the double.
 * @returns the same value, typed as the message.
 */
export function fakeMessage(value: object): Message {
  return value as Message
}

/** A logger that records what the plugin reported. */
export interface RecordingLogger extends MemoryLogger {
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
      index < args.length ? (typeof args[index] === 'string' ? (args[index++] as string) : JSON.stringify(args[index++])) : '',
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
export function memoryConfig(overrides: Record<string, unknown> = {}): MemoryConfig {
  return Config(overrides)
}

/**
 * A `ToolRunContext` stub carrying the fields the tool and the approval gate
 * read. The pipeline hands the **same object** to both (DESIGN §4.5), which is
 * what the gate's mark relies on, so a wiring test passes one instance to both.
 */
export function fakeExec(
  agent: MemoryAgent | undefined,
  signal?: AbortSignal,
  args: unknown = {},
): ToolRunContext {
  return fakeToolRunContext({
    callId: 'call-1',
    name: 'memory',
    arguments: args,
    agent,
    signal: signal ?? new AbortController().signal,
    deferContext: () => {},
    concludeTurn: () => {},
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

/** One listener a fake context stores; the waterfall and plain events share it. */
export type WiredListener = (payload: unknown, second?: unknown) => unknown
