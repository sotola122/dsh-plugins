/** Browser entry for the Settings page's provider usage section. */

import type { Context } from '@deepseek-ai/cordis'
import remote from '@anago-harness/ui-settings-usage/remote'
import { mountUsage } from './mount.ts'

export { inject } from './mount.ts'
export type { UsageLocaleKey } from './locales.ts'
export type { UsageSectionInjected, UsageSectionProps } from './UsageSection.tsx'

/**
 * Mount the section and its Remote.
 * @param ctx - browser plugin context.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountUsage(ctx, remote)
}
