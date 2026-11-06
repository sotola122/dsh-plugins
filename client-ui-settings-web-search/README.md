---
description: "The Exa and Brave web-search cards on the Plugins page: provider selection, API keys stored through the credentials service, and per-search result bounds."
kind: "package-reference"
---

# @anago-harness/client-ui-settings-web-search

English | [中文](README.zh.md)

## Summary

Open **Plugins** in the sidebar and select **Exa search** or **Brave Search** to choose which provider serves `web_search` and to save its API key. Keys are written through the credentials domain as `EXA_API_KEY` and `BRAVE_API_KEY`, never into a configuration file; both cards read and write the same `web.searchProvider` field, so selecting one clears the other. The cards exist only while the Host serves the matching provider namespace, and nothing is written until **Save**.

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

Mount `@anago-harness/anago-web` in a Web profile; it inserts the single row this package needs.

| Card | Switch writes | Key reference | Other fields |
|---|---|---|---|
| Exa search | `web.searchProvider = exa` | `EXA_API_KEY` | `searchType` |
| Brave Search | `web.searchProvider = brave` | `BRAVE_API_KEY` | `maxResults`, `safesearch` |

A switch that matches the composed value (the shipped default is `exa`) stages a reset instead of storing a copy. An invalid result count blocks the save and keeps the draft. A key the current process environment supplies renders the control disabled, because the credentials domain cannot write over the environment.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The node half is an empty `apply`, present so the package holds a Loader row whose bare specifier the client module system serves the `./client` bundle for. The browser half binds `web`, `web-search-exa`, and `web-search-brave` through `ctx.configForms.get` and registers each card into `plugins.item` under `ctx.configForms.whileServed`. One shared controller holds a `SettingsFormModel` per namespace, derives both switches from the `web` snapshot, and stages the key as a write-only control whose write goes to `remote.credentials.set` and whose state comes from `remote.credentials.describe`. The controller re-reads on `credentials/reference-updated`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [web-search-exa](../web-search-exa/README.md) — the provider the Exa card configures.
- [web-search-brave](../web-search-brave/README.md) — the provider the Brave card configures.
- [upstream web-search card](../../client/ui-settings-web-search/README.md) — the card shape this package follows.
- [credentials](../../credentials/README.md) — the store the keys are written to.

-----

<a id="model-experience"></a>
## Model Experience

None, as the cards configure a provider for a human; the provider package owns the model-facing tool result.

#### KV Cache effect

None; the package assembles and sends no provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The cards expose a subset of the provider configuration; `country`, `searchLang`, `uiLang`, `freshness`, `baseURL`, and `timeoutMs` stay in the profile patch.
- The key literal is never read back, so the page cannot show whether a stored key is still valid at the provider.
- The upstream DeepSeek search card is disabled by `anago-web` while the DeepSeek search rows remain in the base composition.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This package sits outside `packages/client/*`, so the client package verifier does not inspect it; its contract test keeps the `dsh.client` declaration, the `./client` export, and the no-CSS-Modules rule honest.
</details>
