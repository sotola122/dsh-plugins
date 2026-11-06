/**
 * The web-search provider cards, browser half: one card for Exa and one for
 * Brave Search. Each card selects its provider through the `web` service's
 * single `searchProvider` field and stores its API key through the credentials
 * domain, addressed by `EXA_API_KEY` or `BRAVE_API_KEY`. The Exa card also
 * edits `web-search-exa`'s retrieval mode; the Brave card edits
 * `web-search-brave`'s result bound and content filter.
 *
 * A card registers into the Plugins page's `plugins.item` slot while the Host
 * serves that provider's namespace, so a deployment without the provider shows
 * no trace of its card. Both cards read the same staged selection, so the two
 * switches can never report different providers.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { WebSearchProviderCard } from './WebSearchProviderCard.tsx'
import {
  BRAVE_NS, EXA_NS, WEB_NS, WebSearchProviderCardController,
} from './web-search-provider-card-controller.ts'
import { de, en, es, fr, ja, pt, ru, zh, type WebSearchProvidersLocaleKey } from './locales.ts'

export type { WebSearchProviderCardProps } from './WebSearchProviderCard.tsx'
export type {
  BraveSearchSettings, BraveSafeSearch, ExaSearchSettings, ExaSearchType, WebProviderSelection,
  WebSearchProviderCardFace, WebSearchProviderCardScopes, WebSearchProviderCardState,
  WebSearchProviderId,
} from './web-search-provider-card-controller.ts'
export type { WebSearchProvidersLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Exa and Brave web-search settings card copy. */
    'settings.webSearchProviders': WebSearchProvidersLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.webSearchProviders'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

/**
 * Mount the Exa and Brave cards while the Host serves their namespaces.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-settings-web-search-providers: dictionaries')
  const cards = new WebSearchProviderCardController({
    web: ctx.configForms.get(WEB_NS),
    exa: ctx.configForms.get(EXA_NS),
    brave: ctx.configForms.get(BRAVE_NS),
  }, ctx)
  ctx.effect(() => () => { cards.dispose() }, 'ui-settings-web-search-providers: form subscription')
  // A key written on another surface changes no settings section, so the
  // forwarded credentials event is the only signal that reaches these cards.
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', (ref) => { cards.refreshCredential(ref) }),
    'ui-settings-web-search-providers: credential invalidations',
  )
  for (const provider of ['exa', 'brave'] as const) {
    const namespace = provider === 'exa' ? EXA_NS : BRAVE_NS
    ctx.effect(() => ctx.configForms.whileServed([namespace], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
      name: 'plugins.item',
      id: `web-search-${provider}`,
      order: provider === 'exa' ? 20 : 21,
      label: () => t(provider === 'exa' ? 'titleExa' : 'titleBrave'),
      locale: NS,
      inject: () => cards.inject(provider),
    }, WebSearchProviderCard))), `ui-settings-web-search-providers: ${provider} page`)
  }
}
