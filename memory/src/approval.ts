/**
 * `writeApproval: ask` — the pre-execute policy and the staged-execution mark
 * (DESIGN §4.5, S16, S21).
 *
 * With `writeApproval: 'none'` (the default) this module is inert. With
 * `'ask'`, every `memory` call that carries at least one operation is decided
 * by the **session's effective policy**:
 *
 * | effective policy | `tools/pre-execute` returns | what the tool body does |
 * | --- | --- | --- |
 * | `ask` | `{kind:'ask', reason, displayReason}` | writes normally once the user allows it |
 * | `never` | `allow` | writes nothing: every operation is staged under `$DSH_HOME/memories/pending/` |
 *
 * **Why the mark is a `WeakMap` (a `WeakSet` here) and not a policy re-read.**
 * `PreToolDecision`'s `allow` carries no field to say "stage this one"
 * (`$P/dsh-tools/lib/types/index.d.ts:445-459`), and the tool body cannot
 * recover the information by itself: after an approved `ask` the session's
 * policy is still `ask`, so a re-read cannot distinguish "approved, write it"
 * from "nobody can approve this, stage it". The registry, however, hands
 * **the same execution object** to the pre-execute waterfall and to
 * `tool.execute(args, exec)` (`$P/dsh-tools/lib/index.js:3321,3406`), so the
 * listener can mark exactly the executions it allowed under `never`. The mark
 * is never consumed: an around-dispatch retry re-enters the tool body with the
 * same object, and it must stay staged rather than slip through unapproved.
 *
 * The gate skeleton, the policy vocabulary, and the resolver live in
 * `@anago-harness/knowledge-common`; this module keeps the memory-specific
 * predicate, prompt, and staging mark.
 * @module @anago-harness/memory/approval
 */

import type { PreToolDecision, ToolExecution, ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import {
  createApprovalGate,
  type ApprovalPrompt,
  type ApprovalServiceLike,
  resolveEffectivePolicy,
} from '@anago-harness/knowledge-common'
import type { MemoryConfig } from './config.ts'
import type { MemoryLogger } from './inject.ts'
import { MEMORY_TOOL_NAME } from './tool.ts'

export { resolveEffectivePolicy }
export type { ApprovalPolicy, ApprovalPrompt, ApprovalServiceLike } from '@anago-harness/knowledge-common'

/**
 * Whether one pending call is a `memory` write: the tool name matches and the
 * argument carries at least one operation. A read (`operations` omitted or
 * empty) is never asked about, and never staged (DESIGN §4.5).
 * @param exec - the call about to run.
 * @returns true when the call changes a store.
 */
export function isMemoryWriteCall(exec: {
  readonly name: string
  readonly arguments: unknown
}): boolean {
  if (exec.name !== MEMORY_TOOL_NAME) return false
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return false
  const operations = (args as { readonly operations?: unknown }).operations
  return Array.isArray(operations) && operations.length > 0
}

/**
 * Build the prompt for one call (DESIGN §4.5).
 * @param exec - the `memory` call; its `target` store and `operations` count are
 * what the prompt names.
 * @returns the audited reason and the English and Japanese prompt text.
 */
export function approvalPrompt(exec: {
  readonly arguments: unknown
}): ApprovalPrompt {
  const args = exec.arguments as { readonly target?: unknown; readonly operations?: unknown }
  const target = typeof args.target === 'string' ? args.target : 'memory'
  const count = Array.isArray(args.operations) ? args.operations.length : 0
  const plural = count === 1 ? 'operation' : 'operations'
  return {
    reason: `the memory tool wants to apply ${String(count)} ${plural} to the '${target}' store, and this session's approval policy is ask`,
    displayReason: {
      en: `Allow the model to write ${String(count)} ${plural} to the persistent memory store '${target}'?`,
      ja: `メモリ（${target}）へ ${String(count)} 件の操作を書き込んでよいですか？`,
    },
  }
}

/** The gate the plugin registers on `tools/pre-execute` and the tool consults. */
export interface MemoryApprovalGate {
  /**
   * Whether this exact execution was allowed under the `never` policy.
   * @param exec - the execution the tool body received.
   * @returns true when the call must stage its operations instead of writing.
   */
  wasStaged(exec: unknown): boolean
  /**
   * The `tools/pre-execute` listener (DESIGN §4.5).
   * @param exec - the call about to run.
   * @param next - the rest of the policy chain.
   * @returns the chain's decision, or an `ask` when this plugin asks.
   */
  decide(
    exec: ToolExecution | ToolExecutionInput,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision>
}

/** Everything {@link createMemoryApprovalGate} needs. */
export interface MemoryApprovalDeps {
  /** Resolved plugin configuration (`writeApproval` decides whether it acts). */
  readonly config: MemoryConfig
  /** Where recoverable problems go. */
  readonly logger: MemoryLogger
  /**
   * The approval service, resolved per call: the service may be registered
   * after this plugin, so the lookup is deferred rather than captured.
   */
  readonly approval?: () => ApprovalServiceLike | undefined
}

/**
 * Build the gate (DESIGN §4.5).
 *
 * The shared skeleton owns the chain order and the policy read; this plugin
 * supplies the tool name, its write predicate, its prompt, and the staging mark
 * the tool consults.
 * @param deps - configuration, logger, and the approval-service lookup.
 * @returns the listener and the staged-execution test the tool uses.
 */
export function createMemoryApprovalGate(deps: MemoryApprovalDeps): MemoryApprovalGate {
  const staged = new WeakSet<object>()
  const gate = createApprovalGate<PreToolDecision>({
    toolName: MEMORY_TOOL_NAME,
    isWrite: isMemoryWriteCall,
    asks: () => deps.config.writeApproval === 'ask',
    prompt: approvalPrompt,
    onNever(call) {
      staged.add(call)
      deps.logger.debug(
        'dsh-memory: the approval policy is never, so this memory call is staged instead of written',
      )
    },
    approval: deps.approval,
  })
  return {
    wasStaged: (exec: unknown): boolean =>
      typeof exec === 'object' && exec !== null && staged.has(exec),
    decide: (exec, next) => gate.decide(exec, next),
  }
}
