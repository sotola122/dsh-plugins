/**
 * The shipped woff2 files as bundle data URLs. The client build rewrites every
 * `*.woff2` import into `data:font/woff2;base64,...` (tsdown.config.ts), so
 * `src/styles/fonts.css` can name the bytes without a URL the bundle cannot
 * serve. Keys are the placeholders that stylesheet carries.
 */
import udevGothic from '../fonts/udev-gothic-regular.woff2'
import intelOneMonoLatin from '../fonts/intel-one-mono-latin.woff2'
import intelOneMonoLatinExt from '../fonts/intel-one-mono-latin-ext.woff2'
import intelOneMonoSymbols from '../fonts/intel-one-mono-symbols.woff2'
import notoSansJpKana from '../fonts/noto-sans-jp-kana.woff2'
import notoSansJpKanji from '../fonts/noto-sans-jp-kanji.woff2'
import notoSansJpLatin from '../fonts/noto-sans-jp-latin.woff2'

/** Placeholder → data URL, one entry per `@font-face` `src` in the stylesheet. */
export const FONT_REPLACEMENTS: Readonly<Record<string, string>> = {
  __DSH_FONT_UDEV_GOTHIC__: udevGothic,
  __DSH_FONT_NOTO_SANS_JP_LATIN__: notoSansJpLatin,
  __DSH_FONT_NOTO_SANS_JP_KANA__: notoSansJpKana,
  __DSH_FONT_NOTO_SANS_JP_KANJI__: notoSansJpKanji,
  __DSH_FONT_INTEL_ONE_MONO_LATIN__: intelOneMonoLatin,
  __DSH_FONT_INTEL_ONE_MONO_LATIN_EXT__: intelOneMonoLatinExt,
  __DSH_FONT_INTEL_ONE_MONO_SYMBOLS__: intelOneMonoSymbols,
}
