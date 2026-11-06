/**
 * Japanese-first Web UI fonts, node half: registers the Loader row and embeds
 * the validated font lists in every rendered page. The browser half mounts the
 * bundled faces and applies the lists as the default stacks; this half exists
 * so an operator changes the fonts from the profile instead of editing CSS.
 * @module @anago-harness/client-ui-fonts-anago
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { FONT_CONFIG_GLOBAL, type Config } from './config.ts'

export { Config } from './config.ts'

/**
 * Embed the configured stacks in browser pages.
 * @param ctx - Host plugin context serving those pages.
 * @param config - Validated font lists by interface.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: FONT_CONFIG_GLOBAL, value: config })
  })
}
