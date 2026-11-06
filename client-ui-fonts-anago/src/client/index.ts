/**
 * Japanese-first fonts for the Anago Web UI, browser half: the plugin mounts
 * one stylesheet that declares the woff2 faces and writes the configured lists
 * as the default stacks. UDEV Gothic draws kana, kanji, and full-width forms,
 * Noto Sans JP is the broad fallback, and Intel One Mono draws Latin and code;
 * the stylesheet also sets the text stack on the application root so existing
 * components inherit it without per-component declarations. While the slot and
 * locale services are live, the plugin also fills ui-theme's font rows with a
 * picker over its catalog; the faces do not wait for those services.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ui-theme's SlotMap merge ('settings.theme.font-family').
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import stylesheet from '../styles/fonts.css?inline'
import { Config, FONT_CONFIG_GLOBAL } from '../config.ts'
import { FontFamilyPicker } from './FontFamilyPicker.tsx'
import { FONT_REPLACEMENTS } from './font-assets.ts'
import { FONT_CHOICES } from './font-catalog.ts'
import { de, en, es, fr, ja, pt, ru, zh, type FontPickerKey } from './locales.ts'
import { installFontStyles, renderFontStylesheet, renderFontTokenDefaults } from './styles.ts'

export type { FontFamilyPickerProps } from './FontFamilyPicker.tsx'
export type { FontPickerKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The font picker's copy. */
    'settings.anagoFonts': FontPickerKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.anagoFonts'

/**
 * Mount the font stylesheet for the plugin lifetime and contribute the picker
 * to ui-theme's font rows while their services and slot exist.
 * @param ctx - The browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // The Host already validated these values; revalidating keeps a page without
  // the injection (a stale index) on the defaults instead of an empty stack.
  const configured = (globalThis as { [FONT_CONFIG_GLOBAL]?: unknown })[FONT_CONFIG_GLOBAL]
  const families = Config(configured ?? {})
  installFontStyles(ctx, renderFontStylesheet(stylesheet, FONT_REPLACEMENTS) + renderFontTokenDefaults(families))
  ctx.inject(['slots', 'locale'], (scope) => {
    scope.effect(() => scope.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'client-ui-fonts-anago: picker dictionaries')
    scope.slots.inject('settings.theme.font-family', () => scope.slots.register({
      name: 'settings.theme.font-family',
      locale: NS,
      select: owner => FONT_CHOICES[owner.role],
    }, FontFamilyPicker))
  })
}
