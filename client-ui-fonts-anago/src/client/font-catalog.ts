/**
 * The fonts the Settings picker offers: the plugin's one catalog, read by the
 * browser half. A selection persists as the entry's CSS font list, not its id,
 * so the theme boot script applies it before plugins load and any list saved
 * earlier keeps working. Every list is already in the form `normalizeFontFamily`
 * produces, because the picker recognizes a persisted list by exact match. UDEV
 * Gothic's `unicode-range` stops before Latin, so each UDEV list names what
 * draws Latin after it.
 */
import type { FontRole } from '@deepseek-ai/dsh-client-ui-theme/client'

/** One catalog font. */
export interface FontCatalogEntry {
  /** Stable option id, unique in the catalog. */
  readonly id: string
  /** `bundled` names faces this package ships; `system` leaves the list to the browser. */
  readonly kind: 'bundled' | 'system'
  /** Display name: a font name or CSS family keyword, shown untranslated. */
  readonly label: string
  /** Shipped woff2 files under `src/fonts/` that draw this font; empty for a system stack. */
  readonly files: readonly string[]
  /** Normalized CSS font list per role; a role without a list does not offer this font. */
  readonly lists: Readonly<Partial<Record<FontRole, string>>>
}

/** One option of a role's picker. */
export interface FontChoice {
  /** The catalog entry's id. */
  readonly id: string
  /** The catalog entry's kind, which selects its option group. */
  readonly kind: FontCatalogEntry['kind']
  /** The catalog entry's display name. */
  readonly label: string
  /** The normalized CSS font list persisted when this option is selected. */
  readonly list: string
}

/** Monospace list shared by the code and terminal roles for the bundled mono face. */
const INTEL_ONE_MONO_LIST = '"Intel One Mono", "UDEV Gothic", monospace'

/** Monospace list drawing Japanese with UDEV Gothic and Latin with the system font. */
const UDEV_GOTHIC_MONO_LIST = '"UDEV Gothic", monospace'

/** Every font the picker offers, in display order. */
export const FONT_CATALOG: readonly FontCatalogEntry[] = [
  {
    id: 'intel-one-mono',
    kind: 'bundled',
    label: 'Intel One Mono',
    files: ['intel-one-mono-latin.woff2', 'intel-one-mono-latin-ext.woff2', 'intel-one-mono-symbols.woff2'],
    lists: { code: INTEL_ONE_MONO_LIST, terminal: INTEL_ONE_MONO_LIST },
  },
  {
    id: 'udev-gothic',
    kind: 'bundled',
    label: 'UDEV Gothic',
    files: ['udev-gothic-regular.woff2'],
    lists: { text: '"UDEV Gothic", "Noto Sans JP", sans-serif', code: UDEV_GOTHIC_MONO_LIST, terminal: UDEV_GOTHIC_MONO_LIST },
  },
  {
    id: 'noto-sans-jp',
    kind: 'bundled',
    label: 'Noto Sans JP',
    files: ['noto-sans-jp-latin.woff2', 'noto-sans-jp-kana.woff2', 'noto-sans-jp-kanji.woff2'],
    lists: { text: '"Noto Sans JP", sans-serif' },
  },
  { id: 'system-ui', kind: 'system', label: 'system-ui', files: [], lists: { text: 'system-ui' } },
  { id: 'sans-serif', kind: 'system', label: 'sans-serif', files: [], lists: { text: 'sans-serif' } },
  { id: 'serif', kind: 'system', label: 'serif', files: [], lists: { text: 'serif' } },
  { id: 'ui-monospace', kind: 'system', label: 'ui-monospace', files: [], lists: { code: 'ui-monospace, monospace', terminal: 'ui-monospace, monospace' } },
  { id: 'monospace', kind: 'system', label: 'monospace', files: [], lists: { text: 'monospace', code: 'monospace', terminal: 'monospace' } },
]

/** Project the catalog onto one role's options. */
function choicesFor(role: FontRole): readonly FontChoice[] {
  return FONT_CATALOG.flatMap(({ id, kind, label, lists }) => {
    const list = lists[role]
    return list === undefined ? [] : [{ id, kind, label, list }]
  })
}

/** Each role's picker options, in catalog order. */
export const FONT_CHOICES: Readonly<Record<FontRole, readonly FontChoice[]>> = {
  text: choicesFor('text'),
  code: choicesFor('code'),
  terminal: choicesFor('terminal'),
}
