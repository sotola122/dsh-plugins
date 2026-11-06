/**
 * Response-mapping suite (DESIGN §6.2 単体（写像）): field mapping, missing fields,
 * duplicate URLs, an empty page as a success, and the `truncated` rule that belongs to
 * the seam rather than to the provider.
 * @module @anago-harness/web-search-brave/test/map.spec
 */
import { describe, expect, it } from 'vitest'
import { mapSearchResponse } from '../src/map.ts'
import { bravePayload, braveResult } from './support.ts'

describe('mapSearchResponse', () => {
  it('maps url, title, and description onto the seam’s source shape', () => {
    const result = mapSearchResponse(bravePayload([braveResult('https://example.com/a', 'A', 'Snippet A')]))
    expect(result.sources).toEqual([{ url: 'https://example.com/a', title: 'A', snippet: 'Snippet A' }])
    expect(result.content).toBeUndefined()
  })

  it('omits fields Brave did not supply instead of inventing them', () => {
    const result = mapSearchResponse(bravePayload([{ url: 'https://example.com/a' }]))
    expect(result.sources).toHaveLength(1)
    const source = result.sources[0] as object
    expect(Object.keys(source)).toEqual(['url'])
  })

  it('treats empty strings as absent fields', () => {
    const result = mapSearchResponse(
      bravePayload([{ url: 'https://example.com/a', title: '', description: '', page_age: '', age: '' }]),
    )
    expect(Object.keys(result.sources[0] as object)).toEqual(['url'])
  })

  it('prefers page_age for publishedAt and falls back to age', () => {
    const result = mapSearchResponse(
      bravePayload([
        { url: 'https://example.com/a', page_age: '2026-10-01T00:00:00', age: '2 days ago' },
        { url: 'https://example.com/b', age: '3 weeks ago' },
      ]),
    )
    expect(result.sources[0]?.publishedAt).toBe('2026-10-01T00:00:00')
    expect(result.sources[1]?.publishedAt).toBe('3 weeks ago')
  })

  it('drops results without a usable URL', () => {
    const result = mapSearchResponse(
      bravePayload([{ title: 'No URL' }, { url: '', title: 'Empty URL' }, braveResult('https://example.com/a')]),
    )
    expect(result.sources.map(source => source.url)).toEqual(['https://example.com/a'])
  })

  it('keeps one source per URL', () => {
    const result = mapSearchResponse(
      bravePayload([
        braveResult('https://example.com/a', 'First'),
        braveResult('https://example.com/b', 'Second'),
        braveResult('https://example.com/a', 'Duplicate'),
      ]),
    )
    expect(result.sources.map(source => source.title)).toEqual(['First', 'Second'])
  })

  it('returns an empty successful result for no matches', () => {
    expect(mapSearchResponse(bravePayload([]))).toEqual({ sources: [], truncated: false })
  })

  it('returns an empty successful result for an unexpected body shape', () => {
    for (const payload of [null, undefined, 'text', 42, [], {}, { web: {} }, { web: { results: 'no' } }]) {
      expect(mapSearchResponse(payload)).toEqual({ sources: [], truncated: false })
    }
  })

  it('reports truncated false even when Brave fills the page it was asked for', () => {
    // 契約上 truncated は seam が maxResults のために sources を削ったことを表す。
    // 要求件数ちょうどのページが返っても、プロバイダは削っていないので false。
    const full = bravePayload([braveResult('https://example.com/a'), braveResult('https://example.com/b')])
    expect(mapSearchResponse(full).truncated).toBe(false)
  })

  it('never claims truncation for the seam, whatever Brave returns', () => {
    const overReturned = bravePayload([
      braveResult('https://example.com/a'),
      braveResult('https://example.com/b'),
      braveResult('https://example.com/c'),
    ])
    expect(mapSearchResponse(overReturned).truncated).toBe(false)

    const partlyUnusable = bravePayload([null, 'nope', { title: 'No URL' }, braveResult('https://example.com/a')])
    const result = mapSearchResponse(partlyUnusable)
    expect(result.sources).toHaveLength(1)
    expect(result.truncated).toBe(false)
  })
})
