/**
 * Plugin configuration (DESIGN §4.4, sixth revision).
 *
 * The schema is the current §4.4 one: `unifyGitWorktrees` and
 * `nonAsciiWarnRatio` are gone (worktrees are always unified, the non-ASCII
 * advisory is fixed at `0.1`), and the route of the turn-end review is the
 * conversation's rather than a setting.
 *
 * `writeApproval` and `pending` are the staged-write path of DESIGN §4.5: with
 * `writeApproval: ask`, a `memory` call is asked about when the session can be
 * prompted and staged under `$DSH_HOME/memories/pending/` when it cannot.
 * `review` is the turn-end review of DESIGN §4.7 — enabled by default (U1),
 * always staged (U2) — and every key here is live: `enabled` switches it off,
 * `everyTurns` and `maxRunsPerSession` bound when it runs, `maxInputBytes`,
 * `maxOutputTokens`, and `timeoutMs` bound one call, and `includeHeadless`
 * admits a headless run.
 * @module @anago-harness/memory/config
 */

import z from '@deepseek-ai/schemastery'

/** Default `MEMORY.md` limit in code points (hermes parity, DESIGN §4.3). */
export const DEFAULT_MEMORY_LIMIT = 2200

/** Default `USER.md` limit in code points (hermes parity, DESIGN §4.3). */
export const DEFAULT_USER_LIMIT = 1375

/** Default workspace `MEMORY.md` limit in code points (this design's value). */
export const DEFAULT_WORKSPACE_LIMIT = 2200

/** Default writer-lock budget in milliseconds (DESIGN §4.4). */
export const DEFAULT_LOCK_WAIT_MS = 5000

/** Per-store character limits (DESIGN §4.3). */
export interface MemoryLimits {
  /** `$DSH_HOME/memories/MEMORY.md`. */
  readonly memory: number
  /** `$DSH_HOME/memories/USER.md`. */
  readonly user: number
  /** `<projectRoot>/.dsh/memory/MEMORY.md`. */
  readonly workspace: number
}

/** Workspace store switches (DESIGN §4.4, §5.1). */
export interface WorkspaceConfig {
  /** Whether the workspace store exists at all; `false` is a global-memory-only deployment. */
  readonly enabled: boolean
  /** Whether the plugin writes the managed `.gitignore` block before its first write (N1). */
  readonly manageGitignore: boolean
}

/** Agent-preset filter (DESIGN §4.4). */
export interface PresetsConfig {
  /** Preset ids excluded from injection, the `memory` tool, and the turn-end review. */
  readonly exclude: readonly string[]
}

/** Staged-write bound (DESIGN §4.5). */
export interface PendingConfig {
  /** Maximum pending files per store. */
  readonly maxPerStore: number
}

/** Turn-end review settings (DESIGN §4.7). */
export interface ReviewConfig {
  /** Whether the review runs at all; the design default is enabled (U1). */
  readonly enabled: boolean
  /** Completed turns accumulated before one review. */
  readonly everyTurns: number
  /** Attempts per session, failures included. */
  readonly maxRunsPerSession: number
  /** Cap on the transcript excerpt sent to the auxiliary call. */
  readonly maxInputBytes: number
  /** Cap on the review's output tokens. */
  readonly maxOutputTokens: number
  /** Abort budget for one review call. */
  readonly timeoutMs: number
  /** Whether a headless run lets the review run; the design default is no. */
  readonly includeHeadless: boolean
}

/** Resolved plugin configuration (DESIGN §4.4). */
export interface MemoryConfig {
  /** Per-store code-point limits. */
  readonly limits: MemoryLimits
  /** Workspace store switches. */
  readonly workspace: WorkspaceConfig
  /** Preset filter applied to injection, the tool, and the review. */
  readonly presets: PresetsConfig
  /** Write-approval mode (DESIGN §4.5): `ask` enables the prompt and the staged path. */
  readonly writeApproval: 'none' | 'ask'
  /** Staged-write bound (DESIGN §4.5). */
  readonly pending: PendingConfig
  /** Turn-end review (DESIGN §4.7). */
  readonly review: ReviewConfig
  /** Writer-lock budget in milliseconds. */
  readonly lockWaitMs: number
}

/**
 * The plugin config schema. Every default is the design's default, so an empty
 * `config:` block is a fully working deployment.
 */
export const Config = z.object({
  limits: z.object({
    memory: z.number().default(DEFAULT_MEMORY_LIMIT),
    user: z.number().default(DEFAULT_USER_LIMIT),
    workspace: z.number().default(DEFAULT_WORKSPACE_LIMIT),
  }),
  workspace: z.object({
    enabled: z.boolean().default(true),
    manageGitignore: z.boolean().default(true),
  }),
  presets: z.object({
    exclude: z.array(z.string()).default([]),
  }),
  writeApproval: z.union(['none', 'ask']).default('none'),
  pending: z.object({
    maxPerStore: z.number().default(50),
  }),
  review: z.object({
    enabled: z.boolean().default(true),
    everyTurns: z.number().default(5),
    maxRunsPerSession: z.number().default(4),
    maxInputBytes: z.number().default(16384),
    maxOutputTokens: z.number().default(1024),
    timeoutMs: z.number().default(60_000),
    includeHeadless: z.boolean().default(false),
  }),
  lockWaitMs: z.number().default(DEFAULT_LOCK_WAIT_MS),
})

/**
 * Whether one session's agent preset is excluded (DESIGN §4.4). The default
 * `[]` keeps every preset — `minimal` included — in scope.
 * @param config - resolved plugin configuration.
 * @param preset - the session's recorded preset id, when it has one.
 * @returns true when injection, the tool, and the review must stay out.
 */
export function isPresetExcluded(config: MemoryConfig, preset: string | undefined): boolean {
  if (preset === undefined) return false
  return config.presets.exclude.includes(preset)
}
