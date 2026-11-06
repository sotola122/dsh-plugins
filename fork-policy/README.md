---
description: "Node egress guard that refuses harness-initiated connections to denylisted hosts."
kind: "package-library"
---

# @anago-harness/fork-policy

English | [中文](README.zh.md)

## Summary

`@anago-harness/fork-policy` installs a Node egress guard for hosts the harness contacts on its own, and supplies the profile patch lists the boot composer applies. The guard denies the hosts in `denylist.json` for TCP connects, DNS lookups, and proxy request targets. User-chosen endpoints, including `api.deepseek.com`, stay allowed. Importing the package installs the guard.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Import the package from the process that boots a profile. The import installs the guard before plugins run, and the boot composer spreads the patch lists.

```ts
import { forkDefaultPatches, forkLockPatches, guard } from '@anago-harness/fork-policy'

const defaults = forkDefaultPatches([])
const locks = forkLockPatches([])
guard.verdict('platform.deepseek.com')
```

`forkDefaultPatches` and `forkLockPatches` currently return empty lists. `guard.verdict(host)` returns a reason string when the normalized hostname is denied and `undefined` when the connection may proceed. `api.deepseek.com` is not denied.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The guard patches `net.Socket` connect and write, DNS lookups, and child `NODE_OPTIONS` in the process that loads it. Matching uses ASCII hostnames: exact hosts and listed suffixes, including their subdomains. Loopback names and IP addresses are not denied. No environment variable turns the denylist off. `DSH_FORK_EGRESS_LOG` appends one JSON line per refusal when it is set.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Installs the guard and exports the empty profile patch lists |
| [`egress-guard.cjs`](egress-guard.cjs) | Socket, DNS, and child-process refusal |
| [`denylist.json`](denylist.json) | Hosts and suffixes the guard denies |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Boot package](../../boot/app-boot/README.md) — `readProfilePatches` imports this package.
- [Project guideline](../../../PROJECT_GUIDELINE.md) — the denylist and the static scan.

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are properties of the guard as it runs in the host process.

- **Hostnames, not addresses** — a connection that presents only an IP address is not denied. Name lookup of a denylisted host is denied, and a connect that still carries the denylisted hostname is denied even when a custom lookup returns a local address.
- **Proxy request line** — the first request line on a proxy connection is reassembled across writes. Later requests are inspected only when their request line begins a write.
- **Child preload inside the test runner** — when `VITEST` is set, the guard does not modify `NODE_OPTIONS`. The denylist still applies in the process that loaded the package. Production processes that do not set `VITEST` pass the guard to Node children through `NODE_OPTIONS`.
- **Process that loads app boot** — the guard is installed by importing `@deepseek-ai/dsh-app-boot`'s profile composer. A Node process that never loads that module does not install the guard.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
