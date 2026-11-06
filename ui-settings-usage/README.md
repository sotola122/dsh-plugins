---
description: "The Settings page's Usage section: GitHub Copilot quota, and an explained unsupported state for the other LLM providers."
kind: "package-bundle"
---

# @anago-harness/ui-settings-usage

English | [中文](README.zh.md)

## Summary

Open **Settings** and select **Usage** to see one row per LLM provider: its name, its status (loading, available, not supported, or failed), the numbers it reported, and a short reason when it reported none. GitHub Copilot quota is read with the stored OAuth grant. OpenAI Codex, xAI, and OpenCode Go show as not supported with the basis for that state, because their adapters define no usage endpoint. The page sends a request only when it opens or when you select **Refresh**, so an offline Host shows failed rows on this page and nothing else changes.

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
dsh plugin --profile <profile> add link:/absolute/path/to/packages/fork/ui-settings-usage
```

Shipped templates do not mount it. The Copilot row needs a sign-in through [`copilot-oauth`](../copilot-oauth/README.md) (`/copilot-login`); without one the row reports that you are not signed in.

| Provider | Row | Source |
|---|---|---|
| `github-copilot` | Plan, per-quota allowance, and reset time | `GET https://api.github.com/copilot_internal/user`, or `https://api.<domain>/copilot_internal/user` for an enterprise grant, with the `refresh` token of the `llm-pi-ai/github-copilot` record |
| `openai-codex` | Not supported | The adapter reads `plan_type` and `resets_at` only from failed requests and defines no usage endpoint |
| `xai` | Not supported | The adapter defines the model API and the sign-in flow but no usage endpoint |
| `opencode-go` | Not supported | The adapter defines only the `OPENCODE_API_KEY` reference and no usage endpoint |

Every field is optional and the defaults work without configuration. Set them on the row in the profile's patch; a change applies when the Host next loads the row.

```yaml
- id: ui-settings-usage
  name: '@anago-harness/ui-settings-usage'
  config:
    timeoutMs: 5000
    copilot:
      enabled: true
      endpoint: https://proxy.corp.example/copilot_internal/user
```

| Field | Default | Effect |
|---|---|---|
| `timeoutMs` | `10000` | Time limit for each provider request, response body included. A whole number from 1 to 120000 |
| `copilot.enabled` | `true` | `false` reports the row as not supported, reads no credential, and sends no request |
| `copilot.endpoint` | derived from the grant | Replaces the quota URL. It must be `https`, or `http` on a loopback host, and carries no query; any other value fails when the row loads |

| Failure | Meaning |
|---|---|
| `not-signed-in` | No OAuth grant is stored |
| `credential-unusable` | The record cannot be read, lacks a token, or names an invalid enterprise domain |
| `unauthorized` | The provider answered 401 or 403 |
| `rate-limited` | The provider answered 429 |
| `http-error` | The provider answered another non-success status, shown in the row |
| `timeout` | `timeoutMs` elapsed |
| `network` | No HTTP response arrived, or the provider answered with a redirect |
| `invalid-response` | The response is not JSON or carries no recognized usage field |
| `host-unavailable` | The browser could not reach the `providerUsage` Remote |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The Host half is `ProviderUsageService`, a `TypertRemoteService` exposing `providerUsage/report`. It injects `credentials` and reads the record on each call, so a refreshed grant reaches the next read without a restart. `readCopilotUsage` turns every failure into a row carrying a closed reason code, and only caller cancellation rejects; a failed Copilot read therefore leaves the other rows intact.

No provider text crosses to the browser: the response parser copies only the plan, the reset date, and the numeric quota fields, and the failure codes carry no message. Logs name the provider and the code. The token appears only in the `Authorization` header, and the request sets `redirect: 'error'`, so a redirect cannot carry it to another host.

The browser half mounts the generated `./remote` contribution, then registers a `settings.section` entry with id `usage` while `remote.providerUsage` is available. `UsageController` owns one read at a time: a newer read aborts an older one, and closing the section aborts the read in flight.

-----

<a id="further-exploration"></a>
## Further Exploration

- [fork group](../README.md) — the package map for this group.
- [`copilot-oauth`](../copilot-oauth/README.md) — the sign-in commands that produce the grant this package reads.
- [`llm-pi-ai`](../../packages/llm/llm-pi-ai/README.md) — the adapter that owns and refreshes the record.
- [Typert protocol](../../packages/typert/protocol/README.md) — how a Host method becomes the Remote the section calls.

-----

<a id="model-experience"></a>
## Model Experience

None, as the section shows provider quota to a human; it registers no prompt section, tool schema, or session event.

#### KV Cache effect

None; the package assembles and sends no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `copilot_internal/user` is an undocumented GitHub API. The tests use a fixed fixture of the expected fields, not a live response, so a different response appears as `invalid-response` or as missing numbers rather than as wrong ones.
- A `COPILOT_GITHUB_TOKEN` environment value or an API-key record is not read; such a setup reports `not-signed-in`.
- Rows settle together, so every row shows as loading until the Copilot read finishes or reaches `timeoutMs`.
- The unsupported providers stay that way until a usage endpoint is established for them. Adding one means adding a reader beside `src/copilot.ts`, a per-provider config field, and its row in `report`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`src/client/index.ts` imports the Remote contribution generated only in `lib/`, so it is excluded from coverage and source tests call `mountUsage` with a stand-in contribution. Host tests run against a fake HTTP server on an ephemeral loopback port.
</details>
