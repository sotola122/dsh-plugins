/**
 * Request-mapping suite (DESIGN §6.2 単体（リクエスト）): `q`, `count` clamping, the
 * query limits, omitted empty settings, and the fixed parameters.
 * @module @anago-harness/web-search-brave/test/request.spec
 */
import { WebError } from '@deepseek-ai/dsh-web'
import { describe, expect, it } from 'vitest'
import {
  BRAVE_COUNT_MAX,
  BRAVE_COUNT_MIN,
  BRAVE_DEFAULT_COUNT,
  BRAVE_QUERY_MAX_CHARS,
  BRAVE_QUERY_MAX_WORDS,
  BRAVE_WEB_SEARCH_PATH,
  buildSearchEndpoint,
  buildSearchHeaders,
  buildSearchPlan,
  clampCount,
  describeSearchSettings,
  resolveCount,
  type BraveSearchSettings,
} from '../src/request.ts'

const BASE_URL = 'https://api.search.brave.com'

/** Settings with every field defaulted, so one test can vary one field. */
function settings(overrides: Partial<BraveSearchSettings> = {}): BraveSearchSettings {
  return {
    country: 'JP',
    searchLang: 'jp',
    uiLang: 'ja-JP',
    safesearch: 'moderate',
    maxResults: BRAVE_DEFAULT_COUNT,
    ...overrides,
  }
}

/** Query parameters of a planned URL. */
function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams
}

describe('clampCount / resolveCount', () => {
  const cases: ReadonlyArray<readonly [string, number | undefined, number, number]> = [
    ['defaults to 8 when the caller sets no bound', undefined, 8, BRAVE_DEFAULT_COUNT],
    ['honours the caller bound below the configured bound', 3, 8, 3],
    ['honours the configured bound below the caller bound', 20, 5, 5],
    ['clamps above Brave’s maximum', 50, 50, BRAVE_COUNT_MAX],
    ['clamps below Brave’s minimum', 0, 8, BRAVE_COUNT_MIN],
  ]
  for (const [title, requested, configured, expected] of cases) {
    it(title, () => {
      expect(resolveCount(requested, configured)).toBe(expected)
    })
  }

  it('keeps a non-finite count out of the query string', () => {
    expect(clampCount(Number.NaN)).toBe(BRAVE_DEFAULT_COUNT)
    expect(clampCount(Number.POSITIVE_INFINITY)).toBe(BRAVE_DEFAULT_COUNT)
    expect(resolveCount(4, Number.NaN)).toBe(BRAVE_DEFAULT_COUNT)
  })

  it('truncates a fractional count', () => {
    expect(clampCount(2.9)).toBe(2)
  })
})

describe('buildSearchPlan', () => {
  it('maps the DSH query to q against the Web Search path', () => {
    const plan = buildSearchPlan(BASE_URL, settings(), { query: 'deepseek harness' })
    const url = new URL(plan.url)
    expect(url.origin + url.pathname).toBe(`${BASE_URL}${BRAVE_WEB_SEARCH_PATH}`)
    expect(url.searchParams.get('q')).toBe('deepseek harness')
    expect(plan.endpoint).toBe(`${BASE_URL}${BRAVE_WEB_SEARCH_PATH}`)
    expect(plan.count).toBe(BRAVE_DEFAULT_COUNT)
  })

  it('tolerates a trailing slash on baseURL', () => {
    expect(buildSearchEndpoint('https://proxy.example/brave/')).toBe('https://proxy.example/brave/res/v1/web/search')
  })

  it('sends the fixed parameters and never the excluded ones', () => {
    const params = paramsOf(buildSearchPlan(BASE_URL, settings(), { query: 'q' }).url)
    expect(params.get('text_decorations')).toBe('false')
    expect(params.get('spellcheck')).toBe('true')
    expect(params.get('result_filter')).toBe('web')
    for (const excluded of ['offset', 'extra_snippets', 'summary']) {
      expect(params.has(excluded)).toBe(false)
    }
  })

  it('sends the settings-derived parameters as configured', () => {
    const params = paramsOf(
      buildSearchPlan(BASE_URL, settings({ freshness: 'pw', safesearch: 'strict' }), { query: 'q' }).url,
    )
    expect(params.get('country')).toBe('JP')
    expect(params.get('search_lang')).toBe('jp')
    expect(params.get('ui_lang')).toBe('ja-JP')
    expect(params.get('safesearch')).toBe('strict')
    expect(params.get('freshness')).toBe('pw')
  })

  it('omits empty settings instead of sending blank parameters', () => {
    const params = paramsOf(
      buildSearchPlan(
        BASE_URL,
        settings({ country: '', searchLang: '', uiLang: '', safesearch: '', freshness: '' }),
        { query: 'q' },
      ).url,
    )
    for (const omitted of ['country', 'search_lang', 'ui_lang', 'safesearch', 'freshness']) {
      expect(params.has(omitted)).toBe(false)
    }
    expect(params.get('q')).toBe('q')
  })

  it('applies the caller bound to the outgoing count', () => {
    const params = paramsOf(buildSearchPlan(BASE_URL, settings(), { query: 'q', maxResults: 3 }).url)
    expect(params.get('count')).toBe('3')
  })
})

describe('query limits', () => {
  it('accepts a query of exactly 400 characters', () => {
    const query = 'x'.repeat(BRAVE_QUERY_MAX_CHARS)
    expect(() => buildSearchPlan(BASE_URL, settings(), { query })).not.toThrow()
  })

  it('rejects a query longer than 400 characters before dispatch', () => {
    const query = 'x'.repeat(BRAVE_QUERY_MAX_CHARS + 1)
    expect(() => buildSearchPlan(BASE_URL, settings(), { query })).toThrow(WebError)
    expect(() => buildSearchPlan(BASE_URL, settings(), { query })).toThrow(/400 characters/u)
  })

  it('accepts 50 words and rejects 51', () => {
    const words = (count: number): string => Array.from({ length: count }, (_, index) => `w${index}`).join(' ')
    expect(() => buildSearchPlan(BASE_URL, settings(), { query: words(BRAVE_QUERY_MAX_WORDS) })).not.toThrow()
    expect(() => buildSearchPlan(BASE_URL, settings(), { query: `${words(BRAVE_QUERY_MAX_WORDS)} extra` })).toThrow(
      /50 words/u,
    )
  })

  it('does not count trailing blanks as a word', () => {
    const words = (count: number): string => Array.from({ length: count }, (_, index) => `w${index}`).join(' ')
    expect(() => buildSearchPlan(BASE_URL, settings(), { query: `  ${words(BRAVE_QUERY_MAX_WORDS)}  ` })).not.toThrow()
  })

  it('reports the offending size without echoing the query', () => {
    const query = 'secret-term '.repeat(40)
    const error = (() => {
      try {
        buildSearchPlan(BASE_URL, settings(), { query })
        return undefined
      } catch (thrown: unknown) {
        return thrown
      }
    })()
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
    expect((error as WebError).message).not.toContain('secret-term')
  })
})

describe('buildSearchHeaders / describeSearchSettings', () => {
  it('sends Accept and the subscription token', () => {
    expect(buildSearchHeaders('a-key')).toEqual({
      'Accept': 'application/json',
      'X-Subscription-Token': 'a-key',
    })
  })

  it('describes only the settings-derived parameters actually sent', () => {
    const plan = buildSearchPlan(BASE_URL, settings({ freshness: '' }), { query: 'q' })
    expect(describeSearchSettings(plan.params)).toBe(
      'count=8, country=JP, search_lang=jp, ui_lang=ja-JP, safesearch=moderate',
    )
  })

  it('renders a JSON-sourced null as an empty value', () => {
    const params = JSON.parse('{"country":null,"search_lang":"en"}') as Record<string, string>
    expect(describeSearchSettings(params)).toBe('country=, search_lang=en')
  })
})
