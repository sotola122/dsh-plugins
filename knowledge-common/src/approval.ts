/**
 * The approval vocabulary and the pre-execute gate the fork's writing tools
 * share (memory DESIGN §4.5, wiki DESIGN §6.4; S16, S21).
 *
 * The shared skeleton calls `next()` first and only ever turns a downstream
 * `allow` into this plugin's `ask`, its own refusal, or the `never` outcome the
 * plugin returns. The plugin injects the tool it governs, its own "does this
 * call write" predicate, its own prompt text, and what to do when the session's
 * effective policy is `never`; the order of those checks and the policy read
 * live here once.
 *
 * A plugin's prompts and log lines stay in the plugin, so each keeps its exact
 * wording. The gate is a plain function: it registers nothing.
 * @module knowledge-common/approval
 */

/** The only two values the approval service deals in (DESIGN S21). */
export type ApprovalPolicy = 'ask' | 'never'

/**
 * The part of `ctx.approval` this gate uses (DESIGN S21).
 *
 * It is declared structurally so a fake context in a unit test satisfies it,
 * and so a plugin still compiles and runs in a deployment whose
 * `@deepseek-ai/dsh-user-approval` is a different instance.
 */
export interface ApprovalServiceLike {
  /**
   * The session's logged override, without the configured default.
   * @param session - the session whose log supplies the override.
   * @returns the last logged policy, or undefined without one.
   */
  overrideOf(session: unknown): ApprovalPolicy | undefined
  /** The deployment default, already defaulted by the service's own schema. */
  readonly config: { readonly policy?: ApprovalPolicy }
}

/**
 * The policy one session's asks resolve under right now (DESIGN S21).
 *
 * Without an approval service, an `ask` would be denied by the tool registry
 * itself (`serviceAsk` returns a deny when `ctx.approval` is absent,
 * `$P/dsh-tools/lib/index.js:3535-3543`), so a missing service resolves to
 * `never`: the caller can then write directly or stage instead of losing the
 * write.
 * @param service - `ctx.approval`, or undefined when the deployment has none.
 * @param session - the calling session.
 * @returns `ask` or `never`; never undefined.
 */
export function resolveEffectivePolicy(
  service: ApprovalServiceLike | undefined,
  session: unknown,
): ApprovalPolicy {
  if (service === undefined) return 'never'
  try {
    return service.overrideOf(session) ?? service.config.policy ?? 'ask'
  } catch {
    // An unreadable policy is not a reason to write without approval.
    return 'never'
  }
}

/** What an approval prompt says, in the two languages the designs use. */
export interface ApprovalPrompt {
  /** The audited reason (`PreToolDecision.ask.reason`). */
  readonly reason: string
  /** The localized prompt text (`displayReason`). */
  readonly displayReason: { readonly en: string; readonly ja: string }
}

/** The call fields this gate reads; a tool execution satisfies it structurally. */
export interface ApprovalCall {
  /** The tool name the model asked for. */
  readonly name: string
  /** The unvalidated arguments the tool body will parse. */
  readonly arguments: unknown
  /** The agent on whose behalf the call runs, when the loop supplies one. */
  readonly agent?: unknown
}

/** The decision fields this gate preserves or replaces. */
export interface ApprovalDecisionLike {
  /** The discriminated decision tag. */
  readonly kind: string
}

/** This gate's ask, structurally a `PreToolDecision` ask. */
export interface ApprovalAsk {
  readonly kind: 'ask'
  readonly reason: string
  readonly displayReason: { readonly en: string; readonly ja: string }
}

/** A logger at the one level the `never` trace uses. */
export interface ApprovalLogger {
  /** Normal conditions worth a trace. */
  debug(message: string, ...args: unknown[]): void
}

/** Everything the shared gate needs. */
export interface ApprovalGateDeps<Decision extends ApprovalDecisionLike> {
  /** The tool this gate governs; every other call passes through unchanged. */
  readonly toolName: string
  /** Whether one call to the governed tool writes; the plugin owns this predicate. */
  readonly isWrite: (call: ApprovalCall) => boolean
  /** The plugin's own switch: true when a write should ask at all. */
  readonly asks: () => boolean
  /** Build the plugin's prompt for one writing call. */
  readonly prompt: (call: ApprovalCall) => ApprovalPrompt
  /**
   * Handle a writing call whose effective policy is `never`. The plugin owns
   * the trace and any staging mark; returning a decision replaces the
   * downstream `allow`, and returning `undefined` keeps it.
   */
  readonly onNever: (call: ApprovalCall) => Decision | undefined
  /**
   * The approval service, resolved per call: it may be registered after the
   * plugin, and a deployment may not have it at all.
   */
  readonly approval?: (() => ApprovalServiceLike | undefined) | undefined
  /**
   * A plugin-specific refusal checked after the write predicate and before the
   * ask, such as the wiki's child-session read-only rule.
   */
  readonly refuse?: ((call: ApprovalCall) => Decision | undefined) | undefined
}

/** The gate one plugin exposes to its registration and its tool body. */
export interface ApprovalGate<Decision extends ApprovalDecisionLike> {
  /**
   * The `tools/pre-execute` listener.
   * @param call - the call about to run.
   * @param next - the rest of the policy chain.
   * @returns the chain's decision, this gate's ask, or the plugin's refusal.
   */
  decide(call: ApprovalCall, next: () => Promise<Decision>): Promise<Decision | ApprovalAsk>
}

/**
 * Build the shared gate (memory DESIGN §4.5, wiki DESIGN §6.4).
 *
 * The chain is never swallowed: `next()` runs first, a deny or cancel passes
 * through untouched, and another listener's ask is left as it was.
 * @param deps - the tool, its write predicate, the plugin's prompt and switch,
 *   and the approval-service lookup.
 * @returns the listener the plugin registers on `tools/pre-execute`.
 */
export function createApprovalGate<Decision extends ApprovalDecisionLike>(
  deps: ApprovalGateDeps<Decision>,
): ApprovalGate<Decision> {
  return {
    async decide(call, next) {
      const decision = await next()
      // Only a downstream `allow` may be changed: a deny, a cancel, and another
      // listener's ask all stay exactly as they are.
      if (decision.kind !== 'allow') return decision
      if (call.name !== deps.toolName) return decision
      if (!deps.isWrite(call)) return decision
      const refusal = deps.refuse?.(call)
      if (refusal !== undefined) return refusal
      if (!deps.asks()) return decision
      const service = deps.approval?.()
      const session = (call.agent as { readonly session?: unknown } | undefined)?.session
      const policy = resolveEffectivePolicy(service, session)
      if (policy === 'ask') return { kind: 'ask', ...deps.prompt(call) }
      // A plugin that cannot stage returns its own refusal here; one that
      // stages returns undefined and keeps the downstream `allow`.
      return deps.onNever(call) ?? decision
    },
  }
}
