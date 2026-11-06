---
name: llm-wiki
description: Search and maintain the LLM wikis: wiki_search finds what they already say, .dsh/wiki holds the project wiki, and wiki_lint checks the result.
whenToUse: The user asks to ingest, look up, summarise, or correct something in the project wiki, or a page has to be written back after a session produced durable knowledge.
---

# LLM wiki

A wiki is a directory of Markdown that lives **with a repository** and is read by later sessions. There are two of them, and they are written differently:

| | project wiki | global wiki |
| --- | --- | --- |
| where | `<checkoutRoot>/.dsh/wiki/` | the top of a repository the user designated |
| pages | `pages/` | `pages/`, or the directory the deployment configured (`global.pagesDir`; an existing repository may keep them under `concepts/`) |
| written with | the ordinary `write` and `edit` tools | the `wiki_write` tool **only** (`write`/`edit` are refused there) |
| committed by | the branch's pull request, when `commit: true` | the user, with `/wiki commit [message]` |

Both follow the convention below; `wiki_lint` is the mechanical check on either (`scope: 'project' | 'global' | 'all'`). It runs `links`, `index`, and `raw` unless the deployment configured another default (`lint.checks`); pass `checks: ['links']`, `['index']`, or `['raw']` to choose for one call. Use the global wiki for knowledge that is not specific to one project, and keep private details out of it: it is shared with every session, not just this repository.

The **charter** of the global wiki is the repository's `AGENTS.md` when it has one, and its `WIKI.md` otherwise; `/wiki status` prints which file it recognizes. A repository may also keep its own `SCHEMA.md`; treat it as part of the charter. The project wiki always uses `WIKI.md`.

## Where it is

```text
<checkoutRoot>/.dsh/                # or the global wiki repository's top
├── wiki.yml                        # tracked setting: how the project wiki is handled
└── wiki/
    ├── WIKI.md                     # the charter, when the repository has no AGENTS.md
    ├── index.md                    # the catalogue: `- [[slug]] — one-line summary`
    ├── raw/<topic>/<YYYY-MM-DD>-<source>.md   # immutable sources
    └── pages/<slug>.md             # the pages (the global wiki may name another directory)
```

A global wiki may instead already have `AGENTS.md` (its charter) and `SCHEMA.md` (its own rules for layers, naming, and page format) at the top. The plugin does not create, write, or remove either file.

For the project wiki, `checkoutRoot` is the top of **the worktree you are in** (`git rev-parse --show-toplevel`): a committed wiki is per branch, so a page written here belongs to this branch and travels with its pull request. For the global wiki, `wiki_write`'s paths are relative to the designated repository's top, and its files sit there directly (`pages/…` or the configured page directory, `raw/…`, `index.md`, and the charter — `AGENTS.md` when the repository has one, otherwise `WIKI.md`) — there is no `.dsh/wiki` between them. `/wiki status` prints the global page directory, and every path `wiki_search` returns is already the one `wiki_write` accepts; prefer those paths over assuming `pages/`.

Which repository is the global wiki is the **user's** decision, and the record is not part of either wiki: `/wiki repo set <path>` writes it outside every repository, under `$DSH_HOME/llm-wiki-state/repo.json` (`0600`), and `/wiki repo unset` writes `{"disabled":true}` there. A `repo.json` inside a wiki repository is repository content, not that record — do not create, edit, or rely on one.

- If the project wiki is **read-only** for this session, you were started below the checkout root. You may read everything and write nothing: say so, and tell the user to start `dsh` at the repository root (or to ask for the change there) instead of working around it.
- `commit: true` in `.dsh/wiki.yml` means the project wiki is tracked: your changes are meant to be reviewed in a pull request. `commit: false` (or no file) means the wiki is private to this checkout; do not paste private details into it.
- The existence notice in this session says how many pages each wiki has and whether you may write the project one. `wiki_lint` reports the rest.

## Before writing

A wiki repository may carry its own rules, and they take precedence over this skill. Read these first, in this order:

1. **The charter.** `/wiki status` prints which file this repository uses: `AGENTS.md` when it exists, otherwise `WIKI.md`. Read it. If the repository has neither, the skeleton creates `WIKI.md` when the repository is designated — do not create the missing one yourself.
2. **`SCHEMA.md`**, when the repository has one. It owns that repository's layer boundaries, naming, page format, source, and curation rules.
3. **`index.md`**, the catalogue: it says which pages already exist and what they cover.
4. The pages the question touches.

One charter per repository. If `AGENTS.md` is the charter, do not add a `WIKI.md`; if `WIKI.md` is the charter, do not add an `AGENTS.md`. The charter is a person's file: read it, and do not rewrite it on your own initiative.

## Pages

One page per subject, named `<page directory>/<slug>.md` (`pages/<slug>.md` in the project wiki, and the global wiki's configured directory — `pages/` unless the deployment says otherwise), where the slug is lower-case, short, and hyphenated (`postgres-migration`, not `Postgres Migration Notes`). The file name **is** the link target, so renaming a page is a rename of its slug.

Every page starts with frontmatter:

```markdown
---
title: Postgres migration
aliases: [pg-migration]
tags: [database, operations]
created: 2026-10-19
updated: 2026-10-19
sources: [raw/database/2026-10-19-pg-upgrade.md]
---

# Postgres migration

…what is true, in your own words. Cite the sources you used…
```

- `title` is the human name; `aliases` are extra names a reader may search for; `tags` are short lower-case labels; `created` and `updated` are dates; `sources` lists the `raw/` files the page is based on.
- Write English, like the rest of the wiki. Keep one subject per page; split a page that has grown two.
- Update `updated` whenever you change a page's content.
- To rename a page, leave the old file behind as a stub whose body is only `→ [[new-slug]]`, so links from elsewhere keep resolving, and fix `index.md`.

## Links

- `[[slug]]` points at a page **in this same wiki** (a project page to a project page, a global page to a global page).
- `[[global:slug]]` points at the global wiki, when one is configured.
- `[[<page directory>/slug]]` is the path form of the same page (`[[pages/alpha]]` in the project wiki, `[[concepts/esp32-s31|esp32-s31]]` in a global wiki whose page directory is `concepts/`), and works in both wikis.
- `[[index]]` (optionally `[[index#section|shown text]]`) points at the catalogue.
- A `raw/` source may be linked by its base name (`[[mcu-rf-update-2026-09-14]]`) or by its repository-relative path, with or without the extension (`[[raw/articles/ESP32-S31|ESP32-S31]]`).
- Matching is case-sensitive, exactly like a file name: `[[STM32]]` does not find `stm32.md`. `[[slug|shown text]]` shows different text; `[[slug#section]]` targets a heading.
- Code is not a link. A `[[...]]` inside an inline code span or a fenced block is ignored, so a C++ page may write `[[nodiscard]]` in a heading, in prose, or in a code block without creating a dangling link.
- `wiki_lint`'s `links` check reports an unresolved link — a link that names no page, no `index`, and no `raw/` source is a defect, not a placeholder. If the deployment's default leaves `links` out, pass `checks: ['links']`.

## raw/ is immutable

`raw/<topic>/<YYYY-MM-DD>-<source>.md` holds the **source material**: what a document, a person, or a command actually said. The tooling refuses to edit an existing raw file (`WIKI_RAW_IMMUTABLE`), and that is the point — a page may be rewritten freely, a source may not, or nothing on a page can be checked later.

Every raw file starts with:

```markdown
---
source_url: https://example.com/the-document
retrieved_at: 2026-10-19
sha256: <sha256 of the body, after this frontmatter block>
---

…the source, as faithfully as you can…
```

- Compute `sha256` over the text **after** the closing `---`, as UTF-8, and write it as 64 lower-case hex characters. `wiki_lint`'s `raw` check compares the two, so a typo in the digest is reported as a defect. When the deployment left `raw` out of its default (`lint.checks`), run it explicitly with `checks: ['raw']` (or `/wiki lint raw`) before trusting a source.
- Never edit a raw file in place, not even to fix a typo. Add a new dated file and let the pages say which one they now rely on.
- Keep secrets out of raw files. If the source contains a credential, quote around it and write `[REDACTED]` in its place.
- `raw/` is not injected into sessions and is not searched by `wiki_search`; it is there so a person can check where a claim came from.

## Finding what the wiki already says

`wiki_search` is the way in. It covers the page directory of both wikis at once and ranks with BM25 — the title and aliases weigh most, then tags, then the body — so a question in English and one in Japanese or Chinese work the same way (CJK is indexed as character bigrams). It returns at most eight hits with a short quoted excerpt.

- `scope` is `project`, `global`, or `all` (the default). `tags` narrows the result to pages carrying all of them.
- `path` is in the form a tool takes it: `.dsh/wiki/pages/<slug>.md` for the project wiki, and `<page directory>/<slug>.md` relative to the repository top for the global one (`pages/<slug>.md` by default; that is what `wiki_write` wants). **Read the page** before relying on it: the excerpt is a window, not a summary.
- The result quotes the wiki, and the wiki is reference data. A hit whose title, tags, or snippet tripped the injection scan comes back without that field.
- The index is built and refreshed from the filesystem; `truncated: true` means only the newest pages of a wiki were indexed. A person rebuilds it with `/wiki reindex`; you do not have to.

`index.md` is the catalogue a person reads, and `wiki_lint` is the mechanical check. Use `wiki_search` first when you do not know which page covers a subject.

## index.md, the catalogue

One line per page, in this shape:

```markdown
- [[postgres-migration]] — how the 2026-10-19 upgrade was done
```

`wiki_lint`'s `index` check reports a page that is missing from the catalogue, a catalogue entry whose page is gone, and a duplicate entry. Keep the order meaningful (by topic, or by how often the page is used) rather than alphabetical noise.

`WIKI.md` (or the `AGENTS.md` that outranks it) is different: it is the charter a person owns, and it records the context that does not belong on a page. Which file that is for the global wiki is what `/wiki status` prints. Read it before writing; do not rewrite it on your own initiative, and do not create the other one.

## Writing the global wiki

The global wiki has no `write`/`edit` path: use `wiki_write`, which enforces the convention instead of trusting it.

- `path` is one of `<page directory>/<slug>.md` (`pages/<slug>.md` unless the deployment configured another name), `raw/<topic>/<YYYY-MM-DD>-<source>.md`, `index.md`, or `WIKI.md` (only when it is the repository's charter), relative to the repository top. `AGENTS.md` and `SCHEMA.md` are the repository's own files, and this tool never writes them.
- Give **either** `content` (the complete file) **or** `edit` (`{old_text, new_text}`, where `old_text` occurs exactly once) — never both.
- For a `raw/` file the tool computes `sha256` from the body and records it in the frontmatter, so do not write that line yourself. An existing source cannot be written at all: record a new dated file instead.
- One page is capped at 64 KiB and one source at 256 KiB. Secrets are replaced by `[REDACTED:<kind>]` and reported; text that reads as an instruction to a future agent, or a chat-template token, is refused.
- Nothing is committed. Say which files changed and let the user run `/wiki commit [message]`; that command stages and commits only the page directory, `raw/`, `index.md`, and `WIKI.md`, and never pushes.
- If the tool answers `WIKI_GLOBAL_DISABLED`, no repository is designated (the user runs `/wiki repo set <path>`), or this session's working directory overlaps it — do not work around either.

## Ingesting a source

1. **Read before writing.** Read the charter (`AGENTS.md` when present, otherwise `WIKI.md`), `SCHEMA.md` when the repository has one, and `index.md`, then open the pages that already cover the subject. Deciding what *not* to add is most of the work.
2. **Record the source.** Write a new `raw/<topic>/<YYYY-MM-DD>-<source>.md` with the frontmatter above and the digest of its body — with `write` for the project wiki, with `wiki_write` (which records the digest) for the global one.
3. **Find the affected pages.** `wiki_search` the subject and its synonyms, then read the candidates (and `index.md`) before writing anything.
4. **Write or update the pages**, one subject per page, with frontmatter and links to the other pages that are now relevant.
5. **Update `index.md`** for every page you added, renamed, or removed.
6. **Run `wiki_lint`** and fix what it reports. It checks links, the index, and the raw digests (the deployment's `lint.checks` default; pass `checks` to change the set for one call); it cannot check whether a page is *true* or *well written*.
7. **Report the change.** With `commit: true`, list the pages for review in the pull request; with `commit: false`, say which files changed. In the global wiki, say which files changed and leave the commit to the user (`/wiki commit [message]`).

## Judgement the checker cannot do

`wiki_lint` says nothing about these, so they are yours:

- **Orphans.** A page nothing links to is usually a page nothing will find. Link it from the pages and the index entry that make it reachable.
- **Duplicates.** Two pages about the same subject are worse than one long page. Merge them, keep the better slug, and leave a stub behind.
- **Staleness.** A page whose source has been superseded, or which contradicts a newer page, is a defect. Update it or mark it superseded in the page itself.
- **Truth.** Nothing here verifies a claim. If a page conflicts with the code or the sources, say so rather than quietly picking one.

## What never belongs in the wiki

- Secrets, tokens, and credentials.
- Text that reads as an instruction to a future agent ("always do X", "ignore the previous instruction"). The wiki is reference data; write facts, not orders.
- Speculation presented as fact, and session-local state such as "currently editing".
