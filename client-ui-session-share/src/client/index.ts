/**
 * Session sharing for the anago Web UI, browser half: the page blocks a
 * Session whose write lease another DSH process holds, so viewing a Session
 * here never becomes a second writer.
 *
 * The plugin polls `ctx.remote.session.ownership` for the Sessions the browser
 * lists and raises a `lock: 'all'` composer block for every Session another
 * process holds. The block disables the message input and the controls that
 * would resume an Agent; it clears when the other process releases the lease or
 * the Session leaves the catalog, and an unloaded page clears every block it
 * raised.
 * @module @anago-harness/client-ui-session-share/src/client
 */

// Type-only: the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the api-remotes Context merge (ctx.remote) and its namespace face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the Session Controller Context merge (ctx.sessions) and the
// `ctx.remote.session` face this plugin calls.
import type { SessionRemote } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the ui-conversation Context merge (ctx.conversation.blocks).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the locale namespace table this plugin merges into.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { de, en, es, fr, ja, NS, pt, ru, zh, type SessionShareLocaleKey } from './locales.ts'
import { SessionOwnershipWatcher } from './session-ownership-watcher.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Session-sharing composer copy. */
    sessionShare: SessionShareLocaleKey
  }
}

/** Services required by the Session-sharing plugin. */
export const inject = ['remote', 'remote.session', 'sessions', 'conversation', 'locale']

/** Browser-half runtime configuration. */
export interface Config {
  /** Milliseconds between ownership probes for the Sessions this page lists. */
  ownerPollMs: number
}

/** Validated browser-half configuration. */
export const Config: z<Partial<Config>, Config> = z.object({
  ownerPollMs: z.natural().min(1).default(1000),
})

/**
 * Mount the Session-sharing watcher for the plugin lifetime.
 * @param ctx - the browser plugin context carrying the Session catalog, the
 *   composer block registry, the ownership Remote, and the locale service.
 * @param config - validated browser-half configuration.
 */
export function apply(ctx: ClientContext, config: Config = Config({})): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'session-share: dictionaries')
  // The generated namespace artifact gains `ownership` from the Host
  // descriptor; the exported SessionRemote type states it before a build.
  const session = ctx.remote.session as SessionRemote
  const watcher = new SessionOwnershipWatcher({
    list: ctx.sessions.list,
    blocks: ctx.conversation.blocks,
    ownership: ids => session.ownership(ids),
    reason: () => t('composer.heldElsewhere'),
    pollMs: config.ownerPollMs,
  })
  ctx.effect(() => {
    watcher.start()
    return () => { watcher.dispose() }
  }, 'session-share: ownership blocks')
}
