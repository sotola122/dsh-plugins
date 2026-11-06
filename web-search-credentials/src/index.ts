/**
 * Shared credential resolution and message sanitization for the fork's web-search
 * providers. A provider supplies its own `WebError` constructors, so each keeps its own
 * wording while the lookup order and the key-redacting reductions live here once.
 * @module @anago-harness/web-search-credentials
 */

export * from './lookup.ts'
export * from './readers.ts'
export * from './sanitize.ts'
