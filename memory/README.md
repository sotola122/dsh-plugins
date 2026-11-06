---
description: "Persistent agent memory: global and workspace stores, the memory tool, and injected snapshots."
kind: "package-reference"
---

# @anago-harness/memory

English | [中文](README.zh.md)

## Summary

`@anago-harness/memory` gives an agent memory that outlives a session. It owns two global Markdown stores under `$DSH_HOME/memories` (`MEMORY.md` for the agent's notes, `USER.md` for the user profile) and one per-repository store at `<projectRoot>/.dsh/memory/MEMORY.md`, available only inside a git worktree. The `memory` tool applies up to eight add/patch/remove operations to one store under a writer lock, all or nothing. A frozen `<memory-snapshot>` is injected once per session, and `/memory` lists, shows, previews, and resolves staged writes.

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

The `anago-core` bundle inserts the `memory` row into the host profile, so nothing has to be mounted by hand. An empty `config:` block is a complete deployment because every default is the design default.

```yaml
- insert:
    - id: memory
      name: '@anago-harness/memory'
      config:
        limits: { memory: 2200, user: 1375, workspace: 2200 }
        workspace: { enabled: true, manageGitignore: true }
        presets: { exclude: [] }
        writeApproval: ask       # default none; ask enables the prompt and staging
        pending: { maxPerStore: 50 }
        review: { enabled: true, everyTurns: 5, maxRunsPerSession: 4,
                  maxInputBytes: 16384, maxOutputTokens: 1024,
                  timeoutMs: 60000, includeHeadless: false }
        lockWaitMs: 5000
```

| Key | Default | Effect |
|---|---|---|
| `limits.memory` | `2200` | Code-point limit of `$DSH_HOME/memories/MEMORY.md`. |
| `limits.user` | `1375` | Code-point limit of `$DSH_HOME/memories/USER.md`. |
| `limits.workspace` | `2200` | Code-point limit of `.dsh/memory/MEMORY.md`. |
| `workspace.enabled` | `true` | `false` is a global-memory-only deployment; the workspace store disappears from injection, the tool, and the review. |
| `workspace.manageGitignore` | `true` | Write the managed `.gitignore` block before the first workspace write. |
| `presets.exclude` | `[]` | Agent-preset ids excluded from injection, the `memory` tool, and the review. |
| `writeApproval` | `none` | `ask` asks the session's approval policy before a write and stages it when the policy is `never`. |
| `pending.maxPerStore` | `50` | Maximum staged files per store; the next stage fails with `MEMORY_PENDING_FULL`. |
| `review.enabled` | `true` | Run the turn-end review. |
| `review.everyTurns` | `5` | Completed turns accumulated before one review. |
| `review.maxRunsPerSession` | `4` | Review attempts per session, failures included. |
| `review.maxInputBytes` | `16384` | Cap on the transcript excerpt sent to the auxiliary call. |
| `review.maxOutputTokens` | `1024` | Cap on the review's output tokens. |
| `review.timeoutMs` | `60000` | Abort budget for one review call. |
| `review.includeHeadless` | `false` | Whether a headless run lets the review run. |
| `lockWaitMs` | `5000` | Writer-lock budget in milliseconds; on expiry the write fails with `MEMORY_LOCK_TIMEOUT`. |

`presets.exclude` applies to all three surfaces (injection, the `memory` tool, and the review); the default `[]` keeps every preset, `minimal` included. A subagent child is excluded separately by `delegationDepth > 0`.

**Where writes go.** `$DSH_HOME/memories/MEMORY.md` and `USER.md` are created `0600` in a `0700` directory. The workspace store is `<projectRoot>/.dsh/memory/MEMORY.md`, resolved from the session header's `cwd`; a directory that is not a git worktree has no workspace store, and there is no non-git fallback. The workspace store is injectable and writable only after three preconditions hold: a git root resolves, `.dsh/memory/MEMORY.md` is ignored, and no file under `.dsh/memory` is tracked.

**Write approval.** With `writeApproval: ask`, every `memory` call that carries at least one operation is decided by the session's effective policy (`ctx.approval.overrideOf(session) ?? config.policy`, and `never` when the deployment has no approval service). A policy of `ask` returns `{kind:'ask'}` with an English and a Japanese prompt; allowed calls write normally, and a deny, cancel, or missing responder writes nothing. A policy of `never` lets the call through but marks that execution, and the tool stages each operation under `$DSH_HOME/memories/pending/` instead of writing.

**Turn-end review.** Completed turns (`turn/end` with `reason.kind === 'completed'`) accumulate, and the review drains at `agent/status` idle: one auxiliary call when `completed - consumed >= everyTurns` and attempts remain. It is always staged (`source: 'review'`); it never applies anything itself. The call uses the conversation's own provider and model route, runs one round per plugin instance at a time, and is aborted by `agent/disposed`, by unloading the plugin, and by `timeoutMs`; unloading also awaits the round's final staging and sidecar writes. From that idle status until the round settles the plugin holds the agent (`ctx.agents.hold`), so a controller that releases idle agents (`releaseOnIdle`) cannot dispose it in the middle of a review; the hold is released on success, failure, and unload. Before dispatch it appends the exact request (route, system, messages, token cap, and reasoning effort) as the log-only `memory/review-request` event, and a failure logs a warning and consumes one attempt.

**Credentials and secrets.** The plugin stores no API key, token, or credential of its own, and it never asks for one. Every entry passes the `@anago-harness/knowledge-common` content scan on write, on approval, on injection, and on review input and output; secret-shaped text is replaced with `[REDACTED:<kind>]` and the kinds are reported in the tool result. The review reaches the model through `ctx.llm` on the conversation's existing route, so it adds no credential and no new endpoint, and it appends the exact request to the session log as a log-only `memory/review-request` event before dispatch; the response is not logged. Staged files live under `$DSH_HOME` (outside the workspace tree) with `0600`, so a `workspace-write` sandbox cannot plant one.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Three stores share one format: entries separated by a line containing only `§`, an optional leading HTML comment as the header, and a code-point limit per store. A write that would exceed the limit is refused wholesale with `MEMORY_LIMIT_EXCEEDED`, and the refusal lists every resulting entry with its length so the model can consolidate in one call. A file that was edited by hand past its limit is injected in full with an "over the limit" note in the heading.

The tool body locates one store and calls `updateFileLocked` from `@anago-harness/knowledge-common` with `withFileLock` and `writeFileAtomic` from `@deepseek-ai/dsh-atomic-write`: `mkdir(0700)` → lock → read → apply → atomic `0600` write. Everything in the batch is applied inside that lock, so one refused operation can never leave a partial file. The staged path reuses the same function with a guard that re-checks the entry recorded at staging time.

Injection runs on `agent/pre-step` after `next()`. The listener claims the messages that are in the payload by identity, skips a rejected step and the empty first batch, and treats the snapshot as visible when a `user/message` with `source.kind === 'memory'` is either claimed or still on the derived surface; a compaction that shadows it makes the next step re-inject. The snapshot is a durable user message declaring `{kind:'memory', form:'snapshot', sections}`, framed by `<memory-snapshot>` rather than `system-reminder` because memory is reference data, and every entry is escaped so it cannot close the frame early. A child (`delegationDepth > 0`) reads the workspace store only, and `agent/created` also restricts the `memory` tool in the child scope; the tool body's own `MEMORY_READ_ONLY` refusal is the guarantee behind that best effort. Every injection failure is contained per store and logged, because a listener exception ends the turn.

The content scan is the only defense for content that reached a file by hand, through `bash`, or through another agent: memory paths are not denied to `write`/`edit`/`bash`, since `bash` can write them anyway. A refused entry is dropped from the snapshot and counted in the section text.

Approval is a `tools/pre-execute` listener plus a `WeakSet` of executions. `PreToolDecision.allow` has no field for "stage this one", and re-reading the policy cannot tell an approved `ask` from a `never`; the registry hands the same execution object to the waterfall and to `tool.execute`, so the mark is exact and is never consumed. The `/memory` command exposes `list`, `show`, `path`, `pending`, `approve`, `reject`, and `gitignore`. There is no `gitignore remove`; opting out is `workspace.manageGitignore: false` or `workspace.enabled: false`.

The review is three listeners rather than one: `session/event` counts completed turns, `agent/status` drains, and `agent/disposed` aborts. `agent/turn-stopping` and `runMaintenance` are deliberately unused so the review never holds a turn or later input. Each `apply` creates its own runner, so plugin instances never share the single-flight slot; a `ctx.effect` disposer stops new rounds, aborts the in-flight one, and awaits its settlement, including the staging and sidecar writes after the call. The drain holds the agent for the whole round: the hold is taken before the review's first await, disposed in the drain's `finally`, and awaited by the disposer, so neither an idle release nor unload leaves the agent held or aborts the round mid-write. Before dispatch the runner appends the exact request as the log-only `memory/review-request` event. Progress is stored in a sidecar at `$DSH_HOME/memories/review/<sha256(sessionId)>.json` (`reviewRuns`, `consumedCompleted`, `fullNotified`, `lastOutcome`), so a resume continues the same budget. The excerpt walks `deriveMessages()` newest first and keeps only `user` and `model` text blocks up to `maxInputBytes`, plus the current entries; the response must be a single JSON object with at most four operations, which pass the same validation as the tool (scan, delimiter, limit, duplicate, non-ASCII advisory) before they are staged.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin exports and the listener wiring |
| [`src/config.ts`](src/config.ts) | Schemastery configuration and preset filter |
| [`src/tool.ts`](src/tool.ts) | The `memory` tool definition and execution |
| [`src/entries.ts`](src/entries.ts) | Operations, limits, and the non-ASCII advisory |
| [`src/store.ts`](src/store.ts) | Store locations and the locked read-modify-write |
| [`src/workspace.ts`](src/workspace.ts) | Git root, ignore rule, and managed `.gitignore` block |
| [`src/inject.ts`](src/inject.ts) | The `agent/pre-step` snapshot listener |
| [`src/snapshot.ts`](src/snapshot.ts) | Frame, sections, and the snapshot message |
| [`src/approval.ts`](src/approval.ts) | The `tools/pre-execute` gate and staged mark |
| [`src/pending.ts`](src/pending.ts) | Staged files, validation, and approval |
| [`src/command.ts`](src/command.ts) | The `/memory` command |
| [`src/review.ts`](src/review.ts) | Turn-end review scheduling and calls |
| [`src/review-input.ts`](src/review-input.ts) | Transcript excerpt assembly and output parsing |
| [`src/agents.ts`](src/agents.ts) | The structural agent view |
| [`src/errors.ts`](src/errors.ts) | Refusal codes and messages |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [fork group](../README.md) — the package map for this group.
- [`@anago-harness/knowledge-common`](../knowledge-common/README.md) — entry format, content scan, atomic update, and git helpers this package consumes.
- [`anago-core`](../anago-core/README.md) — the bundle that inserts the `memory` row.

-----

<a id="model-experience"></a>
## Model Experience

### Memory tool and results

#### What the model sees

The [`memory` tool schema](src/tool.ts) accepts a `target` (`memory`, `user`, or `workspace`) and up to eight operations (`add` with `text`, `patch` with `old_text` and `text`, `remove` with `old_text`). A read omits `operations`. Results report what was applied, the resulting usage, any `[REDACTED:<kind>]` replacements, the non-ASCII advisory entries, staged ids, and one stable code per refusal (`MEMORY_DUPLICATE`, `MEMORY_NOT_FOUND`, `MEMORY_NOT_FOUND_AMBIGUOUS`, `MEMORY_REJECTED`, `MEMORY_LIMIT_EXCEEDED`, `MEMORY_NO_WORKSPACE`, `MEMORY_NO_IGNORE_RULE`, `MEMORY_GITIGNORE_CONFLICT`, `MEMORY_TRACKED`, `MEMORY_READ_ONLY`, `MEMORY_PENDING_FULL`, `MEMORY_PENDING_UNKNOWN`, `MEMORY_PENDING_STALE`, `MEMORY_PENDING_ALL_LIMIT`, `MEMORY_INVALID_OPERATION`, `MEMORY_DISABLED`, `MEMORY_IO`). A subagent child sees the tool restricted out of its scope and, when it still calls it, receives `MEMORY_READ_ONLY`.

#### Token effect

Fixed schema cost on every request; one compact result per call. An over-limit refusal is the largest result because it repeats every entry with its code-point length, deliberately, so the model can consolidate in one call.

#### KV Cache effect

The schema is prefix-stable while the plugin scope and its definitions are unchanged. Calls and results append after the reusable prefix without invalidating earlier entries.

### Injected snapshot

#### What the model sees

Once per session, after the first claimed message of a turn, the model receives one durable user message framed by `<memory-snapshot>` and `</memory-snapshot>`. It opens with the fixed reference-data preamble, then one section per store: `## Global memory (MEMORY.md)`, `## User profile (USER.md)`, and in a git worktree `## Workspace memory (.dsh/memory/MEMORY.md)`, each with its usage in code points, the scanned entries, and the count of entries the scan refused. A child receives only the workspace section.

#### Token effect

Conditional; normally bounded by `limits.memory` + `limits.user` + `limits.workspace` (5,775 code points by default) plus the framing and headings. A store edited by hand past its limit is injected in full with an over-the-limit note. It is inserted once per session unless compaction shadows it.

#### KV Cache effect

The snapshot is a single user message after the turn's claimed messages, so it is append-only for the remainder of the session. It is not re-inserted on resume or on a later step while it stays on the derived surface, and a re-injection after compaction appears at a later position.

### Turn-end review

#### What the model sees

The auxiliary call sees a fixed system instruction and a transcript excerpt; its proposal is never shown to the conversation. A person resolves it through `/memory pending` and `/memory approve`. The model therefore sees no review output unless a later snapshot or tool read reflects an approved entry.

#### Token effect

One input excerpt (at most `maxInputBytes`, 16 KiB by default) and at most `maxOutputTokens` (1,024) per attempt, independent of the conversation's own request.

#### KV Cache effect

No effect on the conversation's request prefix: the review has its own request, recorded before dispatch as the log-only `memory/review-request` event, which never enters the model surface.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current properties of the ported plugin, not a task backlog.

- **Staged approval is not atomic** — each approved operation is re-checked and written under the store lock, so an operation that went stale does not roll back the ones approved before it. The `approve all` bounds (20 operations, 64 KiB) refuse the whole batch but are not an atomicity guarantee.
- **The content scan is lexical** — the `knowledge-common` rules catch secret shapes and some instruction-shaped text, not meaning. A hand-edited or `bash`-written entry reaches the file unfiltered; the injection scan is the only defense, and it drops refused entries while reporting their count.
- **Memory paths are not denied to `write`/`edit`/`bash`** — a person or an external agent can edit the files, which is intentional; `bash` can write them anyway, so a deny would hide the real boundary.
- **Tracked workspace files are refused** — a repository that already tracks `.dsh/memory` needs `git rm --cached -r .dsh/memory`; the content already committed stays in the history.
- **The managed `.gitignore` block is an ordinary edit** — it appears in `git status`, the plugin does not commit it, and deleting it only makes the next write recreate it. Opting out is `workspace.manageGitignore: false`, not deleting the block.
- **Pending files are not authenticated** — anyone who can write `$DSH_HOME/memories/pending` can plant a well-formed operation; read `/memory pending` before approving, and note that `/memory approve` is not a substitute for reviewing the text.
- **No separate review route** — the review always uses the conversation's provider and model; a dedicated reviewer route is deferred.
- **Review failures are not retried** — an error, timeout, parse failure, or validation failure logs a warning and consumes one attempt.
- **Headless detection is a service probe with a profile-name fallback** — a renamed headless profile that does not publish `headlessStartup` is treated as interactive, so `review.includeHeadless: false` does not exclude it.
- **No real-composition coverage in this repository** — the upstream real-profile integration suite was not ported; the web half of approval (completion and execution of `/memory`, `ctx.approval` behavior, and the Japanese prompt in the approval UI) is unverified here.
- **Coverage is not 100%** — the ported unit suites keep the upstream cases, but the repository-wide per-file coverage gate is not claimed for this package.
- **The generated tool catalog does not list the `memory` tool yet** — `docs/tool-catalog.md` is generated from a package list in `scripts/gen-tool-catalog.ts`, which this port does not modify; the schema is documented from `src/tool.ts` until that registration lands.
- **The managed block still names the upstream package** — `knowledge-common` emits `# >>> dsh-memory (managed by @tep-hardware/dsh-memory)`, which keeps existing blocks compatible; renaming it would require a migration of files already on disk.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Ported from `dsh-plugins/packages/dsh-memory`. The port changes import specifiers (`@anago-harness/knowledge-common`, explicit `.ts` extensions), module JSDoc names, and drops the unused `target` parameter from `assertWithinLimit`/`limitExceededDetail`; behavior is otherwise unchanged. `cordis.patch.yml` is intentionally not shipped because `anago-core` owns the row, and the upstream `tsup` `noExternal` bundling is unnecessary now that `knowledge-common` is a workspace package. Run `./node_modules/.bin/vitest run packages/fork/memory/tests` from the repository root.

</details>
