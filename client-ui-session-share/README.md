---
description: "Read-only composer for a Session another DSH process holds the write lease on: the poll that raises the lock-all block and the states that clear it."
kind: "package-reference"
---

# @anago-harness/client-ui-session-share

English | [中文](README.zh.md)

## Summary

When another DSH process holds a Session's write lease, the Web UI must not become a second writer. This package polls the Host's ownership answer for the Sessions the browser lists and shows a held Session read-only: the composer blocks its input and every control that would resume an Agent. The block clears when that process releases the lease, when the Session leaves the catalog, and when the page unloads. Opening a Session here never takes ownership; it starts no Agent.

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

Mount `@anago-harness/anago-web` in a Web profile; it inserts the single row this package needs, and the browser half reaches the rest through the Session, conversation, and locale services.

| Row | Package |
|---|---|
| `ui-session-share` | `@anago-harness/client-ui-session-share` |

| Field | Default | Meaning |
|---|---|---|
| `ownerPollMs` | `1000` | Milliseconds between ownership probes for the Sessions this page lists. |

The browser half declares this `Config`; the row itself carries no configuration.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The node half is an empty `apply`, present so the package holds a Loader row whose bare specifier the client module system serves the `./client` bundle for. The browser half registers the `sessionShare` dictionary and starts one `SessionOwnershipWatcher`, which subscribes to `ctx.sessions.list`, probes `ctx.remote.session.ownership` for the first 200 listed ids, and writes through `ctx.conversation.blocks`. A `held-elsewhere` answer raises `{ reason: t('composer.heldElsewhere'), lock: 'all' }`; every other answer clears the block the watcher raised, and the watcher keeps a set of its own ids so a block another plugin owns survives the poll. One probe runs at a time, a failed probe keeps the last known ownership and warns once per failure streak, and plugin unload clears every raised block and stops the timer.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [anago-web](../anago-web/README.md) — the bundle that inserts the row.
- [session-controller](../../api/session-controller/README.md) — the Host ownership probe and the browser Session service.
- [ui-conversation](../../client/ui-conversation/README.md) — the composer block registry this plugin writes.
- [Design of the bundled plugins](../../../ANAGO_PLUGINS_DESIGN.md) — package split and the sharing rules.

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin only raises a browser composer block for a human; it registers no prompt section, tool schema, or session event.

#### KV Cache effect

None; the plugin assembles and sends no provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `ownerPollMs` is the browser half's `Config` default; the client entry receives no row configuration today, so a profile cannot change the interval.
- The block is advisory: the Host's write lease remains the rejecting authority, so a prompt that races the first probe fails with an error instead of being prevented.
- At most 200 listed Sessions are probed per poll; a Session past that prefix keeps its last known state.
- An `unknown` answer clears the block because the probe could not decide, so a transient Host probe failure shows the composer as writable until the next poll succeeds; a failed RPC keeps the last state.
- A raised block keeps the copy of the locale that was active when it was raised; switching language does not rewrite it until the Session's state changes.
- No real-composition test ships with the package; the Web profile that mounts `anago-web` is the composed path, and an end-to-end check belongs to the Web test lane.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This package sits outside `packages/client/*`, so the client package verifier does not inspect it; its manifest test keeps the `dsh.client` declaration, the `./client` export, the dev-only browser dependency on schemastery, and the no-CSS-Modules rule honest. The browser half is pinned against the real locale service and a scripted ownership Remote.
</details>
