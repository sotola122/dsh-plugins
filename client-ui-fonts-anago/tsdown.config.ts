/**
 * Client build for the Japanese fonts. The shared preset emits the Loader's
 * node half and the browser factory; the local plugin adds one thing: a woff2
 * import becomes a `data:font/woff2;base64,...` module, because the client
 * bundle has no font route to point a `url()` at. The OFL texts ship beside
 * the built artifacts, since the inlined faces are distributed inside
 * `client.js`.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import type { TsdownPlugin, UserConfig } from 'tsdown'
import { clientBundle } from '../../client/tsdown.client.ts'

/** Path segment separating tsc's emitted tree from the sources it compiled. */
const TYPES_MARKER = `${sep}lib${sep}types${sep}`

/**
 * Resolve a woff2 import against the package sources. The bundle consumes
 * `lib/types`, so a relative import that misses the emitted tree maps back onto
 * `src/`, where the font files live.
 * @param source - Relative import specifier as written in the source.
 * @param importer - Absolute path of the importing module.
 * @returns the font file to inline.
 */
function fontFile(source: string, importer: string): string {
  const emitted = resolve(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const boundary = emitted.indexOf(TYPES_MARKER)
  return boundary < 0
    ? emitted
    : resolve(emitted.slice(0, boundary), 'src', emitted.slice(boundary + TYPES_MARKER.length))
}

/** Inline every imported woff2 as a data URL the stylesheet can carry. */
const fontDataUrl: TsdownPlugin = {
  name: 'dsh-woff2-data-url',
  resolveId(source, importer) {
    if (importer === undefined || !source.endsWith('.woff2')) return null
    return fontFile(source, importer)
  },
  async load(id) {
    if (!id.endsWith('.woff2')) return null
    this.addWatchFile(id)
    const bytes = await readFile(id)
    return `export default ${JSON.stringify(`data:font/woff2;base64,${bytes.toString('base64')}`)};`
  },
}

const bundle = clientBundle(import.meta.dirname, ['lib/types/index.js'], {
  lib: {
    copy: [{ from: 'src/fonts/{*-OFL.txt,fonts.json}', to: 'lib/fonts' }],
  },
})

export default (options: Parameters<typeof bundle>[0]): UserConfig[] => bundle(options).map(config =>
  config.name?.endsWith('/client') === true
    ? { ...config, plugins: [config.plugins, fontDataUrl] }
    : config)
