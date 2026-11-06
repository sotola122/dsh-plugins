/** Remote contribution and Settings section registration lifecycle. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@anago-harness/ui-settings-usage/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { UsageSection, type UsageSectionInjected } from './UsageSection.tsx'
import { UsageController } from './usage-controller.ts'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.usage'

/** Services required to mount the Remote and the section. */
export const inject = ['remote', 'slots', 'locale']

function registerUi(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-settings-usage: dictionaries')
  const controller = new UsageController(
    signal => ctx.remote.providerUsage.report(signal),
    (message) => { ctx.logger.warn(message) },
  )
  ctx.effect(() => () => { controller.cancel() }, 'ui-settings-usage: read cancellation')
  // One face for the entry's lifetime, because the section's open effect depends on these actions' identity.
  const face: UsageSectionInjected = {
    hooks: { usageRows: controller.rows },
    refresh: () => { void controller.refresh() },
    cancel: () => { controller.cancel() },
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'usage',
    order: 12,
    label: () => t('nav'),
    locale: NS,
    inject: () => face,
  }, UsageSection))
}

/**
 * Mount the generated Remote, then the section that calls it; disposal withdraws
 * them in the reverse order.
 * @param ctx - browser plugin context.
 * @param contribution - generated `providerUsage` Remote definitions.
 * @returns disposer that removes both contributions.
 */
export async function mountUsage(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.providerUsage', ...inject.slice(1)], (child) => { registerUi(child) })
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await unmountRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await unmountRemote()
  }
}
