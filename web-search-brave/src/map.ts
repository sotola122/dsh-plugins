/**
 * Pure mapping from a Brave Web Search response body to the seam's
 * {@link WebSearchResult}. The mapper tolerates missing fields rather than inventing
 * them, drops results without a usable URL, and never turns an empty result page into
 * an error.
 * @module @anago-harness/web-search-brave/map
 */
import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'

/**
 * Map one Brave Web Search response body to the seam's result shape.
 *
 * `web.results[].url` maps to `url`, `title` to `title`, and `description` to
 * `snippet`; a result without a usable URL is dropped and a repeated URL is kept once.
 * `page_age` becomes `publishedAt` when present, `age` otherwise, and the field is
 * omitted when neither is a non-empty string.
 *
 * `truncated` belongs to the seam, which sets it when it drops sources to honor
 * `maxResults`; this mapper returns every source Brave sent and therefore always
 * reports `false`. Brave returns no total, so a full page is not evidence that the
 * provider itself cut anything.
 *
 * @param payload - the parsed response body; anything unexpected maps to no sources.
 * @returns the mapped result; an empty page yields `{ sources: [], truncated: false }`.
 */
export function mapSearchResponse(payload: unknown): WebSearchResult {
  const results = readWebResults(payload)
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const entry of results) {
    if (!isRecord(entry)) continue
    const url = nonEmptyString(entry['url'])
    if (url === undefined || seen.has(url)) continue
    seen.add(url)
    const title = nonEmptyString(entry['title'])
    const snippet = nonEmptyString(entry['description'])
    const publishedAt = nonEmptyString(entry['page_age']) ?? nonEmptyString(entry['age'])
    sources.push({
      url,
      ...title === undefined ? {} : { title },
      ...snippet === undefined ? {} : { snippet },
      ...publishedAt === undefined ? {} : { publishedAt },
    })
  }
  return { sources, truncated: false }
}

/**
 * Read `web.results` as an array without validating its members.
 * @param payload - the parsed response body.
 * @returns the result entries, or an empty array when the shape is absent or wrong.
 */
function readWebResults(payload: unknown): readonly unknown[] {
  if (!isRecord(payload)) return []
  const web = payload['web']
  if (!isRecord(web)) return []
  const results = web['results']
  return Array.isArray(results) ? results : []
}

/** Whether a value is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keep a string only when it carries content, so an absent field stays absent. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
