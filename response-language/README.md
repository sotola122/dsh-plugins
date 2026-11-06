---
description: "Fixed Japanese-response instruction injected as a global system-prompt section."
kind: "package-reference"
---

# @anago-harness/response-language

English | [中文](README.zh.md)

## Summary

TODO: port the upstream plugin summary.

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

TODO: port the upstream usage section.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

TODO: port the upstream implementation notes.

-----

<a id="further-exploration"></a>
## Further Exploration

- [fork group](../README.md) — the package map for this group.

-----

<a id="model-experience"></a>
## Model Experience

### Japanese response instruction

#### What the model sees

One system-prompt section (`response-language`, the last prompt position) whose fixed text begins `Always write your replies to the user in Japanese (日本語)`. Subagent children and assemblies without an agent receive an empty section, which rendering drops.

#### Token effect

A fixed cost of roughly 60 tokens in every request from a main agent on the standard, ptc, or cordis presets; the section is absent for `minimal` and for delegated children.

#### KV Cache effect

The section is part of the stable prompt prefix, so its text is cacheable across turns. Turning `enabled` off or on changes the prefix once, and later requests reuse the new prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- TODO: record the porting gaps.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.
</details>
