/**
 * R1 and R2: persistent memory for DSH.
 *
 * The plugin owns three Markdown stores and six seams:
 *
 * | piece | what it does | design |
 * | --- | --- | --- |
 * | `memory` tool | 0–8 add/patch/remove operations, applied under the writer lock, all or nothing | §4.1 |
 * | `agent/pre-step` | one frozen snapshot per session, inserted after `next()` | §4.2 |
 * | `agent/created` | a subagent child gets the workspace store only, and reads it read-only | §4.4, N8 |
 * | `tools/pre-execute` | `writeApproval: ask`: ask, or mark the call staged under `never` | §4.5 |
 * | `/memory` | list, show, path, pending, approve, reject, gitignore | §4.6 |
 * | turn-end review | completed turns accumulate and are drained at `agent/status` idle, always staged | §4.7 |
 * | workspace store | `<projectRoot>/.dsh/memory/MEMORY.md`, git root required, `.gitignore` block managed | §5.1 |
 *
 * The review is deliberately wired as three listeners rather than one: the
 * count rides `session/event` (`turn/end` with `reason.kind === 'completed'`),
 * the drain rides `agent/status` (the only place where the agent is known to be
 * idle **and** the round can read the conversation), and `agent/disposed`
 * cancels a round whose agent went away. None of them is awaited by the caller,
 * and `agent/turn-stopping` and `runMaintenance` are not used: the first would
 * hold the turn and the second would hold later input (S24). Because the round
 * starts at the idle status a controller may release the agent on, the drain
 * holds the agent (`ctx.agents.hold`) until the round settles, so that release
 * cannot abort the review.
 *
 * The one defense this plugin has for memory content is the §9 scan at
 * injection time (and at write time, and again when a staged write is
 * approved): memory paths are **not** denied to `write`/`edit`/`bash`, because
 * `bash` can write them anyway and a deny would only hide the real boundary
 * (N2, §5.2). The review adds two more places the same scan runs: the excerpt
 * before it is sent (a refusal skips that round) and the model's proposal
 * before it is staged (through the tool's own `applyOperations`).
 * @module @anago-harness/memory
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { delegationDepthOf } from './agents.ts'
import { createMemoryApprovalGate, type ApprovalServiceLike } from './approval.ts'
import {
  MEMORY_COMMAND_DESCRIPTION,
  MEMORY_COMMAND_HINT,
  runMemoryCommand,
} from './command.ts'
import { Config, type MemoryConfig } from './config.ts'
import { describeError } from './errors.ts'
import { createPreStepListener, type MemoryLogger } from './inject.ts'
import { createReviewRunner } from './review.ts'
import { createMemoryTool, MEMORY_TOOL_NAME } from './tool.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory'

/**
 * The services this plugin needs at load time. The tool registry carries the
 * tool; the command registry carries `/memory`, and a deployment without it
 * would silently lose the whole approval workflow; the agent registry owns the
 * lifecycle a review must hold across (`ctx.agents.hold`). The plugin waits for
 * each rather than starting half-configured. The **approval** service is
 * deliberately not here: DESIGN §4.5 defines what to do without one (treat the
 * policy as `never` and stage), so it is looked up per call instead.
 */
export const inject = ['tools', 'commands', 'agents']

export { Config }
export type { MemoryConfig }

/**
 * Register the tool, the three listeners, and the command in the calling
 * context's scope, so unloading the plugin removes all of them through Cordis'
 * own effects.
 * @param ctx - plugin context carrying the tool and command registries.
 * @param config - the validated, default-filled plugin configuration.
 */
export function apply(ctx: Context, config: MemoryConfig): void {
  const logger: MemoryLogger = {
    warn: (message, ...args) => {
      ctx.logger.warn(message, ...args)
    },
    debug: (message, ...args) => {
      ctx.logger.debug(message, ...args)
    },
  }
  const api = { withFileLock, writeFileAtomic }
  // Resolved per call: the approval service may be registered after this
  // plugin, and a deployment may not have it at all (DESIGN §4.5).
  const gate = createMemoryApprovalGate({
    config,
    logger,
    // `ctx.get` is `any` for a service this package does not declare on Context.
    approval: () => ctx.get('approval') as ApprovalServiceLike | undefined,
  })
  ctx.tools.register(createMemoryTool({ config, logger, api, isStaged: exec => gate.wasStaged(exec) }))
  ctx.on('tools/pre-execute', (exec, next) => gate.decide(exec, next))
  const listener = createPreStepListener({ config, logger })
  ctx.on('agent/pre-step', (payload, next) => listener(payload, next))
  ctx.commands.register({
    name: 'memory',
    description: MEMORY_COMMAND_DESCRIPTION,
    input: { hint: MEMORY_COMMAND_HINT },
    handler: invocation => runMemoryCommand(invocation, { config, logger, api }),
  })
  // The turn-end review (DESIGN §4.7). The listeners are registered unawaited:
  // `agent/status` is an emit, and the whole point is that the turn that just
  // ended is not held while the auxiliary call runs. The drain promise is
  // deliberately dropped — `drain` contains its own failures. The runner
  // belongs to this `apply` call, so two plugin instances never share its
  // single-flight slot, and the disposer stops new rounds, aborts the
  // in-flight one, and awaits its final writes.
  const review = createReviewRunner({
    config,
    logger,
    api,
    llm: () => ctx.get('llm'),
    isHeadless: () => isHeadlessRun(ctx),
  })
  /** Drains whose hold is not released yet, so unload can wait for them. */
  const pendingDrains = new Set<Promise<void>>()
  /**
   * Run one drain with its agent held against an idle release.
   *
   * The hold is taken before `drain`'s first await and before the `agent/status`
   * emit returns: a controller that releases an idle agent checks `holds()`, and
   * a release scheduled in that same tick would otherwise dispose the agent
   * whose review is about to read the conversation. Releasing it in the drain's
   * `finally` covers success, failure, and the `stop()` that aborts the round.
   * @param agent - the agent whose idle status starts the review.
   */
  const drainHeld = (agent: Agent): void => {
    let hold: Disposable
    try {
      hold = ctx.agents.hold(agent)
    } catch (error) {
      // A disposed agent cannot be reviewed; containing the throw keeps the
      // `agent/status` emit intact for every listener that follows.
      logger.warn('dsh-memory: the review skipped an agent that is no longer live (%s)', describeError(error))
      return
    }
    const drained = (async () => {
      try {
        await review.drain(agent)
      } finally {
        hold[Symbol.dispose]()
      }
    })()
    pendingDrains.add(drained)
    void drained.finally(() => {
      pendingDrains.delete(drained)
    })
  }
  ctx.effect(() => async () => {
    await review.stop()
    // `stop` settles the round; this awaits the drain's `finally`, the point
    // where the hold is released, so unloading never leaves one behind.
    await Promise.allSettled([...pendingDrains])
  }, 'memory.review-runner')
  ctx.on('session/event', (session, event) => {
    review.observe(session, event)
  })
  ctx.on('agent/status', (payload) => {
    if (payload.status !== 'idle') return
    drainHeld(payload.agent)
  })
  ctx.on('agent/disposed', (payload) => {
    review.dispose(payload.agent)
  })
  ctx.on('agent/created', ({ agent }) => {
    if (delegationDepthOf(agent) <= 0) return
    // Registered after the tool, so the name is known to the registry; still
    // wrapped, because `restrict` throws on an unknown name and a throw inside
    // `agent/created` fails agent creation outright (S6, S15). The tool body's
    // own MEMORY_READ_ONLY refusal is the guarantee behind this best effort.
    try {
      const tools = agent.ctx.get('tools')
      if (tools === undefined) {
        logger.warn('dsh-memory: no tool registry on the child scope; the memory tool stays visible')
        return
      }
      tools.restrict({ deny: [MEMORY_TOOL_NAME] })
    } catch (error) {
      logger.warn(
        'dsh-memory: could not restrict %s for the subagent %s (%s); the tool still refuses writes with MEMORY_READ_ONLY',
        MEMORY_TOOL_NAME,
        String(agent.session.id),
        describeError(error),
      )
    }
  })
}

/**
 * The service the shipped `dsh-headless` startup row publishes
 * (`$P/dsh-headless/lib/startup.js:29`: `HEADLESS_STARTUP_SERVICE`).
 *
 * This is the signal that the process is a one-shot headless run: the row
 * parses the task and `--session-id` and publishes them for the shipped
 * runner, which injects the service. The name of the profile is not a signal:
 * a bundle only inserts rows, so any profile that carries the headless rows is
 * a headless run whatever the profile is called (T15).
 */
const HEADLESS_STARTUP_SERVICE = 'headlessStartup'

/** The profile name the shipped headless profile carries (DESIGN §4.7, T15). */
const HEADLESS_PROFILE_NAME = 'headless'

/**
 * Whether this process is a headless (one-shot) run (DESIGN §4.7, T15).
 *
 * The startup service decides it; the profile name is only a fallback. If DSH
 * renames or drops the service, a profile still named `headless` keeps the
 * design's default exclusion, and an unknown profile with no service is
 * treated as interactive exactly as before — the fallback cannot over-exclude
 * a profile this plugin cannot classify. The service is read on every call
 * rather than once in `apply`, because loader rows mount concurrently and the
 * startup row may publish it after this plugin is applied.
 * @param ctx - the plugin context.
 * @returns whether the review should treat this process as headless.
 */
export function isHeadlessRun(ctx: Context): boolean {
  if (serviceOf(ctx, HEADLESS_STARTUP_SERVICE) !== undefined) return true
  return profileNameOf(ctx) === HEADLESS_PROFILE_NAME
}

/**
 * Read one undeclared Cordis service without augmenting `Context`.
 *
 * `headlessStartup` is declared by `dsh-headless` and `profileContext` by
 * `dsh-app-boot`, neither of which is a peer of this package (§3.1), so both
 * are read structurally through the same `get` the harness itself uses.
 * @param ctx - the plugin context.
 * @param name - the service name.
 * @returns the service, or undefined when the composition has none.
 */
function serviceOf(ctx: Context, name: string): unknown {
  return ctx.get(name)
}

/**
 * The profile name the launch recorded (DESIGN §4.7's fallback headless rule).
 *
 * No profile context at all means "not headless": the design excludes only a
 * profile that says it is.
 * @param ctx - the plugin context.
 * @returns the profile name, or undefined when the composition has none.
 */
function profileNameOf(ctx: Context): string | undefined {
  const profile = serviceOf(ctx, 'profileContext')
  if (typeof profile !== 'object' || profile === null) return undefined
  const name = (profile as { readonly name?: unknown }).name
  return typeof name === 'string' && name !== '' ? name : undefined
}
