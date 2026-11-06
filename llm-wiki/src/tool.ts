/**
 * The `wiki_lint` tool (DESIGN §6.6).
 *
 * It is a read-only check over one or both wikis: it never writes a page, and
 * it never repairs anything. Its contract is §6.6's:
 *
 * ```ts
 * wiki_lint({ scope?: 'project' | 'global' | 'all', checks?: ('links' | 'index' | 'raw')[] })
 *   → { issues: { scope, kind, path, detail }[] /* ≤ 50 * /, summary }
 * ```
 *
 * `scope` defaults to `project`. `global` lints the user-designated repository
 * (its paths are relative to that repository's top) and `all` lints both, with
 * the project's findings first. `checks` defaults to `config.lint.checks` (all
 * three unless the deployment trims the set) and an explicit list wins. The
 * global wiki's real page slugs fill `LintOptions.globalSlugs`, so
 * `[[global:slug]]` resolves from either wiki — including from a page of the
 * global wiki itself.
 *
 * Neither wiki is ever injected: the model reads a page because it asked for
 * it, and the only unasked text is the one-line notice (DESIGN §6.6).
 * @module @anago-harness/llm-wiki/tool
 */

import { readdir } from 'node:fs/promises'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { cwdOf, type WikiAgent } from './agents.ts'
import { describeError } from './errors.ts'
import { globalDisabledReason, type GlobalWikiState } from './global.ts'
import { inspectWiki } from './inspect.ts'
import { LINT_CHECKS, type LintCheck, type LintIssue, lintWiki, MAX_LINT_ISSUES } from './lint.ts'
import { pagesDirectory, slugFromFileName, WIKI_DIRECTORY, WIKI_PAGES_DIRECTORY } from './paths.ts'
import { describeTruncation, type WikiSearchIndex } from './search.ts'

/** Model-facing tool name. */
export const WIKI_LINT_TOOL_NAME = 'wiki_lint'

/** The wiki a call addressed (DESIGN §6.6). */
export type LintScope = 'project' | 'global' | 'all'

/** The canonical value `wiki_lint` returns (DESIGN §6.6). */
export interface WikiLintValue {
  /** At most {@link MAX_LINT_ISSUES} findings. */
  readonly issues: LintIssue[]
  /** One line: what was scanned, what was found, and whether the list was cut. */
  readonly summary: string
}

/** Everything the tool needs from the plugin. */
export interface WikiToolDeps {
  /** Where recoverable problems go. */
  readonly logger: {
    /** A recoverable problem; the tool result still returns. */
    warn(message: string, ...args: unknown[]): void
    /** Normal conditions worth a trace. */
    debug(message: string, ...args: unknown[]): void
  }
  /** The global wiki's state, shared with `wiki_write`, the guard, and `/wiki`. */
  readonly global: GlobalWikiState
  /**
   * The search index, read but never built here: the lint's only interest is
   * whether a built index is truncated (DESIGN §6.5). Omitted means the lint
   * has no index to talk about.
   */
  readonly search?: WikiSearchIndex
  /**
   * The checks an omitted `checks` argument runs (`config.lint.checks`).
   * Omitted means the design's default, all three ({@link LINT_CHECKS}).
   */
  readonly checks?: readonly LintCheck[]
}

/** The model-facing contract of one call. */
interface WikiLintArgs {
  /** Which wiki to check; omitted means `project`. */
  readonly scope?: LintScope
  /** Which checks to run; omitted means the configured default. */
  readonly checks?: readonly LintCheck[]
}

/**
 * The tool description: what the wiki is, what each check reports, and what it
 * deliberately does not report (DESIGN §6.6, sixth revision).
 */
export const WIKI_LINT_DESCRIPTION = [
  `Check an LLM wiki and report what is mechanically wrong. 'project' is the wiki at ${WIKI_DIRECTORY}/ in this checkout; 'global' is the repository the user designated for knowledge shared across projects; 'all' checks both, the project first. This tool only reads: fix the findings with write/edit for the project wiki, and with wiki_write for the global one.`,
  "`checks` defaults to the deployment's configured set (all three unless the Profile trimmed it); an explicit list overrides it. checks 'links' reports a [[slug]] that names no page, no index (the catalogue), and no raw/ source in its own wiki, and a [[global:slug]] the global wiki does not resolve. A target may use the page-directory path form ([[pages/alpha]] in the project wiki, [[concepts/esp32-s31|esp32-s31]] in a global wiki on concepts/), the catalogue as [[index]] or [[index#section|text]], and a raw/ source by base name ([[mcu-rf-update-2026-09-14]]) or repository-relative path with or without .md. Matching is case-sensitive, and [[...]] inside an inline code span or a fenced block is code, not a link. An unqualified link resolves inside the wiki that contains it, so two wikis may hold the same slug without complaint. 'index' reports the index.md ⟷ page-directory mismatch: a page missing from the catalogue, a catalogue entry whose page is gone, and a duplicate entry; an entry that names a raw/ source or the index is not stale. The project wiki's pages live under pages/; the global wiki's page directory is configurable (pages/ by default, and an existing repository may keep its pages under concepts/). 'raw' reports a raw/ source whose recorded sha256 does not match its body, which means the source was edited after it was recorded.",
  'Orphans, duplicate pages, staleness, and whether a page is true are not checked; read WIKI.md and the pages for that. Run this after every change to a wiki and fix what it reports before reporting the work done.',
].join('\n\n')

/**
 * Normalize the requested checks; omitted means the configured default.
 * @param checks - the tool call's `checks` list as the model sent it.
 * @param configured - the checks used when `checks` is omitted; every check by default.
 * @returns the requested checks in `LINT_CHECKS` order.
 * @throws when the list is empty or names a check that does not exist.
 */
export function normalizeChecks(
  checks: readonly string[] | undefined,
  configured: readonly LintCheck[] = LINT_CHECKS,
): LintCheck[] {
  if (checks === undefined) return [...configured]
  // An explicit list is never widened: an empty list is meaningless, and an
  // unknown name would silently re-enable a check the deployment turned off.
  if (checks.length === 0) {
    throw new Error(
      `wiki_lint: \`checks\` is empty; name at least one of ${LINT_CHECKS.join(', ')} or omit it for the configured default`,
    )
  }
  const wanted = new Set(checks)
  const unknown = [...wanted].filter(check => !(LINT_CHECKS as readonly string[]).includes(check))
  if (unknown.length > 0) {
    throw new Error(
      `wiki_lint: unknown check(s): ${unknown.join(', ')} — the checks are ${LINT_CHECKS.join(', ')}`,
    )
  }
  return LINT_CHECKS.filter(check => wanted.has(check))
}

/**
 * The page slugs of one wiki, for `[[global:slug]]` resolution.
 *
 * A failure to list the directory is reported and treated as "no pages", which
 * makes every qualified link unresolved — the honest answer when the pages
 * cannot be read.
 * @param wikiRoot - the wiki root.
 * @param logger - where the failure is reported.
 * @param pagesDir - the page directory name; `pages` by default.
 * @returns the slugs of `<pagesDir>/*.md`.
 */
export async function collectPageSlugs(
  wikiRoot: string,
  logger: WikiToolDeps['logger'],
  pagesDir: string = WIKI_PAGES_DIRECTORY,
): Promise<ReadonlySet<string>> {
  try {
    const names = await readdir(pagesDirectory(wikiRoot, pagesDir))
    const slugs = new Set<string>()
    for (const name of names) {
      if (name.startsWith('.')) continue
      const slug = slugFromFileName(name)
      if (slug !== null) slugs.add(slug)
    }
    return slugs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(
        'dsh-llm-wiki: the pages of %s could not be listed (%s)',
        wikiRoot,
        describeError(error),
      )
    }
    return new Set<string>()
  }
}

/** The global wiki's page slugs, or an empty set when there is no global wiki. */
async function globalPageSlugs(
  root: string | undefined,
  logger: WikiToolDeps['logger'],
  pagesDir: string,
): Promise<ReadonlySet<string>> {
  return root === undefined ? new Set<string>() : await collectPageSlugs(root, logger, pagesDir)
}

/**
 * Run one lint (DESIGN §6.6).
 *
 * It is separate from the tool body so `/wiki lint` runs **the same** check
 * with the same summary and the same notes, rather than a second
 * implementation that could drift (DESIGN §4.6's approach to `/memory`).
 * @param run - the session and the requested scope and checks.
 * @returns the canonical value the tool's output schema declares.
 */
export async function runWikiLint(run: {
  readonly cwd: string
  readonly scope: LintScope
  readonly checks: readonly LintCheck[]
  readonly logger: WikiToolDeps['logger']
  readonly global: GlobalWikiState
  /** The calling agent, for the global wiki's session checks. */
  readonly agent?: WikiAgent
  /** The search index cache; read for its truncation state, never built here. */
  readonly search?: WikiSearchIndex
  readonly signal?: AbortSignal
}): Promise<WikiLintValue> {
  const { cwd, scope, checks, logger } = run
  const sections: string[] = []
  const notes: string[] = []
  const issues: LintIssue[] = []
  const globalView = await run.global.forAgent(run.agent)
  const globalRoot = globalView.kind === 'found' ? globalView.repo.repoRoot : undefined
  const globalPagesDir = run.global.pagesDir
  const globalSlugs = await globalPageSlugs(globalRoot, logger, globalPagesDir)
  if (scope !== 'global') {
    const inspection = await inspectWiki({
      cwd,
      ...(run.signal === undefined ? {} : { signal: run.signal }),
    })
    if (inspection.kind !== 'found') {
      logger.debug('dsh-llm-wiki: %s', inspection.detail)
      if (scope === 'project') {
        return { issues: [], summary: `wiki_lint (${scope}): no project wiki here — ${inspection.detail}` }
      }
      notes.push(`no project wiki here (${inspection.detail})`)
    } else {
      for (const warning of inspection.warnings) logger.warn('dsh-llm-wiki: %s', warning)
      const result = await lintWiki(
        { scope: 'project', wikiRoot: inspection.root.wikiRoot, displayPrefix: `${WIKI_DIRECTORY}/` },
        {
          checks,
          globalSlugs,
          globalPagesDir,
          globalEnabled: globalRoot !== undefined,
        },
      )
      issues.push(...result.issues)
      sections.push(result.summary)
      const index = run.search?.state(inspection.root.wikiRoot)
      if (index?.truncated === true) sections.push(describeTruncation(index))
      if (!inspection.writable) {
        sections.push('this session is below the checkout root, so the project wiki is read-only here')
      }
      // The warnings are about the wiki as a whole (`.dsh/wiki.yml`, the ignore
      // state), so they belong in the summary a person reads, not only in the log.
      for (const warning of inspection.warnings) sections.push(warning)
    }
  }
  if (scope === 'global' || scope === 'all') {
    if (globalView.kind === 'found') {
      const root = globalView.repo.repoRoot
      const result = await lintWiki(
        {
          scope: 'global',
          wikiRoot: root,
          displayPrefix: '',
          pagesDir: globalPagesDir,
          summaryLabel: `global wiki (${root})`,
        },
        {
          checks,
          globalSlugs,
          globalPagesDir,
          globalEnabled: true,
        },
      )
      issues.push(...result.issues)
      sections.push(result.summary)
      const index = run.search?.state(root)
      if (index?.truncated === true) sections.push(describeTruncation(index))
    } else {
      const why = globalDisabledReason(globalView)
      if (scope === 'global') return { issues: [], summary: `wiki_lint (${scope}): ${why}` }
      notes.push(why)
    }
  }
  const cut = issues.slice(0, MAX_LINT_ISSUES)
  const parts = [sections.length === 0 ? `wiki_lint (${scope}): nothing to check` : sections.join('; ')]
  if (issues.length > cut.length) {
    parts.push(`${String(issues.length)} issue(s) in total, showing the first ${String(cut.length)}`)
  }
  const summary = notes.length === 0 ? parts.join(' — ') : `${parts.join(' — ')} (${notes.join('; ')})`
  return { issues: cut, summary }
}

/**
 * Run one accepted call (DESIGN §6.6).
 *
 * A session without a wiki gets an empty result and a summary that says so: a
 * lint that failed would tell the model the wiki is broken when it is simply
 * absent. A session without a working directory cannot resolve either wiki; the
 * project one needs it, and the global one is disabled for such a session
 * (§6.4 check 5).
 * @param args - validated arguments.
 * @param exec - execution identity, caller, and cancellation.
 * @param deps - logger and the global state.
 * @returns the canonical value declared by the tool's output schema.
 */
export async function executeWikiLint(
  args: WikiLintArgs,
  exec: ToolRunContext,
  deps: WikiToolDeps,
): Promise<WikiLintValue> {
  const agent = exec.agent
  const cwd = agent === undefined ? undefined : cwdOf(agent)
  const checks = normalizeChecks(args.checks, deps.checks)
  const scope: LintScope = args.scope ?? 'project'
  if (agent === undefined || cwd === undefined) {
    return {
      issues: [],
      summary: `wiki_lint (${scope}): the session recorded no working directory, so there is no wiki to check`,
    }
  }
  return await runWikiLint({
    cwd,
    scope,
    checks,
    logger: deps.logger,
    global: deps.global,
    ...(deps.search === undefined ? {} : { search: deps.search }),
    agent,
    signal: exec.signal,
  })
}

/**
 * Render one result for the model: the summary, then the findings.
 * @param value - the accepted result.
 * @returns the model-facing text.
 */
export function renderWikiLintResult(value: WikiLintValue): string {
  const lines = [value.summary]
  if (value.issues.length === 0) {
    lines.push('No issues found by the checks that ran.')
    return lines.join('\n')
  }
  for (const issue of value.issues) {
    lines.push(`- ${issue.scope} ${issue.kind} ${issue.path}: ${issue.detail}`)
  }
  return lines.join('\n')
}

/**
 * Build the registry-ready tool (DESIGN §6.6).
 * @param deps - logger and the global state.
 * @returns the definition `ctx.tools.register` accepts.
 */
export function createWikiLintTool(deps: WikiToolDeps): ToolDefinition {
  return defineTool({
    name: WIKI_LINT_TOOL_NAME,
    description: WIKI_LINT_DESCRIPTION,
    parameters: {
      scope: {
        type: 'string',
        enum: ['project', 'global', 'all'],
        description:
          "Which wiki to check; 'project' (the default) is this checkout's wiki, 'global' the user-designated one, 'all' both.",
      },
      checks: {
        type: 'array',
        description:
          "Which checks to run; omit for the deployment's configured set (`lint.checks`, all three by default). An explicit list wins.",
        items: {
          type: 'string',
          enum: ['links', 'index', 'raw'],
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          issues: {
            type: 'array',
            required: true,
            description: `What is wrong, at most ${String(MAX_LINT_ISSUES)} findings.`,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                scope: {
                  type: 'string',
                  enum: ['project', 'global'],
                  required: true,
                  description: 'The wiki the finding belongs to.',
                },
                kind: {
                  type: 'string',
                  enum: [
                    'unresolved-link',
                    'unresolved-global-link',
                    'index-missing',
                    'index-stale',
                    'index-duplicate',
                    'raw-digest-missing',
                    'raw-digest-mismatch',
                    'unreadable',
                  ],
                  required: true,
                  description: 'The kind of mismatch.',
                },
                path: {
                  type: 'string',
                  required: true,
                  description:
                    'The file to fix: relative to the checkout root for the project wiki, to the repository root for the global one.',
                },
                detail: {
                  type: 'string',
                  required: true,
                  description: 'What to do about it, in one line.',
                },
              },
            },
          },
          summary: {
            type: 'string',
            required: true,
            description: 'One line: what was scanned, how many issues, whether the list was cut.',
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: renderWikiLintResult(value as WikiLintValue) },
      ],
    },
    async execute(args, exec) {
      try {
        return await executeWikiLint(args as WikiLintArgs, exec, deps)
      } catch (error) {
        deps.logger.debug('dsh-llm-wiki: %s', describeError(error))
        throw error
      }
    },
  })
}
