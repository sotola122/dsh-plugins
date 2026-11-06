/**
 * R3: the LLM wiki for DSH (DESIGN §6; implementation orders 3, 4's `/wiki`,
 * and 5's global wiki).
 *
 * There are two wikis, and the plugin treats them differently on purpose:
 *
 * | | project wiki | global wiki |
 * | --- | --- | --- |
 * | where | `<checkoutRoot>/.dsh/wiki/` | the top of a repository the user designates (§6.4) |
 * | written by | the ordinary `write`/`edit` tools, while the session is at or above the checkout root | `wiki_write` alone |
 * | protected by | `WIKI_RAW_IMMUTABLE` on an existing `raw/` source | `WIKI_READ_ONLY` on every `write`/`edit` below it |
 * | committed by | the branch's pull request (`commit: true`) | `/wiki commit`, run by a person |
 *
 * What the plugin owns:
 *
 * - `wiki_lint` tool: unresolved links, the `index.md` ⟷ page-directory
 *   mismatch, and `raw/` digests (the configured default set; an explicit
 *   `checks` wins), over either or both wikis (§6.6).
 * - `wiki_write` tool: the global wiki's only writer — path rules, `raw/`
 *   immutability, the recorded `sha256`, the §9 scan, per-file caps, and the
 *   writer lock (§6.4).
 * - `tools/pre-execute`: the raw guard, the global-wiki deny, the child's
 *   `WIKI_READ_ONLY`, and `writeApproval`'s ask or its
 *   `WIKI_APPROVAL_UNAVAILABLE` refusal when nobody can be asked (§6.4, §6.6).
 * - `agent/pre-step`: one existence notice per session, with both page counts
 *   (§6.6).
 * - `agent/created`: resolves the global wiki once per session, so an overlap
 *   disarms the deny and a bad Profile path only warns (§6.4).
 * - `wiki_search` tool: BM25 over both wikis' page directories, from an
 *   in-process index that stats before it reads, with §9 scanning of what it
 *   returns (§6.5).
 * - `/wiki`: `status`, `lint`, `reindex`, `repo set`/`repo unset`, and `commit`
 *   (§6.6).
 * - `.dsh/wiki.yml`: `commit` only; unknown keys warn, unparseable means
 *   `false` (§6.3).
 * - skill: the convention the pages follow, registered through `ctx.skills`
 *   (§6.1).
 *
 * The search index is in-process only: it is built on the first search, kept
 * per wiki root, and rebuilt on a plugin reload, `/wiki reindex`, and after an
 * exception during a refresh. Nothing about it is persisted, so a stale or
 * corrupt index cannot outlive the process (DESIGN §6.5).
 *
 * The one defense the wiki has against its own content is structural rather
 * than a scan: nothing is injected except a one-line notice, `raw/` is
 * immutable, `wiki_write` refuses instruction-shaped text and redacts secrets,
 * and `wiki_lint` makes a broken link or a hand-edited source visible. Page
 * text reaches the model only because the model read it.
 * @module @anago-harness/llm-wiki
 */

import type { Context } from '@deepseek-ai/cordis'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { createWikiApprovalGate, type ApprovalServiceLike } from './approval.ts'
import { WIKI_COMMAND_DESCRIPTION, WIKI_COMMAND_HINT, runWikiCommand } from './command.ts'
import { Config, type WikiConfig } from './config.ts'
import { createGlobalWikiState } from './global.ts'
import { guardDecision, type WorkingDirectoryLike } from './guard.ts'
import { createNoticeListener, type WikiLogger } from './inject.ts'
import { createWikiRootCache } from './inspect.ts'
import { createWikiSearchIndex } from './search.ts'
import { createWikiSearchTool } from './search-tool.ts'
import { createSkillRegistration } from './skill.ts'
import { createWikiLintTool } from './tool.ts'
import { createWikiWriteTool } from './write.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-wiki'

/**
 * The registries this plugin needs. Everything else it reads from the session
 * header, so a deployment without `ctx.skills` (a `minimal` preset, S5) fails
 * the load rather than silently losing the skill; the same holds for
 * `ctx.commands`, without which `/wiki` would silently not exist.
 */
export const inject = ['tools', 'skills', 'commands']

export { Config }
export type { WikiConfig }

/**
 * Register the two tools, the three listeners, the command, and the skill in
 * the calling context's scope, so unloading the plugin removes all of them
 * through Cordis' own effects.
 * @param ctx - plugin context carrying the tool, skill, and command registries.
 * @param config - the validated, default-filled plugin configuration.
 */
export function apply(ctx: Context, config: WikiConfig): void {
  const logger: WikiLogger = {
    warn: (message, ...args) => {
      ctx.logger.warn(message, ...args)
    },
    debug: (message, ...args) => {
      ctx.logger.debug(message, ...args)
    },
  }
  const cache = createWikiRootCache()
  // The global wiki is resolved lazily and memoized until something changes it:
  // `apply` is synchronous, and a rejected Profile path must only warn (DESIGN
  // §6.4), so no check can run here.
  const global = createGlobalWikiState({
    profileRepo: () => config.global.repo,
    pagesDir: config.global.pagesDir,
    logger,
  })
  const api = { withFileLock, writeFileAtomic }
  // One index per wiki root, shared by `wiki_search`, `wiki_lint` (which only
  // reads its truncation state) and `/wiki` (which rebuilds it and drops a root
  // whose designation changed). A fresh plugin instance starts with none.
  const search = createWikiSearchIndex({ config, logger })
  const gate = createWikiApprovalGate({
    config,
    logger,
    // `ctx.get` is `any` for a service this package does not declare on Context.
    approval: () => ctx.get('approval') as ApprovalServiceLike | undefined,
  })
  ctx.tools.register(createWikiLintTool({ logger, global, search, checks: config.lint.checks }))
  ctx.tools.register(createWikiSearchTool({ config, logger, global, index: search }))
  ctx.tools.register(createWikiWriteTool({ config, logger, global, api }))
  // Two policies, one event. Each calls `next()` first and only narrows a
  // downstream `allow`, so neither swallows the other's decision (S16).
  ctx.on('tools/pre-execute', (exec, next) =>
    guardDecision(exec, next, {
      global,
      // A relative `write`/`edit` path is resolved against the same working
      // directory the filesystem tools use; without the service the process
      // directory is the provider's fallback.
      // `ctx.get` is `any` for a service this package does not declare on Context.
      workingDirectory: () => ctx.get('workingDirectory') as WorkingDirectoryLike | undefined,
    }),
  )
  ctx.on('tools/pre-execute', (exec, next) => gate.decide(exec, next))
  ctx.on('agent/pre-step', (payload, next) =>
    createNoticeListener({ config, logger, cache, global })(payload, next),
  )
  // Per-session resolution of the cwd rule (DESIGN §6.4 check 5). The listener
  // must not throw — an exception there fails agent creation outright (S6) — and
  // `noteAgent` reports its own failures.
  ctx.on('agent/created', ({ agent }) => {
    global.noteAgent(agent)
  })
  ctx.skills.register(createSkillRegistration(import.meta.url))
  ctx.commands.register({
    name: 'wiki',
    description: WIKI_COMMAND_DESCRIPTION,
    input: { hint: WIKI_COMMAND_HINT },
    // Resolved per call: the approval service may be registered after this
    // plugin, and a deployment may not have it at all (DESIGN §6.4).
    handler: invocation =>
      runWikiCommand(invocation, {
        config,
        logger,
        global,
        search,
        // `ctx.get` is `any` for a service this package does not declare on Context.
        approval: () => ctx.get('approval') as ApprovalServiceLike | undefined,
      }),
  })
}
