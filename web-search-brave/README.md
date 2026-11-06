---
description: "Brave Search provider for the ctx.web capability seam."
kind: "package-reference"
---

# @anago-harness/web-search-brave

English | [中文](README.zh.md)

## Summary

`@anago-harness/web-search-brave` registers a search provider with the DSH web capability seam (`ctx.web`) under the id `brave`. One search is one `GET /res/v1/web/search` request against the Brave Search API; there is no MCP server and no additional process.

The provider re-reads its `Volatile` settings and re-resolves its credential for every search, so a settings change or a new key reaches the next search without re-registering the provider. The model-facing `web_search` tool belongs to `@deepseek-ai/dsh-tool-web`; the `anago-core` bundle selects this provider by setting `web.searchProvider` to `brave`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The bundle owns the row, so this package has no `cordis.patch.yml`. Add the plugin row and select it in the `web` row:

```yaml
- id: web-search-brave
  name: '@anago-harness/web-search-brave'
  config:
    apiKeyEnv: BRAVE_API_KEY
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: brave
    fetchProvider: http
```

Every field below is optional and can be overridden on the `web-search-brave` row.

### Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKey` | (unset) | Literal Brave Search API key with `role: secret`; prefer `apiKeyEnv` so no secret enters configuration files. |
| `apiKeyEnv` | `BRAVE_API_KEY` | Credential reference name with `role: credential-ref`, used by both the credentials service and the launch environment. |
| `baseURL` | `https://api.search.brave.com` | Base URL; `/res/v1/web/search` is appended. Useful for a proxy or a test endpoint. |
| `country` | `JP` | `country` parameter; the empty string sends none. |
| `searchLang` | `jp` | `search_lang` parameter (Brave spells Japanese `jp`). |
| `uiLang` | `ja-JP` | `ui_lang` parameter. |
| `safesearch` | `moderate` | `off`, `moderate`, or `strict`. |
| `freshness` | (unset) | `pd`, `pw`, `pm`, `py`, or `YYYY-MM-DDtoYYYY-MM-DD`; unset sends none. |
| `timeoutMs` | `10000` | Provider-side timeout. Validated at startup and again for each search; invalid values throw instead of being clamped. The upper bound is `30000`, the `web_search` tool's own deadline. |
| `maxResults` | `8` | Upper bound on the requested count. The smaller of `request.maxResults ?? 8` and `maxResults` is clamped into Brave's `1..20` range and sent as `count`. |

The request sends `q` (the DSH query), `count`, `country`, `search_lang`, `ui_lang`, `safesearch`, `freshness`, and the fixed `text_decorations=false`, `spellcheck=true`, `result_filter=web`. It never sends `offset`, `extra_snippets`, or `summary`. A query longer than 400 characters or 50 words is rejected with `WEB_PROVIDER_ERROR` before dispatch, and the message reports the size without echoing the query.

### API key handling

The key is resolved per search, in this order:

1. The configured `apiKey` when it is non-empty.
2. `ctx.credentials.resolve(credentialRef(apiKeyEnv))` when `apiKeyEnv` is a valid reference name and the credentials service exists.
3. `launchEnvironmentOf(ctx).get(apiKeyEnv)` from the launch environment.

The recommended paths are 2 and 3: save the key from the web search settings card, or export `BRAVE_API_KEY` in the launching environment. A key can be replaced without restarting DSH; the next search uses the new value. An empty stored value is treated as absent, matching the credentials seam's rule.

### Error codes

| Situation | Code | Message behavior |
| --- | --- | --- |
| No key from any source | `WEB_PROVIDER_CREDENTIAL_MISSING` | Names the reference and the three places a key can live; never a value. |
| HTTP 401 / 403, or a token-shaped provider code | `WEB_PROVIDER_ERROR` | Suggests a missing, invalid, or unentitled key; carries at most a 200-character body summary with the key redacted. |
| HTTP 400 / 422, or a validation-shaped provider code | `WEB_PROVIDER_ERROR` | States the settings-derived parameters that were sent (`count`, `country`, …). |
| HTTP 429, or a rate/quota provider code | `WEB_PROVIDER_ERROR` | Asks the caller to wait; the provider never retries automatically. |
| HTTP 5xx | `WEB_PROVIDER_ERROR` | Reports a provider-side failure and names the endpoint. |
| Transport failure | `WEB_PROVIDER_ERROR` | Carries the cause, names `baseURL` and the endpoint, and redacts the key from the exception text. |
| Non-JSON success body | `WEB_PROVIDER_ERROR` | One-line summary of at most 200 characters with the key redacted. |
| Provider timeout | `WEB_PROVIDER_ERROR` | States `timeoutMs` and the endpoint. |
| Caller cancellation | `WEB_ABORTED` | No additional detail. |
| No matches | (not an error) | Returns `{ sources: [], truncated: false }`; the tool renders "No results found." |

Every fragment taken from an exception or a response body is reduced with `redactSecret` and `boundedProviderDetail` from `@anago-harness/web-search-credentials`, using the key resolved for that search: the key and its base64 and base64url encodings become `[REDACTED]` before the text is capped at 200 characters. A proxy, gateway, or provider that echoes the request header or the key therefore cannot put either into the message. The `cause` object still carries the unredacted failure for logs.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Plugin entry: `Volatile` config schema, startup timeout validation, provider registration through `ctx.effect`, and the per-search option projection. |
| [`src/provider.ts`](src/provider.ts) | The `BraveSearchProvider`: per-search key resolution, composed cancellation, dispatch, and HTTP classification. |
| [`src/request.ts`](src/request.ts) | Pure request planning: query limits, count clamping, URL and header construction. |
| [`src/map.ts`](src/map.ts) | Pure response mapping to `WebSearchSource`. |
| [`src/errors.ts`](src/errors.ts) | `WebError` construction for every failure class, with the key redacted from untrusted text. |

`available()` returns `URL.canParse(baseURL)` only. It deliberately does not require a locally visible key: the credentials service is asynchronous and cannot be read from the synchronous selection path, so requiring one there would make a credentials-only key unusable. The missing-key failure surfaces at search time instead. Registration goes through `ctx.effect`, so unloading the plugin removes the provider.

The provider holds no mutable state. Every operation snapshots the settings, re-resolves the credential, and composes the caller's signal with `AbortSignal.timeout(timeoutMs)` into one signal for `fetch`, so concurrent `web_search` queries cannot interfere. Requests use `redirect: 'error'` so the subscription token never follows a redirect. A result without a URL is dropped, a repeated URL is kept once, `page_age` becomes `publishedAt` with `age` as the fallback, and a result with no usable highlight is not invented.

`truncated` is always `false` from this provider. The seam owns the `maxResults` bound and sets `truncated` when it cuts sources; Brave returns no total, so a full page is not evidence that the provider itself truncated anything.

-----

<a id="further-exploration"></a>
## Further Exploration

- [fork group](../README.md) — the package map for this group.
- [web service](../../web/web/README.md) — the registry and provider-selection rules this plugin registers into.
- [tool-web](../../web/tool-web/README.md) — the model-facing `web_search` tool that renders these sources.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-web`: the model sees this provider's `maxResults`-bounded URLs, titles, snippets, and publication dates, or its `WebError` failure text under the tool's error wrapper. No generated answer is added because Brave's Web Search API returns sources only.

#### KV Cache effect

The provider itself adds no request prefix; the search tool owns any cache effect, and a changed result set changes only the appended tool result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Web results only.** Images, news, videos, local POIs, summarizer output, pagination, and automatic retries are out of scope.
- **The endpoint contract comes from the upstream MCP implementation.** Field names (`page_age`, `age`) and parameters were taken from the local `@brave/brave-search-mcp-server` source and have not been re-verified against online Brave documentation.
- **Japanese-first defaults.** `country=JP`, `search_lang=jp`, and `ui_lang=ja-JP` are deployment defaults, not API requirements; override them for other locales.
- **No package-owned display metadata.** The port omits `icon.svg` and `locale/*.json`; the `anago-core`/`anago-web` bundles own the display icon and the settings card owns the labels.
- **No ported `cordis.patch.yml`.** Rows live in `anago-core`; installing this package alone registers nothing.
- **No coverage of the upstream 422 token-code precedence in this fork yet beyond unit tests.** The unit suite pins the behavior, but a real-key end-to-end run is not part of the targeted suite.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The port keeps behavior and test logic identical to the source plugin. It changes the package name in module JSDoc tags, adds explicit `.ts` specifiers to relative imports, and renames tests from `*.test.ts` to `*.spec.ts`. The source `cordis.patch.yml`, `icon.svg`, and `locale/*.json` were intentionally not copied because the bundle and settings card own those surfaces.
</details>
