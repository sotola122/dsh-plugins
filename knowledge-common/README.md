---
description: "Shared knowledge-store primitives for the memory and LLM wiki plugins: scanning, entry framing, atomic writes, containment, digests, git probes, and managed .gitignore blocks."
kind: "package-library"
---

# @anago-harness/knowledge-common

English | [中文](README.zh.md)

## Summary

Use this library to implement a durable, file-backed knowledge store with the same safety rules as the memory and wiki plugins. It scans text for secrets and non-ASCII ratios, frames entries with a delimiter, writes files atomically under a lock, checks that a target stays inside its root across symlinks, digests raw sources, probes git state, and maintains a marker-delimited `.gitignore` block. The two side-effecting seams (atomic write and git) are injected, so callers pass them in.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Consume it from a plugin that owns a knowledge store; it registers nothing and depends only on Node built-ins.

| Area | Entry points |
|---|---|
| Scan | `scanText`, `redactSecrets`, `nonAsciiRatio`, `NON_ASCII_WARN_RATIO`, `escapeFrameTagClosers` |
| Entries | `parseDocument`, `serializeDocument`, `documentChars`, `isDuplicateEntry`, `isDelimiterLine`, `normalizeForMatch`, `countCodePoints` |
| Atomic update | `updateFileLocked`, `readTextFileIfExists`, `PRIVATE_FILE_MODE`, `PRIVATE_DIRECTORY_MODE`, `SHARED_FILE_MODE` |
| Containment | `resolveContainedTarget` |
| Approval | `createApprovalGate`, `resolveEffectivePolicy`, `ApprovalPolicy`, `ApprovalServiceLike`, `ApprovalPrompt` |
| Injection | `appendClaimedMessage`, `samePayload` |
| Digest | sha256 over the body after the frontmatter |
| git | `resolveGitRoots`, ignore and tracked-file probes |
| `.gitignore` | Idempotent marker block append or replace, CRLF preserving |

The two seams are structural: `updateFileLocked` accepts `{ withFileLock, writeFileAtomic }` and the git helpers accept `{ run }`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Text normalization removes format characters, applies NFKC, compresses whitespace, and lowercases before matching. Entry framing uses a delimiter-only line and counts code points. Atomic writes create the private directory, take the file lock, read, update, and replace the file; one failure leaves the previous content. Containment resolves the deepest existing ancestor and appends the missing tail before comparing real paths, so `..` and symlinks cannot escape the root. The digest covers the body after the frontmatter to avoid a self-referential record. The `.gitignore` block is found by its marker, replaced in place, and keeps the file's CRLF style.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [memory](../memory/README.md) — the global and workspace stores built on this library.
- [llm-wiki](../llm-wiki/README.md) — the project and global wiki stores built on this library.
- [atomic write](../../util/atomic-write/README.md) — the lock and atomic replacement seam callers inject.

-----

<a id="model-experience"></a>
## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The git helpers run the `git` executable; a caller without git must inject a runner that reports the absent repository state.
- The scanner is heuristic and fixed at `0.1` non-ASCII ratio; the threshold is not configurable per caller.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Ported from the private plugin suite; the public API is unchanged apart from the package name.
</details>
