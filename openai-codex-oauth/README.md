---
description: "Sign in to OpenAI Codex (ChatGPT Plus/Pro) through the pi-ai OAuth flow and use Codex models without an API key."
kind: "package-bundle"
---

# @anago-harness/openai-codex-oauth

English | [中文](README.zh.md)

## Summary

This plugin signs a harness installation in to OpenAI Codex through the OAuth browser flow that `llm-pi-ai` already registers for its `openai-codex` catalog provider. It registers no flow of its own: every command calls `ctx.authorization.begin()` for the `llm-pi-ai/openai-codex` credential record, so the pi-ai adapter remains the only writer, and pi-ai keeps refreshing the token inside the credential store.

Five commands drive it: `/codex-login` starts the browser flow and returns the authorization URL, `/codex-code` submits an authorization code or redirect URL when needed, `/codex-status` reports stored credential state and pending prompts, `/codex-cancel` withdraws an attempt, and `/codex-logout` deletes the credential.

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
dsh plugin --profile <profile> add link:/absolute/path/to/packages/fork/openai-codex-oauth
```

The link survives later `dsh plugin` runs because it is a declared dependency. A packaged copy can instead be installed from a tarball (`pnpm pack` in this directory, then `dsh plugin --profile <profile> add <tarball>`). Then add `@anago-harness/openai-codex-oauth` to `dsh.profile.bundles`.

Sign in inside a Session:

1. Run `/codex-login`.
2. Open the printed authorization URL in your browser. If that browser is on another machine, run the printed SSH forward there first (`ssh -N -L 1455:127.0.0.1:1455 <user>@<host>`). The callback listens on `127.0.0.1:1455` of the harness host. While the attempt is signing in, `/codex-status` reprints the forward lead and that command.
3. Finish the sign-in in the browser. The local callback on port 1455 completes the sign-in automatically. If port 1455 is already taken by the Codex CLI, copy the authorization code or redirect URL from the browser and run `/codex-code <value>`.

Then add the model route on the Models settings page: create a provider whose id is exactly `openai-codex`, leave the API key blank, and pick an OpenAI Codex model in the composer's model picker. The route reads the committed `llm-pi-ai/openai-codex` record, and pi-ai refreshes the OAuth token when it is close to expiry.

`/codex-logout` deletes the record; a signed-in Session keeps working until its next request fails authentication, then signing in again restores it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin injects `authorization`, `commands`, and `credentials`. The only authorization call is `ctx.authorization.begin({ key, method: 'oauth', interaction, signal })` against the key `credentialKey('llm-pi-ai', 'openai-codex')`; it never registers a flow, so a profile that also loads the pi-ai adapter has exactly one flow for that key.

The pi-ai `openai-codex` flow first asks a login-method `select` question offering `browser` and `device_code`. The plugin always answers `browser`; device-code login is deliberately never used. The browser flow starts a local OAuth callback server on `http://127.0.0.1:1455/auth/callback`, notifies the authorization URL, and races the local callback against a paste prompt. Because a command cannot stream and cannot answer a prompt later, `/codex-login` resolves as soon as the authorization URL is notified. Its success text keeps that URL on the first line, then says to finish in this browser or forward the callback port, prints `ssh -N -L 1455:127.0.0.1:1455 <user>@<host>` on its own line, and ends with the `/codex-code` line for when port 1455 is already taken by the Codex CLI. `<user>` is `userInfo().username`, or `USER`, then `LOGNAME`, then `user`, when `userInfo()` throws. `/codex-status` reprints only the forward lead and the command while the attempt is signing in. The flow continues in the plugin under an `AbortController` that `/codex-cancel`, `/codex-logout`, and plugin disposal abort, together with `ctx.authorization.cancel(key)`.

`/codex-code` answers the single parked paste prompt with the trimmed input without echoing the value. If the browser callback wins the race, the paste prompt is rejected with a plain error rather than `AuthorizationDeclinedError`, avoiding an unhandled rejection or a recorded human decline. `/codex-status` reads `ctx.credentials.describeRecord(key)`, the attempt phase (`signing-in`, `authorized`, `cancelled`, or `failed`), the pending URL, and whether `/codex-code` expects input. `/codex-logout` aborts any attempt and deletes the record through `ctx.credentials.deleteRecord(key)`.

-----

<a id="further-exploration"></a>
## Further Exploration

- [fork group](../README.md) — the package map for this group.
- [`llm-pi-ai`](../../llm/llm-pi-ai/README.md) — the adapter that registers the OpenAI Codex flow and reads the record at request time.
- [authorization service](../../credentials/authorization/README.md) — the flow registry and the `begin`/`cancel` contract.

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin only obtains a host credential for a human; it registers no prompt section, tool schema, or session event.

#### KV Cache effect

None, as the plugin assembles and sends no provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A command settles once, so the authorization URL appears in the `/codex-login` result rather than as a live stream; `/codex-status` reprints it while the attempt waits.
- The plugin starts the flow only when `llm-pi-ai` offers it. Without the `openai-codex` catalog provider, `/codex-login` reports `NO_FLOW` instead of registering a replacement flow.
- A second sign-in for the same record is refused while one runs; finish it or run `/codex-cancel` first.
- The plugin selects only the browser login flow; device-code login is not supported by this plugin.
- Port 1455 must be free for local browser callbacks; if the Codex CLI occupies port 1455, the flow falls back to manual pasting via `/codex-code`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Tests use fake `authorization`, `commands`, and `credentials` services; `tests/plugin.spec.ts` covers every command branch, including non-Error rejections, paste withdrawal, race conditions, and disposal.
</details>
