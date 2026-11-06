---
description: "LLM wiki: project and global wiki stores with write, search, and lint tools plus a skill."
kind: "package-reference"
---

# @anago-harness/llm-wiki

English | [中文](README.zh.md)

## Summary

`llm-wiki` gives a session a durable, searchable wiki that lives with a repository, plus a second wiki the user designates for knowledge shared across projects. The model finds what the wikis already say with `wiki_search`, checks links, the catalogue, and `raw/` digests with `wiki_lint`, and writes the global wiki with `wiki_write`, while the project wiki keeps the ordinary `write` and `edit` tools. `raw/` sources stay immutable, and `/wiki status`, `lint`, `reindex`, `repo set`, `repo unset`, and `commit` cover inspection and upkeep. The shipped `anago-core` row mounts the plugin with `global.pagesDir: concepts`.

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

Mount the plugin in a composition, point `global.repo` at a repository or let the user run `/wiki repo set`, and let the model work through the three tools. The common path needs no project-side setup: any git worktree gets a project wiki when a page is first written under `.dsh/wiki/`.

### Two wikis, two write paths

| | project wiki | global wiki |
| --- | --- | --- |
| Where | `<checkout>/.dsh/wiki/` | the top of the repository the user designates |
| Pages | `pages/<slug>.md` | `<global.pagesDir>/<slug>.md` (`pages` by default, `concepts` in the shipped row) |
| Written with | `write` and `edit` | `wiki_write` only; `write` and `edit` there are denied with `WIKI_READ_ONLY` |
| `raw/` | new files allowed; an existing source is refused with `WIKI_RAW_IMMUTABLE` | `wiki_write` creates sources, records the digest, and refuses an existing file |
| Committed by | the branch's pull request when `.dsh/wiki.yml` sets `commit: true` | the user, with `/wiki commit [message]` |

The project wiki root comes from `git rev-parse --show-toplevel` in the session's working directory. A session started below that root can read the wiki but not write it; start `dsh` at the repository root to edit it. A committed wiki follows the branch, so a page written here belongs to this branch and travels with its pull request.

The global wiki is disabled until a repository is designated. `/wiki repo set <path>` validates the path (absolute or `~/...`, an existing git repository top, no overlap with the session's working directory or `$DSH_HOME`), creates the skeleton when missing, and records the choice in `$DSH_HOME/llm-wiki-state/repo.json`; `/wiki repo unset` writes `{"disabled":true}` there. The sidecar wins over `global.repo` in the configuration.

### Mount configuration

```yaml
- name: '@anago-harness/llm-wiki'
  config:
    notice: true
    global:
      repo: ''
      pagesDir: concepts
    writeApproval: none
```

The package has no `dsh.bundle.patch`, so it mounts as a plugin row; a bundle such as `anago-core` owns the row and any preset layering.

| Field | Default | Meaning |
| --- | --- | --- |
| `notice` | `true` | Inject one existence notice per session through `agent/pre-step`. |
| `global.repo` | `''` | Repository that holds the global wiki; empty disables it. The sidecar takes precedence. |
| `global.pagesDir` | `'pages'` | One directory name under the global repository top; `concepts` fits an existing knowledge repository. |
| `writeApproval` | `'none'` | `ask` prompts `wiki_write` when the session's effective approval policy is `ask`; under `never` the write is refused with `WIKI_APPROVAL_UNAVAILABLE`, because nobody can approve it. |
| `write.maxPageBytes` | `65536` | Cap on one page, `index.md`, or `WIKI.md`. |
| `write.maxRawBytes` | `262144` | Cap on one `raw/` source. |
| `search.maxPages` | `5000` | Pages indexed per wiki root; older pages are dropped and reported as `truncated`. |
| `search.maxPageBytes` | `65536` | Page size the index refuses to read. |
| `search.maxPostingBytes` | `67108864` | Posting bytes kept per wiki root. |
| `lint.checks` | `['links','index','raw']` | Default checks for `wiki_lint` and `/wiki lint`; an explicit argument wins. |

### Tools and commands

`wiki_search` queries both wikis' page directories with BM25 and returns at most eight hits with a quoted excerpt. The path in a hit is already the form `wiki_write` accepts. `wiki_lint` runs the configured checks over `project`, `global`, or `all`: `links` resolves `[[slug]]`, `[[global:slug]]`, `[[index]]`, path forms, and `raw/` sources; `index` compares `index.md` with the page directory; `raw` recomputes each recorded SHA-256. `wiki_write` writes the global wiki: complete content or one unique `edit`, page-directory, `raw/`, `index.md`, and `WIKI.md` paths, a computed digest for sources, the size caps, the injection scan, and an atomic replace under a file lock.

`/wiki` exposes the same upkeep from the chat: `status` prints both roots, page counts, write mode, and warnings; `lint [links,index,raw]` runs the named checks or the configured defaults; `reindex` rebuilds both search indexes; `repo set <path>` and `repo unset` manage the global wiki; `commit [message]` stages and commits only the page directory, `raw/`, `index.md`, and `WIKI.md`, and never pushes.

### The raw/ write guard

The `tools/pre-execute` policy inspects `file_path` on `write` and `edit` only, and only for paths under a wiki. An existing project-wiki `raw/` file is refused with `WIKI_RAW_IMMUTABLE`; a new dated source is allowed. Any `write` or `edit` inside the accepted global repository is refused with `WIKI_READ_ONLY`, so the global wiki cannot bypass `wiki_write`'s path rules, digest recording, size caps, or scan. `read` is never stopped. A relative tool path is resolved against the session's current working directory, so a `cd` changes the path the guard inspects and the path the write touches together. The check canonicalises the parent directory, so `..` and a symlinked parent cannot escape `raw/`; the race between the check and the rename remains, and `bash` is outside this policy.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin is one Cordis entry (`src/index.ts`) that registers three tools, one `/wiki` command, four listener registrations across three events, and the wiki skill. It injects `tools`, `skills`, and `commands`; the approval service and the working-directory service are read per call, and an absent approval service counts as `never`, so a deployment without approvals refuses an `ask` write with `WIKI_APPROVAL_UNAVAILABLE` instead of writing unapproved.

Root resolution is asymmetric. The project wiki is found by running `git rev-parse --show-toplevel` in the session's working directory, and writability is a containment test: `<checkout>/.dsh/wiki` must sit inside that directory. The global wiki is resolved once per session, memoised until the designation or the session changes, and validated against the repository top, `$DSH_HOME`, and the session's working directory; an overlap disables it for that session instead of denying access elsewhere.

The search index is in-process and per wiki root. The first search walks the page directory, parses frontmatter and body, and builds BM25 postings; later searches `lstat` every page and reparse only changed files, while a second search within two seconds skips even the directory walk. Nothing is persisted, and `/wiki reindex` drops the cached index.

Writes to the global wiki take a file lock, create parent directories, and replace the file atomically. A `raw/` write computes the SHA-256 of the body after the frontmatter and records it; an existing source is refused before any write. The `.dsh/wiki.yml` parser reads `commit`, tolerates a `version` key, warns on other keys, and treats an unparseable file as `commit: false`, because a cloned repository can plant that file.

| File | Role |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Plugin entry: exports `name`, `inject`, `Config`, and `apply`; registers tools, listeners, command, skill |
| [`src/paths.ts`](src/paths.ts) | Directory and link grammar, page-directory validation |
| [`src/inspect.ts`](src/inspect.ts) | Checkout root, `.dsh/wiki.yml`, ignore state, read-only rule |
| [`src/global.ts`](src/global.ts) | Global repository validation, sidecar, skeleton, per-session state |
| [`src/write.ts`](src/write.ts) | `wiki_write` path rules, digest, caps, atomic write |
| [`src/search.ts`](src/search.ts) | Tokenisation, BM25 index, incremental refresh |
| [`src/lint.ts`](src/lint.ts) | Link, index, and raw-digest checks |
| [`src/guard.ts`](src/guard.ts) | `tools/pre-execute` raw and global-wiki policy |
| [`src/command.ts`](src/command.ts) | `/wiki status`, `lint`, `reindex`, `repo`, `commit` |
| [`SKILL.md`](SKILL.md) | The convention the model loads on demand |

The skill is a registration whose body is read from `SKILL.md` at plugin load; the frontmatter is stripped, so the catalogue entry carries `name`, `description`, and `whenToUse` as fields. The package ships no patch file: bundles own their rows.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [fork group](../README.md) — the package map and the shipped profile bundles.
- [knowledge-common](../knowledge-common/README.md) — the shared atomic-write, git, scan, and path helpers this plugin consumes.
- [anago-core](../anago-core/README.md) — the bundle row that mounts this plugin with `global.pagesDir: concepts`.
- [architecture](../../../docs/architecture.md) — how plugins, registries, and tool policies fit together.
- [tool catalog](../../../docs/tool-catalog.md) — the generated descriptions of `wiki_search`, `wiki_lint`, and `wiki_write`.

-----

<a id="model-experience"></a>
## Model Experience

### Wiki tools and the existence notice

#### What the model sees

The `wiki_search`, `wiki_lint`, and `wiki_write` tool definitions, one existence notice injected at the first step through `agent/pre-step`, and the `llm-wiki` skill only when the model loads it.

#### Token effect

The three tool definitions and the one-line notice are fixed per session; page bodies enter the request only after the model reads them, and a search returns at most eight hits with a 160-character snippet each.

#### KV Cache effect

The tool definitions and the notice occupy a stable prefix: the notice is inserted once and reused across steps, and no wiki content is injected ahead of a read, so later steps reuse the same cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The mechanical checks and the write policy leave the following constraints for the deployment and for review.

- The build must ship `SKILL.md` beside `lib/`: `src/skill.ts` reads it at plugin load, and a missing file fails the load instead of silently registering an empty skill.
- The project-wiki guard is a policy on `write` and `edit`, not a sandbox: `bash` can still change `.dsh/wiki`, and a path component swapped between the containment check and the rename is not re-checked.
- The search index is process-local and rebuilt on load; `truncated: true` reports dropped pages but does not fail the search, and nothing is persisted between processes.
- The global wiki is disabled for a session whose working directory overlaps the wiki repository, so a session started inside it cannot write the wiki through `wiki_write`.
- `wiki_lint` checks links, the catalogue, and raw digests only. Orphan pages, duplicate pages, stale pages, and whether a page is true remain review work.
- The raw-digest check compares the recorded `sha256` with the current body; it proves that the file changed, not who changed it or whether the source was trustworthy.
- No automatic commit or push: `/wiki commit` commits exactly four pathspecs, leaves other staged files alone, and only a person can run it from the chat.
- The port has unit and fake-context coverage only; a live `dsh web` loop check of the skill catalogue, notice rendering, and command completion remains open.
- This package deliberately carries no `cordis.patch.yml`: `anago-core` owns the row, and its `global.pagesDir: concepts` means a repository that keeps pages under `pages/` must override the field.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Ported from `@tep-hardware/dsh-llm-wiki` 0.1.0 at `/data_1/git_workspace/dsh-plugins/packages/dsh-llm-wiki`. Relative imports use explicit `.ts` specifiers, the shared library import became `@anago-harness/knowledge-common`, and module JSDoc names the fork package. `cordis.patch.yml` was not copied; the `anago-core` row owns the mount and sets `global.pagesDir: concepts`. `SKILL.md` sits at the package root, and `src/skill.ts` resolves it with `new URL('../SKILL.md', import.meta.url)`, the same file from `src/` during tests and from built `lib/` in production. Tests: `./node_modules/.bin/vitest run packages/fork/llm-wiki/tests` (13 files, 318 tests).

</details>
