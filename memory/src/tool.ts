/**
 * The `memory` tool (DESIGN §4.1, §4.5).
 *
 * The tool is the only writer this plugin owns. It resolves one of three
 * stores, runs DESIGN §5.1's preconditions for the workspace one, and applies
 * the whole batch under the store's writer lock: a refused entry, a duplicate,
 * an ambiguous `old_text`, or an over-limit result means **nothing is written**.
 *
 * One alternative path exists: when the approval gate marked this execution as
 * staged (the session's effective policy is `never` under `writeApproval:
 * ask`, §4.5), the batch is validated exactly as a write would be and then
 * recorded under `$DSH_HOME/memories/pending/` instead. The result then carries
 * `status: 'staged'` and the pending ids, and nothing in the store changes
 * until a person approves each operation with `/memory approve`.
 *
 * Failures are thrown, so the model receives DSH's `Error: <message>` result
 * starting with the stable code (S8). The tool's own body never writes a
 * partial file, and it never touches the `.gitignore` outside
 * {@link ensureWorkspaceWritable} — which the staged path does not call,
 * because staging writes nothing outside the pending directory.
 * @module @anago-harness/memory/tool
 */

import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AtomicWriteApi } from '@anago-harness/knowledge-common'
import { cwdOf, delegationDepthOf, type MemoryAgent, presetOf } from './agents.ts'
import { isPresetExcluded, type MemoryConfig } from './config.ts'
import {
  formatCount,
  MAX_OPERATIONS,
  type MemoryOperation,
  parseOperations,
  type ReviewSuggestion,
} from './entries.ts'
import { describeError, memoryError } from './errors.ts'
import type { MemoryLogger } from './inject.ts'
import {
  globalPendingDirectory,
  stageOperations,
  workspacePendingDirectory,
  workspacePendingKey,
} from './pending.ts'
import {
  charsOf,
  globalStore,
  readStore,
  type MemoryTarget,
  type StoreLocation,
  updateStore,
  workspaceLocation,
} from './store.ts'
import {
  ensureWorkspaceWritable,
  inspectWorkspace,
  syncGitignoreBlock,
  workspaceUnavailableError,
  type WorkspaceInspection,
} from './workspace.ts'

/** Model-facing tool name; also the name the child restriction denies (DESIGN §4.4). */
export const MEMORY_TOOL_NAME = 'memory'

/** The canonical value `memory` returns (DESIGN §4.1). */
export interface MemoryToolValue {
  /** Which store was addressed. */
  readonly target: MemoryTarget
  /** `applied` when the write landed; `staged` when it waits for approval (DESIGN §4.5). */
  readonly status: 'applied' | 'staged'
  /** The resulting code-point count; for a staged batch, the store's current one. */
  readonly chars: number
  /** The store's limit. */
  readonly limit: number
  /** The complete resulting entry list; unchanged for a staged batch. */
  readonly entries: string[]
  /** The texts this call added, replaced, or removed, in operation order. */
  readonly applied: string[]
  /** The pending ids of a staged batch, in operation order (DESIGN §4.5). */
  readonly staged?: string[]
  /** Secret kinds replaced by `[REDACTED:<kind>]`. */
  readonly redacted: string[]
  /** Present only when a written entry exceeds the non-ASCII advisory. */
  readonly review?: {
    /** The advisory code (DESIGN §4.1). */
    readonly code: 'MEMORY_REVIEW_SUGGESTED'
    /** The entries to audit. */
    readonly entries: ReviewSuggestion[]
  }
  /** When the model will see this write (DESIGN §4.2). */
  readonly visibleFrom: 'next-snapshot'
}

/** Everything the tool needs from the plugin. */
export interface MemoryToolDeps {
  /** Resolved plugin configuration. */
  readonly config: MemoryConfig
  /** Where recoverable problems go. */
  readonly logger: MemoryLogger
  /** `withFileLock` and `writeFileAtomic` from `@deepseek-ai/dsh-atomic-write`. */
  readonly api: AtomicWriteApi
  /**
   * Whether the approval gate marked this exact execution as staged
   * (DESIGN §4.5). Absent means nothing is ever staged, which is the
   * `writeApproval: none` deployment and every direct tool invocation in a test.
   */
  readonly isStaged?: (exec: unknown) => boolean
}

/** The model-facing contract of one call. */
interface MemoryArgs {
  /** Which store to address. */
  readonly target: MemoryTarget
  /** The batch; omitted or empty reads the store. */
  readonly operations?: readonly MemoryOperation[]
}

/**
 * The tool description: what each target is for, what must not be written, how
 * a batch behaves, when a write becomes visible, and what staging means
 * (DESIGN §4.1, §4.5).
 */
export const MEMORY_DESCRIPTION = [
  'Persistent notes that survive across sessions. Use it to keep stable facts worth re-reading later: user preferences, environment details, project conventions, and corrections that are not derivable from the repository.',
  "target 'memory' is your own note file; 'user' is the user profile (who they are, how they want to work); 'workspace' is this repository's notes, kept out of git and available only inside a git worktree.",
  'Never write secrets or credentials, work-in-progress state, facts the repository or the conversation already show, or instructions about which language to answer in. Write in English, self-contained, one fact per entry. Use [[slug]] links only when a wiki exists.',
  'operations holds up to 8 add/patch/remove operations applied together: if one fails, nothing is written. add appends text; patch and remove select an entry by old_text, which must appear exactly once in exactly one entry — patch replaces it there, remove deletes that whole entry. Omit operations (or pass []) to read the current entries.',
  'The result reports the entry count against the limit (memory 2200, user 1375, workspace 2200 chars). Past the limit nothing is written, so consolidate in ONE call. Rejected content fails the call; secrets are stored as [REDACTED:<kind>]. A write appears in the next session snapshot, never mid-turn.',
  "When this deployment asks for approval and the session's policy refuses every prompt, the call reports status 'staged' with pending ids instead of writing: tell the user to run /memory pending (to read them) and /memory approve <id> (to apply them). Nothing was written yet.",
].join('\n\n')

/** A store location together with where its staged operations would go. */
interface ResolvedStore {
  /** The store itself. */
  readonly location: StoreLocation
  /** The pending directory a staged batch of this store belongs in. */
  readonly pending: string
}

/** A target resolved without touching the working tree. */
type TargetResolution =
  | {
    /** A global store, ready to use. */
    readonly kind: 'global'
    /** The store itself. */
    readonly location: StoreLocation
    /** The pending directory a staged batch of this store belongs in. */
    readonly pending: string
  }
  | {
    /** The workspace store, with §5.1's preconditions already run. */
    readonly kind: 'workspace'
    /** The inspection both write paths continue from. */
    readonly inspection: WorkspaceInspection
  }

/**
 * Resolve the target without touching the working tree: the two global stores
 * directly, or the workspace preconditions both write paths continue from.
 * @param target - the store the call addresses.
 * @param agent - the calling agent, whose cwd resolves the workspace store.
 * @param exec - this call's context, supplying cancellation.
 * @param deps - resolved configuration and the atomic-write seam.
 * @returns the global store, or the workspace inspection.
 * @throws MemoryError `MEMORY_NO_WORKSPACE` when the session recorded no cwd.
 */
async function resolveTarget(
  target: MemoryTarget,
  agent: MemoryAgent,
  exec: ToolRunContext,
  deps: MemoryToolDeps,
): Promise<TargetResolution> {
  const limits = deps.config.limits
  if (target === 'memory') {
    return {
      kind: 'global',
      location: globalStore('memory', limits.memory),
      pending: globalPendingDirectory('memory'),
    }
  }
  if (target === 'user') {
    return {
      kind: 'global',
      location: globalStore('user', limits.user),
      pending: globalPendingDirectory('user'),
    }
  }
  const cwd = cwdOf(agent)
  if (cwd === undefined) {
    throw memoryError(
      'MEMORY_NO_WORKSPACE',
      'the session recorded no working directory, so there is no git worktree to resolve',
    )
  }
  return {
    kind: 'workspace',
    inspection: await inspectWorkspace({
      cwd,
      enabled: deps.config.workspace.enabled,
      signal: exec.signal,
    }),
  }
}

/**
 * Resolve the store one call addresses. A real write may add the managed
 * `.gitignore` block; a staged batch must not (DESIGN §4.5).
 *
 * Staging writes only the pending file, so it must not create the block: that
 * write belongs to the first real write, which is the approval (U3). Reading the
 * store still needs §5.1's preconditions, and a repository the block could never
 * make writable is refused here rather than staged into an operation that can
 * never be approved.
 * @param target - the store the call addresses.
 * @param agent - the calling agent, whose cwd resolves the workspace store.
 * @param exec - this call's context, supplying cancellation.
 * @param deps - resolved configuration and the atomic-write seam.
 * @param staging - true for a staged batch, false for a real write.
 * @returns the store and its pending directory.
 * @throws MemoryError `MEMORY_NO_WORKSPACE` when the session recorded no cwd,
 *   or the workspace error when the store cannot be written or staged.
 */
async function resolveLocation(
  target: MemoryTarget,
  agent: MemoryAgent,
  exec: ToolRunContext,
  deps: MemoryToolDeps,
  staging: boolean,
): Promise<ResolvedStore> {
  const resolved = await resolveTarget(target, agent, exec, deps)
  if (resolved.kind === 'global') {
    return { location: resolved.location, pending: resolved.pending }
  }
  const inspection = resolved.inspection
  if (!staging) {
    const store = await ensureWorkspaceWritable(inspection, {
      api: deps.api,
      manageGitignore: deps.config.workspace.manageGitignore,
      lockWaitMs: deps.config.lockWaitMs,
      signal: exec.signal,
    })
    return {
      location: workspaceLocation(store, deps.config.limits.workspace),
      pending: workspacePendingDirectory(workspacePendingKey(store.root)),
    }
  }
  if (inspection.kind === 'unavailable') {
    throw workspaceUnavailableError(inspection.reason, inspection.detail)
  }
  if (!deps.config.workspace.manageGitignore) {
    // Never writes: it only reports, or refuses when the path is not ignored.
    await syncGitignoreBlock(inspection, {
      api: deps.api,
      manageGitignore: false,
      lockWaitMs: deps.config.lockWaitMs,
      signal: exec.signal,
    })
  }
  return {
    location: workspaceLocation(inspection.store, deps.config.limits.workspace),
    pending: workspacePendingDirectory(workspacePendingKey(inspection.store.root)),
  }
}

/**
 * Read the `target` argument. It arrives as model-supplied JSON, so the declared
 * {@link MemoryTarget} type is an assertion until this check accepts it.
 * @param value - the raw argument.
 * @returns the validated store target.
 * @throws MemoryError `MEMORY_INVALID_OPERATION` for anything else.
 */
function readTarget(value: unknown): MemoryTarget {
  if (value !== 'memory' && value !== 'user' && value !== 'workspace') {
    throw memoryError('MEMORY_INVALID_OPERATION', 'target must be memory, user, or workspace')
  }
  return value
}

/**
 * Run one accepted call (DESIGN §4.1, §4.5).
 *
 * Reading is a first-class call: with no operations the tool returns the
 * current entries and the usage, so the model can plan a `patch` without a
 * separate mechanism.
 * @param args - validated arguments.
 * @param exec - execution identity, caller, and cancellation.
 * @param deps - configuration, logger, and the atomic-write seam.
 * @returns the canonical value declared by the tool's output schema.
 * @throws MemoryError for every documented refusal, and a plain `Error` when no
 * agent is calling (a nested call outside an agent has no store to address).
 */
export async function executeMemoryTool(
  args: MemoryArgs,
  exec: ToolRunContext,
  deps: MemoryToolDeps,
): Promise<MemoryToolValue> {
  const agent: MemoryAgent | undefined = exec.agent
  if (agent === undefined) {
    throw new Error(`${MEMORY_TOOL_NAME} requires a calling agent (no session to address)`)
  }
  if (delegationDepthOf(agent) > 0) {
    throw memoryError(
      'MEMORY_READ_ONLY',
      'a subagent may read the workspace notes but never write them; report the finding to the parent instead',
    )
  }
  if (isPresetExcluded(deps.config, presetOf(agent))) {
    throw memoryError(
      'MEMORY_DISABLED',
      'this session\'s agent preset is listed in presets.exclude, so the memory tool is disabled here',
    )
  }
  const target = readTarget(args.target)
  const operations = parseOperations(args.operations)
  // A read never asks for approval and is never staged (DESIGN §4.5).
  const staged = operations.length > 0 && deps.isStaged?.(exec) === true
  const resolved = await resolveLocation(target, agent, exec, deps, staged)
  const read = await readStore(resolved.location)
  if (operations.length === 0) {
    return {
      target: resolved.location.target,
      status: 'applied',
      chars: charsOf(read.document),
      limit: resolved.location.limit,
      entries: [...read.document.entries],
      applied: [],
      redacted: [],
      visibleFrom: 'next-snapshot',
    }
  }
  // A marked call never writes: the gate marked it precisely because nothing
  // can approve an ask in this session (DESIGN §4.5).
  if (staged) {
    const outcome = await stageOperations({
      target: resolved.location.target,
      directory: resolved.pending,
      sessionId: agent.session.id ?? '',
      source: 'tool',
      operations,
      document: read.document,
      limit: resolved.location.limit,
      maxPerStore: deps.config.pending.maxPerStore,
    })
    return {
      target: resolved.location.target,
      status: 'staged',
      chars: charsOf(read.document),
      limit: resolved.location.limit,
      entries: [...read.document.entries],
      applied: [],
      staged: outcome.ids,
      redacted: outcome.redacted,
      visibleFrom: 'next-snapshot',
    }
  }
  const update = await updateStore(resolved.location, operations, {
    api: deps.api,
    lockWaitMs: deps.config.lockWaitMs,
    signal: exec.signal,
  })
  return {
    target: resolved.location.target,
    status: 'applied',
    chars: update.chars,
    limit: resolved.location.limit,
    entries: update.entries,
    applied: update.applied,
    redacted: update.redacted,
    ...(update.review.length === 0
      ? {}
      : { review: { code: 'MEMORY_REVIEW_SUGGESTED' as const, entries: update.review } }),
    visibleFrom: 'next-snapshot',
  }
}

/**
 * Render one result for the model: the usage line, the entries, and any
 * advisory. The canonical value stays the tool's contract; this is its
 * presentation.
 * @param value - the accepted result.
 * @returns the model-facing text.
 */
export function renderMemoryResult(value: MemoryToolValue): string {
  const percent = value.limit <= 0 ? 100 : Math.round((value.chars / value.limit) * 100)
  const lines = [
    `memory ${value.target}: ${value.status} — ${formatCount(value.chars)}/${formatCount(value.limit)} chars (${String(percent)}%)`,
  ]
  if (value.applied.length > 0) {
    lines.push(`changed: ${String(value.applied.length)} entr${value.applied.length === 1 ? 'y' : 'ies'}`)
  }
  if (value.entries.length === 0) {
    lines.push('entries: (none)')
  } else {
    lines.push('entries:')
    for (const [index, entry] of value.entries.entries()) {
      lines.push(`${String(index + 1)}. ${entry}`)
    }
  }
  if (value.redacted.length > 0) {
    lines.push(`redacted: ${value.redacted.join(', ')}`)
  }
  if (value.review !== undefined) {
    const list = value.review.entries
      .map(entry => `${String(entry.index)} (${String(Math.round(entry.ratio * 100))}% non-ASCII)`)
      .join(', ')
    lines.push(
      `MEMORY_REVIEW_SUGGESTED: the notes are read by future sessions in English; audit entr${value.review.entries.length === 1 ? 'y' : 'ies'} ${list}`,
    )
  }
  if (value.status === 'staged') {
    const ids = value.staged ?? []
    lines.push(
      `staged: ${String(ids.length)} pending operation(s), nothing written — ${ids.join(', ')}`,
    )
    lines.push(
      'Nothing was written: this session cannot ask for approval, so the user must apply them with /memory approve <id> (or read them with /memory pending, and drop them with /memory reject <id>).',
    )
    return lines.join('\n')
  }
  lines.push('Visible from the next snapshot; the running session keeps the snapshot it started with.')
  return lines.join('\n')
}

/**
 * Build the registry-ready tool (DESIGN §4.1).
 * @param deps - configuration, logger, and the atomic-write seam.
 * @returns the definition `ctx.tools.register` accepts.
 */
export function createMemoryTool(deps: MemoryToolDeps): ToolDefinition {
  return defineTool({
    name: MEMORY_TOOL_NAME,
    description: MEMORY_DESCRIPTION,
    parameters: {
      target: {
        type: 'string',
        enum: ['memory', 'user', 'workspace'],
        required: true,
        description:
          "Which store to address: 'memory' for your global notes, 'user' for the user profile, 'workspace' for this repository's notes (git worktrees only).",
      },
      operations: {
        type: 'array',
        description: `Up to ${String(MAX_OPERATIONS)} add/patch/remove operations, applied together; omit or pass [] to read the store.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op: {
              type: 'string',
              enum: ['add', 'patch', 'remove'],
              required: true,
              description: 'add appends text; patch replaces old_text; remove deletes the entry holding old_text.',
            },
            text: {
              type: 'string',
              description: 'The new entry text; required for add and patch.',
            },
            old_text: {
              type: 'string',
              description: 'Text that must appear exactly once in exactly one entry; required for patch and remove.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: {
            type: 'string',
            enum: ['memory', 'user', 'workspace'],
            required: true,
            description: 'The store that was addressed.',
          },
          status: {
            type: 'string',
            enum: ['applied', 'staged'],
            required: true,
            description: 'Whether the write landed or was staged for approval.',
          },
          chars: { type: 'integer', required: true, description: 'Code points now stored.' },
          limit: { type: 'integer', required: true, description: 'The store limit in code points.' },
          entries: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: 'The complete resulting entry list.',
          },
          applied: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: 'The texts this call added, replaced, or removed.',
          },
          redacted: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: 'Secret kinds replaced by [REDACTED:<kind>].',
          },
          review: {
            type: 'object',
            additionalProperties: false,
            description: 'Present when a written entry is mostly non-ASCII.',
            properties: {
              code: { type: 'string', const: 'MEMORY_REVIEW_SUGGESTED', required: true },
              entries: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    index: { type: 'integer', required: true },
                    ratio: { type: 'number', required: true },
                    text: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          staged: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Pending ids of a staged batch, in operation order; present only when status is staged (DESIGN §4.5).',
          },
          visibleFrom: {
            type: 'string',
            const: 'next-snapshot',
            required: true,
            description: 'When the model will see this write.',
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderMemoryResult(value as MemoryToolValue) }],
    },
    async execute(args, exec) {
      try {
        return await executeMemoryTool(args as MemoryArgs, exec, deps)
      } catch (error) {
        deps.logger.debug('dsh-memory: %s', describeError(error))
        throw error
      }
    },
  })
}
