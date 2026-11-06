---
description: "Shared API-key resolution and key-redacting message reductions for the fork's web-search providers: the credential readers, one ordered lookup, and the sanitizer."
kind: "package-library"
---

# @anago-harness/web-search-credentials

English | [中文](README.zh.md)

## Summary

Use this library from a `ctx.web` search provider that resolves an API key for every operation. It builds the two lazy credential readers — the credentials service and the launch environment — and runs the documented order: a literal configured value first, then the credentials service, then the launch environment. Each provider supplies its own `WebError` factories, so messages and codes stay provider-owned while the lookup order and abort checks live here. It also exports `redactSecret` and `boundedProviderDetail`, which a provider applies before exception text or a response body enters a `WebError` message.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Call `createCredentialReaders` when projecting a settings section into a provider's per-operation options, and `resolveCredentialValue` inside the operation that needs the key.

```ts ignore-check
const readers = createCredentialReaders(ctx, apiKeyEnv)
const options = { apiKey, apiKeyEnv, ...readers, baseURL }

const key = await resolveCredentialValue(options, signal, {
  aborted: abortedSignal => new WebError('search aborted', 'WEB_ABORTED', { cause: abortedSignal.reason }),
  resolutionFailure: (cause, reference) => new WebError(`could not resolve "${reference}"`, 'WEB_PROVIDER_ERROR', { cause }),
  missing: reference => new WebError(`no API key for "${reference}"`, 'WEB_PROVIDER_CREDENTIAL_MISSING'),
})
```

Both readers stay lazy, so a key stored or changed after the plugin loaded reaches the next operation. `resolveCredentialValue` returns a non-empty key or throws one of the caller's three errors; it never throws a key value into a message.

A provider that quotes exception text or a response body in a message must reduce it first, with the key that operation resolved:

```ts ignore-check
const detail = boundedProviderDetail(redactSecret(String(error), key), 200)
```

`redactSecret` replaces the key and its standard base64 (padded and unpadded) and base64url encodings with `[REDACTED]`, and returns the text unchanged when the key is empty or absent, so a failure reported before credential resolution is still safe to reduce. `boundedProviderDetail` strips control characters, collapses whitespace, caps the line at the given limit, and never splits a `[REDACTED]` marker.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`createCredentialReaders` closes over the reference name. The credentials reader first checks `isCredentialRefName`: a name outside the reference grammar can never have a stored record, so it reads as "not set" and the missing-credential path reports it instead of throwing. It then reads `ctx.get('credentials')` per call, so a service registered later is visible, and returns the stored value. The environment reader asks `launchEnvironmentOf(ctx)` for the same name and treats an empty value as absent.

`resolveCredentialValue` is the shared sequence: non-empty literal, abort check, credentials read with its own abort check on failure, non-empty resolved value, abort check, non-empty ambient value, then the caller's `missing` error. An aborted signal always wins over the service failure so cancellation is not reported as a credential problem. Nothing is cached, and the resolved key is returned rather than retained.

`redactSecret` builds one alternation from the key, its standard base64 encoding with and without padding, and its base64url encoding, then replaces every match in a single pass, so a marker is never rescanned. `boundedProviderDetail` normalizes control characters and whitespace before truncating; when the cut would land inside a `[REDACTED]` marker or on a surrogate pair it backs up instead of splitting them.

| File | Role |
| --- | --- |
| [`src/readers.ts`](src/readers.ts) | `createCredentialReaders` and `CredentialReaders`. |
| [`src/lookup.ts`](src/lookup.ts) | `resolveCredentialValue`, `CredentialSources`, and `CredentialLookupErrors`. |
| [`src/sanitize.ts`](src/sanitize.ts) | `redactSecret`, `boundedProviderDetail`, and `REDACTED`. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [web-search-brave](../web-search-brave/README.md) — the Brave provider that reads the literal key, credentials service, and launch environment.
- [web-search-exa](../web-search-exa/README.md) — the Exa provider that shares the same lookup order.
- [credentials](../../credentials/credentials/README.md) — the reference grammar and the credentials service.
- [launch environment](../../util/launch-environment/README.md) — the frozen launch-time environment the second reader uses.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The library reads only the literal, credentials-service, and launch-environment sources; a provider with another source must resolve it before calling here.
- Error wording belongs to the calling provider, so a message change is made there, not here.
- A reference name outside the credential-reference grammar reads as unset; the credentials reader does not report the name as malformed.
- The sanitizer recognizes the exact key and its base64 and base64url encodings. Another encoding, or text that names a secret the provider cannot resolve, is bounded but not redacted.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Extracted from the duplicate credential-reader closures and lookup sequences in the Brave and Exa providers; the providers keep their own predicates and messages.
</details>
