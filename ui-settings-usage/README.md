---
description: "The Settings page's Usage section: GitHub Copilot, OpenAI Codex, xAI, and OpenCode Go usage, with an expired sign-in renewed through the flow that owns it."
kind: "package-bundle"
---

# @anago-harness/ui-settings-usage

English | [中文](README.zh.md)

## Summary

Open **Settings** and select **Usage** to see one row per LLM provider: its name, its status (loading, available, not supported, sign-in required, or failed), the plan, usage rate, remaining allowance, and reset time it reported, and a short reason when it reported none. An expired OAuth token is renewed before the read through the same path a model request uses; when that cannot happen the row asks you to sign in and the page never starts a sign-in itself. The page sends requests only when it opens or when you select **Refresh**, and a read from the last 30 seconds is reused, so repeated clicks do not reach the providers.

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

Install the bundle into a Web profile from this checkout, then add `@anago-harness/ui-settings-usage` to `dsh.profile.bundles`:

```sh
dsh plugin --profile <profile> add link:/absolute/path/to/plugins/ui-settings-usage
```

Shipped templates do not mount it. A row without a stored credential asks for one: sign in through [`copilot-oauth`](../copilot-oauth/README.md) (`/copilot-login`), [`openai-codex-oauth`](../openai-codex-oauth/README.md) (`/codex-login`), or [`xai-oauth`](../xai-oauth/README.md) (`/xai-login`), and store the OpenCode Go key on the Models page.

| Provider | Row | Source |
|---|---|---|
| `github-copilot` | Plan, per-quota allowance and usage rate, and reset time | `GET https://api.github.com/copilot_internal/user`, or `https://api.<domain>/copilot_internal/user` for an enterprise grant, with the `refresh` token of the `llm-pi-ai/github-copilot` record |
| `openai-codex` | Plan, spend limit (used, limit, remaining, usage rate, reset time), rate-limit windows when the account reports them, and credits | `GET https://chatgpt.com/backend-api/wham/usage` with the `access` token and `accountId` of the `llm-pi-ai/openai-codex` record |
| `xai` | Included credit usage rate and reset time, on-demand spend and cap, and prepaid balance | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` with the `access` token of the `llm-pi-ai/xai` record |
| `opencode-go` | Usage rate and reset time of the rolling, weekly, and monthly windows | `GET https://opencode.ai/zen/go/v1/usage` with the first key found in `opencodeGo.apiKeyEnvs`, then the `llm-pi-ai/opencode-go` record |

Every field is optional and the defaults work without configuration. Set them on the row in the profile's patch; a change applies when the Host next loads the row.

```yaml
- id: ui-settings-usage
  name: '@anago-harness/ui-settings-usage'
  config:
    timeoutMs: 5000
    minRefreshIntervalMs: 60000
    copilot:
      enabled: true
      endpoint: https://proxy.corp.example/copilot_internal/user
    xai:
      enabled: false
    opencodeGo:
      apiKeyEnvs: [OPENCODE_GO_API_KEY]
```

| Field | Default | Effect |
|---|---|---|
| `timeoutMs` | `10000` | Time limit for one provider's read, token renewal and response body included. A whole number from 1 to 120000 |
| `minRefreshIntervalMs` | `30000` | How long a read answers later opens and refreshes instead of a new request. A whole number from 0 to 3600000; `0` reads every time. A changed credential ends the interval early |
| `copilot.enabled`, `openaiCodex.enabled`, `xai.enabled`, `opencodeGo.enabled` | `true` | `false` reports the row as not supported, reads no credential, and sends no request |
| `copilot.endpoint`, `openaiCodex.endpoint`, `xai.endpoint`, `opencodeGo.endpoint` | built in | Replaces the usage URL. It must be `https`, or `http` on a loopback host, and carries no query; any other value fails when the row loads. The xAI read adds `format=credits` to it |
| `opencodeGo.apiKeyEnvs` | `[OPENCODE_GO_API_KEY, OPENCODE_API_KEY]` | Credential references holding the key, tried in order before the stored record |

| Sign-in state | Meaning |
|---|---|
| `not-signed-in` | No credential is stored |
| `token-expired` | The token expired and this profile has no renewal path: no `authorization` service, or no flow offering a renewal for the record |
| `renewal-failed` | The token expired and renewing it failed; the stored record is kept, so **Refresh** retries |
| `token-rejected` | The provider answered 401 |

| Failure | Meaning |
|---|---|
| `credential-unusable` | The record cannot be read, lacks a token, its expiry, or the Codex account, or names an invalid enterprise domain |
| `forbidden` | The provider answered 403 |
| `rate-limited` | The provider answered 429 |
| `http-error` | The provider answered another non-success status, shown in the row |
| `timeout` | `timeoutMs` elapsed |
| `network` | No HTTP response arrived, or the provider answered with a redirect |
| `invalid-response` | The response is not JSON or carries no recognized usage field |
| `host-unavailable` | The browser could not reach the `providerUsage` Remote |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The Host half is `ProviderUsageService`, a `TypertRemoteService` exposing `providerUsage/report`. It injects `credentials`, reads each record on each read, and turns every provider failure into a row carrying a closed reason code, so one provider's failure leaves the other rows intact. One read runs at a time and every caller shares it. A caller's cancellation stops only that caller's wait, so the read finishes and the next open can reuse it; unloading the plugin stops it. The result is retained for `minRefreshIntervalMs` unless `credentials/record-updated` or `credentials/reference-updated` fires, which also keeps a read that started before the change from being retained.

Token renewal goes through `ctx.authorization.renew(key, signal)`, looked up with `ctx.get` because a composition may not mount that service. `llm-pi-ai` registers the renewal on the flow it already owns for each OAuth provider: it calls pi-ai's `Models.getAuth()`, the call a model request makes, so pi-ai decides whether the grant is due and refreshes it under the credential store's lock. This plugin holds no refresh logic and writes no record. A read that hits its time limit during a renewal reports `timeout`; the renewal itself still finishes and commits, because the issuer may already have rotated the token. A token that has not expired stays usable when its early renewal fails. The Copilot read needs no renewal: it authorizes with the long-lived GitHub token in `refresh`, never with the short-lived `access` proxy token.

No provider text crosses to the browser: each response parser copies only the plan, reset times, and numeric usage fields, and the failure codes carry no message. Account identifiers in a response are never read. Logs name the provider and the code, and renewal errors are dropped for the same reason. A token appears only in request headers, and every request sets `redirect: 'error'`, so a redirect cannot carry it to another host.

The browser half mounts the generated `./remote` contribution, then registers a `settings.section` entry with id `usage` while `remote.providerUsage` is available. `UsageController` owns one read at a time: a newer read aborts an older one, and closing the section aborts the read in flight. The section shows when the rows were read, so reused numbers are recognizable.

-----

<a id="further-exploration"></a>
## Further Exploration

- [fork group](../README.md) — the package map for this group.
- [`copilot-oauth`](../copilot-oauth/README.md), [`openai-codex-oauth`](../openai-codex-oauth/README.md), and [`xai-oauth`](../xai-oauth/README.md) — the sign-in commands that produce the grants this package reads.
- [`llm-pi-ai`](../../packages/llm/llm-pi-ai/README.md) — the adapter that owns and refreshes the records.
- [`dsh-authorization`](../../packages/credentials/authorization/README.md) — the seam the renewal goes through.
- [Typert protocol](../../packages/typert/protocol/README.md) — how a Host method becomes the Remote the section calls.

-----

<a id="model-experience"></a>
## Model Experience

None, as the section shows provider usage to a human; it registers no prompt section, tool schema, or session event.

#### KV Cache effect

None; the package assembles and sends no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- All four endpoints are undocumented provider APIs. The tests use fixed fixtures, not live responses, so a different response appears as `invalid-response` or as missing numbers rather than as wrong ones.
- The xAI field names come from a third-party client's documentation (`vct-core` `GrokCreditsConfig`), not from an observed response, and the currency is taken from that documentation's dollar example.
- OpenCode Go's `percent` is read as the share consumed, based on the field's place under `usage`; the provider does not document it.
- `COPILOT_GITHUB_TOKEN` is not read; such a setup reports `not-signed-in`.
- Rows settle together, so every row shows as loading until the slowest provider finishes or reaches `timeoutMs`.
- A failed row is retained like any other for `minRefreshIntervalMs`, so a retry after a network failure may need that long.
- Not shown: Codex `additional_rate_limits` and `model_usage`, the `status` of an OpenCode Go window, and the xAI plan, which the billing endpoint does not carry.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`src/client/index.ts` imports the Remote contribution generated only in `lib/`, so it is excluded from coverage and source tests call `mountUsage` with a stand-in contribution. Host tests run against fake HTTP servers on ephemeral loopback ports, and `tests/support.ts` fails a spec that requests any other host.
</details>
