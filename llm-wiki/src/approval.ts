/**
 * The session's effective approval policy and `wiki_write`'s ask
 * (DESIGN §6.4, D2; S16, S21).
 *
 * `WikiConfig.writeApproval` is **its own** switch — the memory plugin's
 * `writeApproval` is not consulted — and it only says whether `wiki_write` asks
 * at all. Whether an ask can be answered is the session's policy, which lives in
 * `@deepseek-ai/dsh-user-approval`: `overrideOf(session) ?? config.policy`.
 *
 * | `writeApproval` | effective policy | `tools/pre-execute` | result |
 * | --- | --- | --- | --- |
 * | `none` (default) | either | the downstream decision, unchanged | the tool writes directly |
 * | `ask` | `ask` | `{kind:'ask', reason, displayReason}` | the tool writes once the user allows it |
 * | `ask` | `never` | `{kind:'deny', reason}` with `WIKI_APPROVAL_UNAVAILABLE` | nothing is written and nothing is staged (D2) |
 *
 * **Nothing is staged.** The design gives the wiki no pending store, so an ask
 * that cannot be answered must not fall back to an unapproved write: the
 * environment where `writeApproval: ask` and the effective policy `never`
 * coincide is exactly the environment where nobody can be asked. The gate
 * therefore refuses instead of writing, and the message names the two ways out
 * — enable approval, or choose `writeApproval: none`.
 *
 * The gate skeleton, the policy vocabulary, and the resolver live in
 * `@anago-harness/knowledge-common`; this module keeps the wiki predicate, the
 * child refusal, and its messages.
 * @module @anago-harness/llm-wiki/approval
 */

import type { PreToolDecision, ToolExecution, ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import {
  createApprovalGate,
  resolveEffectivePolicy,
  type ApprovalPolicy,
  type ApprovalPrompt,
  type ApprovalServiceLike,
} from '@anago-harness/knowledge-common'
import { delegationDepthOf, type WikiAgent } from './agents.ts'
import type { WikiConfig } from './config.ts'
import { wikiError } from './errors.ts'
import { WIKI_WRITE_TOOL_NAME } from './write.ts'

export { resolveEffectivePolicy }
export type { ApprovalPolicy, ApprovalPrompt, ApprovalServiceLike } from '@anago-harness/knowledge-common'

/**
 * The sentence `/wiki status` prints for the two policies (DESIGN §6.4, D2).
 * @param writeApproval - the plugin's own switch.
 * @param policy - the session's effective policy.
 * @returns one paragraph of plain text.
 */
export function describeWriteApproval(
  writeApproval: 'none' | 'ask',
  policy: ApprovalPolicy,
): string {
  if (writeApproval === 'none') {
    return 'writeApproval: none — wiki_write writes directly, without asking, and nothing is staged (DESIGN §6.4, D2).'
  }
  return policy === 'never'
    ? 'writeApproval: ask — this session cannot be prompted (the effective policy is never), so wiki_write refuses the write with WIKI_APPROVAL_UNAVAILABLE; enable approval for this session or set writeApproval: none to write without asking (DESIGN §6.4, D2).'
    : 'writeApproval: ask — this session can be prompted, so wiki_write asks for approval before writing; a refused or unanswered ask writes nothing (DESIGN §6.4, D2).'
}

/**
 * Whether one call is a `wiki_write` that would create or change a file.
 * @param exec - the tool call's name and its unvalidated `arguments`.
 * @returns true for a `wiki_write` with a non-empty `path` and `content` or an `edit`.
 */
export function isWikiWriteCall(exec: {
  readonly name: string
  readonly arguments: unknown
}): boolean {
  if (exec.name !== WIKI_WRITE_TOOL_NAME) return false
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return false
  const record = args as { readonly path?: unknown; readonly content?: unknown; readonly edit?: unknown }
  if (typeof record.path !== 'string' || record.path.trim() === '') return false
  return typeof record.content === 'string' || (typeof record.edit === 'object' && record.edit !== null)
}

/**
 * Build the prompt for one call (DESIGN §6.4).
 * @param exec - the `wiki_write` call; a `path` argument names the target.
 * @returns the audited reason and the English and Japanese prompt text.
 */
export function approvalPrompt(exec: { readonly arguments: unknown }): ApprovalPrompt {
  const args = exec.arguments as { readonly path?: unknown }
  const target = typeof args.path === 'string' ? args.path : 'a wiki file'
  return {
    reason: `wiki_write wants to write ${target} in the global wiki, and this session's approval policy is ask`,
    displayReason: {
      en: `Allow the model to write ${target} in the global LLM wiki?`,
      ja: `グローバル wiki の ${target} を書き込んでよいですか？`,
    },
  }
}

/** The gate the plugin registers on `tools/pre-execute` (DESIGN §6.4). */
export interface WikiApprovalGate {
  /**
   * The `tools/pre-execute` listener (DESIGN §6.4).
   * @param exec - the call about to run.
   * @param next - the rest of the policy chain.
   * @returns the chain's decision, an ask when this plugin asks, or a deny for
   *   a child or a session that cannot be prompted.
   */
  decide(
    exec: ToolExecution | ToolExecutionInput,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision>
}

/** Everything {@link createWikiApprovalGate} needs. */
export interface WikiApprovalDeps {
  /** Resolved plugin configuration (`writeApproval` decides whether it asks). */
  readonly config: WikiConfig
  /** Where recoverable problems go. */
  readonly logger: {
    /** A recoverable problem. */
    warn(message: string, ...args: unknown[]): void
    /** Normal conditions worth a trace. */
    debug(message: string, ...args: unknown[]): void
  }
  /**
   * The approval service, resolved per call: the service may be registered
   * after this plugin, so the lookup is deferred rather than captured.
   */
  readonly approval?: () => ApprovalServiceLike | undefined
}

/**
 * Build the gate (DESIGN §6.4, D2).
 *
 * The child refusal is here rather than in the tool body alone because the
 * design puts it at pre-execute: a subagent gets `WIKI_READ_ONLY` before its
 * body runs, exactly as a person would see the refusal in the transcript.
 * @param deps - configuration, logger, and the approval-service lookup.
 * @returns the listener.
 */
export function createWikiApprovalGate(deps: WikiApprovalDeps): WikiApprovalGate {
  const gate = createApprovalGate<PreToolDecision>({
    toolName: WIKI_WRITE_TOOL_NAME,
    isWrite: isWikiWriteCall,
    asks: () => deps.config.writeApproval === 'ask',
    prompt: approvalPrompt,
    onNever() {
      // This session cannot be asked, so an unapproved write would be exactly
      // the fail-open the configuration asked to avoid.
      const reason = wikiError(
        'WIKI_APPROVAL_UNAVAILABLE',
        'this session cannot be prompted because its effective approval policy is never, so wiki_write refused the write; enable approval for this session or set writeApproval: none to write without asking',
      ).message
      deps.logger.debug(
        'dsh-llm-wiki: the approval policy is never, so wiki_write refused the write instead of writing without approval',
      )
      return { kind: 'deny', reason }
    },
    approval: deps.approval,
    refuse(call) {
      const agent = call.agent as WikiAgent | undefined
      if (agent === undefined || delegationDepthOf(agent) === 0) return undefined
      return {
        kind: 'deny',
        reason: wikiError(
          'WIKI_READ_ONLY',
          'a subagent may not write the global wiki; report the change to the parent instead',
        ).message,
      }
    },
  })
  return { decide: (exec, next) => gate.decide(exec, next) }
}
