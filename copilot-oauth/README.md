---
description: "Sign in to GitHub Copilot through the pi-ai OAuth flow and use Copilot models without COPILOT_GITHUB_TOKEN."
kind: "package-bundle"
---

# @anago-harness/copilot-oauth

English | [中文](README.zh.md)

## Summary

This plugin signs a harness installation in to GitHub Copilot through the OAuth device-code flow that `llm-pi-ai` already registers for its `github-copilot` catalog provider. It registers no flow of its own: every command calls `ctx.authorization.begin()` for the `llm-pi-ai/github-copilot` credential record, so the pi-ai adapter remains the only writer, and pi-ai keeps refreshing the token inside the credential store.

Four commands drive it: `/copilot-login` starts the device flow and prints the verification page and code, `/copilot-status` reports the stored credential and reprints a pending page, `/copilot-cancel` withdraws a running attempt, and `/copilot-logout` deletes the credential.

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

Install the bundle into a profile from this checkout:

```sh
dsh plugin --profile <profile> add link:<repo>/packages/fork/copilot-oauth
```

The link survives later `dsh plugin` runs because it is a declared dependency. A packaged copy can instead be installed from a tarball (`pnpm pack` in this directory, then `dsh plugin --profile <profile> add <tarball>`).

Sign in inside a Session:

1. Run `/copilot-login` for github.com, or `/copilot-login company.ghe.com` for GitHub Enterprise.
2. Open the printed verification URL and enter the printed code.
3. Approve access in the browser. The command keeps polling in the background; run `/copilot-status` to see the pending page again or confirm the result.

Then add the model route on the Models settings page: create a provider whose id is exactly `github-copilot`, leave the token field blank, and pick a Copilot model in the composer's model picker. The route reads the committed `llm-pi-ai/github-copilot` record. That record's `availableModelIds` filters the Copilot model list at request time, and pi-ai refreshes the OAuth token when it is close to expiry.

`/copilot-logout` deletes the record; a signed-in Session keeps working until its next request fails authentication, then signing in again restores it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin injects `authorization`, `commands`, and `credentials`. The only authorization call is `ctx.authorization.begin({ key, method: 'oauth', interaction, signal })` against the key `credentialKey('llm-pi-ai', 'github-copilot')`; it never registers a flow, so a profile that also loads the pi-ai adapter has exactly one flow for that key. `/copilot-login` checks `ctx.authorization.describe(key)` first and stops when that returns undefined.

The Copilot grant asks one text question, the GitHub Enterprise URL or domain, then runs a device-code flow. A blank argument answers that question with an empty string, which the flow accepts as github.com; a non-blank argument is trimmed and sent as the answer. A `select` question is answered only when the argument equals an option id or label. The answer is returned to the flow and is not written to the logger. The plugin's interaction records every notice, resolves the command as soon as a notice carries a page or code, and the flow continues in the plugin after the command returns, under an `AbortController` that `/copilot-cancel`, `/copilot-logout`, and plugin disposal abort, together with `ctx.authorization.cancel(key)`.

`/copilot-status` reads only `ctx.credentials.describeRecord(key)` (presence, kind, writability) and its own notice history; it never reads the record's value. `/copilot-logout` deletes the record through `ctx.credentials.deleteRecord(key)`.

-----

<a id="further-exploration"></a>
## Further Exploration

- [fork group](../README.md) — the package map for this group.
- [`llm-pi-ai`](../../llm/llm-pi-ai/README.md) — the adapter that registers the GitHub Copilot flow and reads the record at request time.
- [authorization service](../../credentials/authorization/README.md) — the flow registry and the `begin`/`cancel` contract.

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin only obtains a host credential for a human; it registers no prompt section, tool schema, or session event.

#### KV Cache effect

None, as the plugin assembles and sends no provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A command settles once, so the verification page appears in the `/copilot-login` result rather than as a live stream; `/copilot-status` reprints it while the attempt waits. The first line of that result carries the verification URL and the code, because a compact command row shows only the first line.
- The plugin starts the flow only when `llm-pi-ai` offers it. Without the `github-copilot` catalog provider, `/copilot-login` reports that no Copilot OAuth flow is registered instead of registering a replacement flow.
- A second sign-in for the same record is refused while one runs; finish it or run `/copilot-cancel` first.
- The command cannot show an interactive chooser. A `select` question is answered only when the login argument equals one option's id or label.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Tests use fake `authorization`, `commands`, and `credentials` services; `tests/plugin.spec.ts` covers every command branch, including the enterprise prompt, a missing flow description, non-Error rejections, and disposal.
</details>
