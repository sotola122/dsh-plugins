/**
 * `wiki_write` — the only writer of the global wiki (DESIGN §6.4, U5, D2).
 *
 * The project wiki is written with the ordinary `write`/`edit` tools while the
 * session sits at or above its checkout root. The **global** wiki is not: it
 * lives in a repository of its own, so the model needs a tool whose contract is
 * the wiki's convention rather than a file path. That contract is what this
 * module enforces, in this order:
 *
 * 1. the global wiki must be enabled for this session (a repository is
 *    designated, the checks passed, and it does not overlap `header.cwd`);
 * 2. the path must be one of the four allowed shapes — `<pagesDir>/<slug>.md`,
 *    `raw/<topic>/<name>.md`, `index.md`, `WIKI.md` — and must land inside the
 *    repository after `realpath`, outside `.git/`, and not on a symlink. The page
 *    directory is `pages/` by default and `config.global.pagesDir` otherwise.
 *    `WIKI.md` is allowed because the skeleton creates it; a repository whose
 *    charter is its own `AGENTS.md` is told (by the description and the skill)
 *    not to add one, and `AGENTS.md` itself is never a writable path;
 * 3. `raw/` may only be created; an existing source is `WIKI_RAW_IMMUTABLE`
 *    even for an `edit`, and a new one gets its `sha256` recorded by the tool
 *    (never typed by the model);
 * 4. the §9 scan runs on the result: a refusal writes nothing, and a secret is
 *    stored as `[REDACTED:<kind>]` and reported in `redacted`;
 * 5. one file is capped by `write.maxPageBytes` (pages, `index.md`, `WIKI.md`)
 *    or `write.maxRawBytes` (`raw/`) — there is no page-count or total-bytes
 *    cap (sixth revision);
 * 6. the write is `mkdir` → `<file>.lock` → atomic replace.
 *
 * The approval branch is not here: `tools/pre-execute` decides it (see
 * `./approval`), because the ask must happen before the body runs and a denied
 * ask must leave no file behind.
 * @module @anago-harness/llm-wiki/write
 */

import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  type AtomicWriteApi,
  isPathWithin,
  resolveContainedTarget,
  scanText,
  sha256Hex,
  updateFileLocked,
} from '@anago-harness/knowledge-common'
import { delegationDepthOf, type WikiAgent } from './agents.ts'
import type { WikiConfig } from './config.ts'
import { describeError, wikiError } from './errors.ts'
import { globalDisabledReason, type GlobalWikiState } from './global.ts'
import {
  isPageSlug,
  splitFrontmatter,
  WIKI_CHARTER_FILE,
  WIKI_FILE_EXTENSION,
  WIKI_INDEX_FILE,
  WIKI_PAGES_DIRECTORY,
  WIKI_RAW_DIRECTORY,
} from './paths.ts'

/** Model-facing tool name. */
export const WIKI_WRITE_TOOL_NAME = 'wiki_write'

/** The writer-lock budget of `wiki_write`, in milliseconds (DESIGN §4.4's default). */
export const WIKI_LOCK_WAIT_MS = 5_000

/** Which convention a write follows (DESIGN §6.4). */
export type WikiWriteKind =
  /** `<pagesDir>/<slug>.md` — a page, capped by `write.maxPageBytes`. */
  | 'page'
  /** `raw/<topic>/<name>.md` — an immutable source, capped by `write.maxRawBytes`. */
  | 'raw'
  /** `index.md` — the catalogue. */
  | 'index'
  /** `WIKI.md` — the charter a person maintains. */
  | 'charter'

/** A path the shape rules accepted. */
export interface WikiWriteTarget {
  /** Which convention applies. */
  readonly kind: WikiWriteKind
  /** The path exactly as the caller wrote it, with `/` separators. */
  readonly relative: string
}

/** The canonical value `wiki_write` returns (DESIGN §6.4). */
export interface WikiWriteValue {
  /** The path that was written, relative to the repository top. */
  readonly path: string
  /** The UTF-8 byte length of what was written. */
  readonly bytes: number
  /** True when the file did not exist before this call. */
  readonly created: boolean
  /** Secret kinds replaced by `[REDACTED:<kind>]`. */
  readonly redacted: string[]
}

/** Everything the tool needs from the plugin. */
export interface WikiWriteDeps {
  /** Resolved plugin configuration (`write` carries the two caps). */
  readonly config: WikiConfig
  /** Where recoverable problems go. */
  readonly logger: {
    /** A recoverable problem; the tool result still returns. */
    warn(message: string, ...args: unknown[]): void
    /** Normal conditions worth a trace. */
    debug(message: string, ...args: unknown[]): void
  }
  /** The global wiki's state, shared with the guard, the lint, and `/wiki`. */
  readonly global: GlobalWikiState
  /** `withFileLock` and `writeFileAtomic` from `@deepseek-ai/dsh-atomic-write`. */
  readonly api: AtomicWriteApi
}

/** The model-facing contract of one call (DESIGN §6.4). */
interface WikiWriteArgs {
  /** Repository-relative path: `<pagesDir>/<slug>.md`, `raw/<topic>/<name>.md`, `index.md`, or `WIKI.md`. */
  readonly path: string
  /** The complete next content. Give this or `edit`, never both. */
  readonly content?: string
  /** Replace `old_text` (which must appear exactly once) with `new_text`. */
  readonly edit?: { readonly old_text: string; readonly new_text: string }
}

/**
 * Check one path against the four allowed shapes (DESIGN §6.4).
 *
 * The rules are lexical on purpose: they run before any filesystem access, so a
 * path that cannot be a wiki file is refused without touching the repository,
 * and the containment check afterwards only has to answer "where does this
 * land". `pagesDir` is the global wiki's page directory (`config.global.pagesDir`,
 * `pages` by default); the project wiki always passes the default. It is one
 * single-level name by construction, so comparing the first component cannot
 * be widened into a path that leaves the repository.
 * @param relative - the caller's path.
 * @param pagesDir - the page directory name; `pages` by default.
 * @returns the accepted target, or the reason it is not a wiki path.
 */
export function classifyWritePath(
  relative: string,
  pagesDir: string = WIKI_PAGES_DIRECTORY,
): WikiWriteTarget | { readonly error: string } {
  if (relative.trim() === '') return { error: 'the path is empty' }
  if (relative.includes('\0')) return { error: 'the path contains a NUL byte' }
  if (path.isAbsolute(relative) || /^[A-Za-z]:[\\/]/u.test(relative)) {
    return { error: 'the path must be relative to the repository root' }
  }
  if (relative.includes('\\')) {
    return { error: 'use `/` as the separator; `\\` is not accepted' }
  }
  const components = relative.split('/')
  if (components.some(component => component === '' || component === '.' || component === '..')) {
    return { error: 'the path must not contain empty, `.`, or `..` components' }
  }
  if (components.includes('.git')) {
    return { error: '`.git/` is not part of the wiki' }
  }
  if (components.length === 1) {
    if (components[0] === WIKI_INDEX_FILE) return { kind: 'index', relative }
    if (components[0] === WIKI_CHARTER_FILE) return { kind: 'charter', relative }
    return {
      error: `at the repository root only \`${WIKI_CHARTER_FILE}\` and \`${WIKI_INDEX_FILE}\` may be written`,
    }
  }
  if (components[0] === pagesDir) {
    if (components.length !== 2) {
      return { error: `a page is \`${pagesDir}/<slug>.md\`; sub-directories are not part of the convention` }
    }
    const name = components[1] as string
    if (!name.endsWith(WIKI_FILE_EXTENSION)) {
      return { error: `a page file ends with \`${WIKI_FILE_EXTENSION}\`` }
    }
    const slug = name.slice(0, -WIKI_FILE_EXTENSION.length)
    if (!isPageSlug(slug)) {
      return {
        error: `\`${slug}\` is not a usable page slug (lower-case and hyphenated, with no separators)`,
      }
    }
    return { kind: 'page', relative }
  }
  if (components[0] === WIKI_RAW_DIRECTORY) {
    if (components.length !== 3) {
      return {
        error: `a source is \`${WIKI_RAW_DIRECTORY}/<topic>/<YYYY-MM-DD>-<source>.md\`; the topic directory is required`,
      }
    }
    const topic = components[1] as string
    const name = components[2] as string
    if (topic.startsWith('.')) return { error: `\`${topic}\` is not a usable topic directory name` }
    if (!name.endsWith(WIKI_FILE_EXTENSION)) {
      return { error: `a source file ends with \`${WIKI_FILE_EXTENSION}\`` }
    }
    const stem = name.slice(0, -WIKI_FILE_EXTENSION.length)
    if (stem === '' || stem.startsWith('.')) {
      return { error: `\`${name}\` is not a usable source file name` }
    }
    return { kind: 'raw', relative }
  }
  return {
    error: `only \`${pagesDir}/\`, \`${WIKI_RAW_DIRECTORY}/\`, \`${WIKI_CHARTER_FILE}\`, and \`${WIKI_INDEX_FILE}\` may be written`,
  }
}

/**
 * The byte cap one kind is subject to (DESIGN §6.4, sixth revision).
 * @param kind - the kind of file the write would produce.
 * @param config - the resolved configuration carrying both caps.
 * @returns `write.maxRawBytes` for `raw`, `write.maxPageBytes` for every other kind.
 */
export function capFor(kind: WikiWriteKind, config: WikiConfig): number {
  return kind === 'raw' ? config.write.maxRawBytes : config.write.maxPageBytes
}

/**
 * Record the digest of a source's body in its frontmatter (DESIGN §6.4).
 *
 * The digest covers the text **after** the frontmatter, so recording it can
 * never change it — the same split `wiki_lint`'s `raw` check uses. An existing
 * `sha256:` line is replaced; otherwise the line is appended inside the block.
 * @param content - the source as it will be written, with frontmatter.
 * @returns the content with the computed digest recorded.
 * @throws WIKI_WRITE_INVALID when there is no frontmatter block to record it in.
 */
export function recordSourceDigest(content: string): string {
  const document = splitFrontmatter(content)
  if (document.frontmatter === null) {
    throw wikiError(
      'WIKI_WRITE_INVALID',
      `a ${WIKI_RAW_DIRECTORY}/ source must start with a frontmatter block so the tool can record its sha256; begin the file with \`---\`, \`source_url:\`, and \`retrieved_at:\``,
    )
  }
  const lines = document.frontmatter.split('\n')
  const line = `sha256: ${sha256Hex(document.body)}`
  const index = lines.findIndex(entry => /^[ \t]*sha256[ \t]*:/u.test(entry))
  if (index === -1) lines.push(line)
  else lines[index] = line
  return `---\n${lines.join('\n')}\n---\n${document.body}`
}

/** Replace one exact occurrence without interpreting `$` patterns. */
function replaceOnce(content: string, oldText: string, newText: string, at: number): string {
  return `${content.slice(0, at)}${newText}${content.slice(at + oldText.length)}`
}

/** How many times `needle` occurs in `haystack` (non-overlapping). */
function countOccurrences(haystack: string, needle: string): { count: number; first: number } {
  if (needle === '') return { count: 0, first: -1 }
  let count = 0
  let first = -1
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    if (first === -1) first = index
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return { count, first }
}

/** The result of building the next content for one call. */
export interface RenderedWrite {
  /** What to write. */
  readonly content: string
  /** Secret kinds the §9 scan replaced. */
  readonly redacted: readonly string[]
}

/**
 * Whether a tool argument was supplied. `wiki_write` arguments arrive as JSON,
 * where an omitted field and an explicit `null` both mean "not given".
 * @param value - the raw argument.
 * @returns true when the value is neither `undefined` nor `null`.
 */
function isSupplied(value: unknown): boolean {
  return value !== undefined && value !== null
}

/**
 * Build the content one call would write (DESIGN §6.4).
 *
 * It is exported separately from the tool body so a unit test can drive the
 * `content`/`edit`/`raw` rules without a repository. Nothing here touches the
 * filesystem; the caller has already read `current` under the lock.
 * @param args - the caller's arguments.
 * @param current - the file's content, or `null` when it does not exist.
 * @param kind - which convention applies.
 * @param config - the caps.
 * @returns the content to write and the secrets that were replaced.
 * @throws WIKI_WRITE_CONFLICT, WIKI_WRITE_INVALID, WIKI_RAW_IMMUTABLE, WIKI_REJECTED, or WIKI_LIMIT_EXCEEDED.
 */
export function renderWrite(
  args: WikiWriteArgs,
  current: string | null,
  kind: WikiWriteKind,
  config: WikiConfig,
): RenderedWrite {
  const hasContent = typeof args.content === 'string'
  const hasEdit = isSupplied(args.edit)
  if (hasContent === hasEdit) {
    throw wikiError(
      'WIKI_WRITE_CONFLICT',
      hasContent
        ? 'give either `content` or `edit`, not both'
        : 'give `content` to write a file or `edit` to change one',
    )
  }
  if (kind === 'raw' && current !== null) {
    throw wikiError(
      'WIKI_RAW_IMMUTABLE',
      `${WIKI_RAW_DIRECTORY}/ sources are immutable and this one already exists. Keep it as it is and record a new dated source`,
    )
  }
  let candidate: string
  if (hasContent) {
    candidate = args.content
  } else {
    const edit = args.edit as { readonly old_text: string; readonly new_text: string }
    if (typeof edit.old_text !== 'string' || typeof edit.new_text !== 'string') {
      throw wikiError('WIKI_WRITE_INVALID', '`edit.old_text` and `edit.new_text` must both be strings')
    }
    if (current === null) {
      throw wikiError('WIKI_WRITE_INVALID', '`edit` needs an existing file; pass `content` to create one')
    }
    const { count, first } = countOccurrences(current, edit.old_text)
    if (count === 0) {
      throw wikiError(
        'WIKI_WRITE_INVALID',
        '`edit.old_text` does not appear in the file; read it again and quote the text exactly',
      )
    }
    if (count > 1) {
      throw wikiError(
        'WIKI_WRITE_INVALID',
        `\`edit.old_text\` appears ${String(count)} times, so the replacement would be ambiguous; quote a longer passage that occurs once`,
      )
    }
    candidate = replaceOnce(current, edit.old_text, edit.new_text, first)
  }
  const scan = scanText(candidate)
  if (!scan.ok) {
    const findings = scan.findings.map(finding => `${finding.rule} (${finding.detail})`).join(', ')
    throw wikiError(
      'WIKI_REJECTED',
      `the content was refused by the injection scan: ${findings}. The wiki is reference data: remove the pattern and write the fact instead`,
    )
  }
  const content = kind === 'raw' ? recordSourceDigest(scan.text) : scan.text
  const cap = capFor(kind, config)
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > cap) {
    throw wikiError(
      'WIKI_LIMIT_EXCEEDED',
      `${String(bytes)} bytes exceeds the ${String(cap)}-byte cap for ${kind === 'raw' ? 'one source' : 'one page'}; split the subject or trim the text (nothing was written)`,
    )
  }
  return { content, redacted: scan.redacted }
}

/** Where one accepted path lands (DESIGN §6.4, §5.2). */
export interface ResolvedWriteTarget {
  /** The absolute file to write. */
  readonly file: string
  /** The canonical parent directory. */
  readonly parent: string
  /** Whether the file exists already (`lstat`, so a symlink counts as existing). */
  readonly exists: boolean
}

/**
 * Resolve an accepted path against the repository, closing `..`, symlinked
 * parents, `.git/`, and a symlink leaf (DESIGN §6.4, §5.2).
 *
 * The **parent** is what containment is judged on, and it is canonicalized the
 * §5.2 way: judging the leaf would realpath a symlink away and allow a write
 * that replaces the file the link points at instead of the link. A leaf that
 * already exists as a symlink or as a non-file is refused outright.
 * @param repoRoot - the canonical repository top.
 * @param target - the shape-checked path.
 * @returns the resolved file.
 * @throws WIKI_WRITE_INVALID when the path escapes the repository or is not a plain file path.
 */
export async function resolveWriteTarget(
  repoRoot: string,
  target: WikiWriteTarget,
): Promise<ResolvedWriteTarget> {
  const absolute = path.resolve(repoRoot, target.relative)
  const canonicalParent = await resolveContainedTarget(repoRoot, path.dirname(absolute))
  if (canonicalParent === null) {
    throw wikiError(
      'WIKI_WRITE_INVALID',
      `\`${target.relative}\` resolves outside the wiki repository (${repoRoot})`,
    )
  }
  const file = path.join(canonicalParent, path.basename(absolute))
  if (isPathWithin(path.join(repoRoot, '.git'), file)) {
    throw wikiError('WIKI_WRITE_INVALID', '`.git/` is not part of the wiki')
  }
  let info: Awaited<ReturnType<typeof lstat>> | undefined
  try {
    info = await lstat(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw wikiError('WIKI_IO', `\`${target.relative}\` could not be inspected (${describeError(error)})`)
    }
  }
  if (info !== undefined) {
    if (info.isSymbolicLink()) {
      throw wikiError(
        'WIKI_WRITE_INVALID',
        `\`${target.relative}\` is a symbolic link; the wiki is written with plain files only`,
      )
    }
    if (!info.isFile()) {
      throw wikiError('WIKI_WRITE_INVALID', `\`${target.relative}\` exists and is not a file`)
    }
  }
  return { file, parent: canonicalParent, exists: info !== undefined }
}

/**
 * Run one accepted `wiki_write` call (DESIGN §6.4).
 *
 * The writes are separated from the tool body so a test can drive the same
 * path. A child agent (`delegationDepth > 0`) is refused here as well as at
 * `tools/pre-execute`: the policy is the design's answer, and this is the
 * guarantee behind it.
 * @param args - the caller's arguments.
 * @param agent - the calling agent, for the session checks.
 * @param deps - configuration, the global state, and the atomic-write seam.
 * @param signal - cancellation.
 * @returns the canonical value.
 */
export async function executeWikiWrite(
  args: WikiWriteArgs,
  agent: WikiAgent | undefined,
  deps: WikiWriteDeps,
  signal?: AbortSignal,
): Promise<WikiWriteValue> {
  if (agent !== undefined && delegationDepthOf(agent) > 0) {
    throw wikiError(
      'WIKI_READ_ONLY',
      'a subagent may not write the global wiki; report the change to the parent instead',
    )
  }
  const view = await deps.global.forAgent(agent)
  if (view.kind !== 'found') {
    throw new Error(globalDisabledReason(view))
  }
  const target = classifyWritePath(args.path, deps.config.global.pagesDir)
  if ('error' in target) {
    throw wikiError('WIKI_WRITE_INVALID', `${JSON.stringify(args.path)}: ${target.error}`)
  }
  const resolved = await resolveWriteTarget(view.repo.repoRoot, target)
  const value = await updateFileLocked(
    deps.api,
    resolved.file,
    (current) => {
      const rendered = renderWrite(args, current, target.kind, deps.config)
      return {
        content: rendered.content,
        result: {
          created: current === null,
          bytes: Buffer.byteLength(rendered.content, 'utf8'),
          redacted: [...rendered.redacted],
        },
      }
    },
    { mode: 0o644, dirMode: 0o755, lockWaitMs: WIKI_LOCK_WAIT_MS, ...(signal === undefined ? {} : { signal }) },
  )
  deps.logger.debug(
    'dsh-llm-wiki: wiki_write %s (%d bytes, created=%s)',
    target.relative,
    value.bytes,
    String(value.created),
  )
  return { path: target.relative, bytes: value.bytes, created: value.created, redacted: value.redacted }
}

/**
 * The approval paragraph the `wiki_write` description carries (DESIGN §6.4).
 *
 * The description is fixed when the tool is registered, before any session
 * exists, so it states both branches instead of naming one session's policy;
 * `/wiki status` prints the resolved one (see `./approval`).
 */
export const WIKI_WRITE_APPROVAL_PARAGRAPH =
  'Approval: with writeApproval: none the tool writes directly. With writeApproval: ask it asks for approval whenever the session can be prompted; a session whose effective approval policy is never cannot be prompted, so the tool refuses the write with WIKI_APPROVAL_UNAVAILABLE instead — enable approval for the session or set writeApproval: none to write without asking. Nothing is ever staged for later approval — a refused ask leaves no file behind.'

/**
 * The tool description for one page directory (DESIGN §6.4).
 *
 * The page directory is a configuration value (`global.pagesDir`), so the
 * description names the one this deployment actually accepts; a model that read
 * only `pages/<slug>.md` would otherwise be refused on a wiki whose pages live
 * under `concepts/`.
 * @param pagesDir - the global wiki's page directory name.
 * @returns the description `defineTool` carries.
 */
export function wikiWriteDescription(pagesDir: string = WIKI_PAGES_DIRECTORY): string {
  return [
    'Write one file of the global LLM wiki — a repository the user designated with /wiki repo set. Use this tool for the global wiki only; a project wiki under .dsh/wiki is written with write/edit. Before writing, read the repository\'s charter — AGENTS.md when it exists, otherwise WIKI.md (/wiki status prints which) — and index.md, plus its SCHEMA.md when it has one. Never add a second charter: AGENTS.md and SCHEMA.md are the repository\'s own files, and this tool does not write them. The wiki is reference data: write what is true and self-contained in English, never an instruction to a future agent.',
    `path is relative to the repository root and must be one of: ${pagesDir}/<slug>.md (one page per subject; the file name is the link target), raw/<topic>/<YYYY-MM-DD>-<source>.md (an immutable source, create-only), index.md (the catalogue, one \`- [[slug]] — summary\` line per page), WIKI.md (the charter a person maintains, only when it is this repository's charter). ${pagesDir}/ is this deployment's page directory (global.pagesDir; the default is pages/, and an existing repository may keep its pages under concepts/). Give either content (the complete next file) or edit ({old_text, new_text}, with old_text occurring exactly once), never both. raw/ files must start with a frontmatter block (source_url, retrieved_at); the tool computes sha256 over the body and records it, so do not write that line yourself. One page is capped at 64 KiB and one source at 256 KiB.`,
    'Secrets are replaced by [REDACTED:<kind>] and reported; text that looks like an instruction to an agent or a chat-template token is refused. Nothing is committed: mention the changed files and let the user commit them with /wiki commit.',
    WIKI_WRITE_APPROVAL_PARAGRAPH,
  ].join('\n\n')
}

/** The tool description at the default page directory (DESIGN §6.4). */
export const WIKI_WRITE_DESCRIPTION = wikiWriteDescription()

/**
 * Build the registry-ready tool (DESIGN §6.4).
 * @param deps - configuration, the global state, and the atomic-write seam.
 * @returns the definition `ctx.tools.register` accepts.
 */
export function createWikiWriteTool(deps: WikiWriteDeps): ToolDefinition {
  const pagesDir = deps.config.global.pagesDir
  return defineTool({
    name: WIKI_WRITE_TOOL_NAME,
    description: wikiWriteDescription(pagesDir),
    parameters: {
      path: {
        type: 'string',
        description: `Path relative to the global wiki repository root: ${pagesDir}/<slug>.md, raw/<topic>/<YYYY-MM-DD>-<source>.md, index.md, or WIKI.md (only when it is this repository's charter).`,
      },
      content: {
        type: 'string',
        description: 'The complete next content of the file. Give this or edit, not both.',
      },
      edit: {
        type: 'object',
        additionalProperties: false,
        description: 'Replace one unique passage of an existing file. Give this or content, not both.',
        properties: {
          old_text: {
            type: 'string',
            required: true,
            description: 'The exact text to replace; it must occur exactly once in the file.',
          },
          new_text: {
            type: 'string',
            required: true,
            description: 'What to put in its place.',
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            required: true,
            description: 'The path that was written, relative to the repository root.',
          },
          bytes: {
            type: 'number',
            required: true,
            description: 'The UTF-8 byte length of the file after the write.',
          },
          created: {
            type: 'boolean',
            required: true,
            description: 'True when the file did not exist before this call.',
          },
          redacted: {
            type: 'array',
            required: true,
            description: 'Secret kinds replaced by [REDACTED:<kind>], if any.',
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => {
        const written = value as WikiWriteValue
        const secrets =
          written.redacted.length === 0 ? '' : ` Secrets were redacted: ${written.redacted.join(', ')}.`
        return [
          {
            type: 'text',
            text: `${written.created ? 'Created' : 'Updated'} ${written.path} (${String(written.bytes)} bytes).${secrets}`,
          },
        ]
      },
    },
    async execute(args, exec) {
      try {
        return await executeWikiWrite(
          args as WikiWriteArgs,
          exec.agent,
          deps,
          exec.signal,
        )
      } catch (error) {
        deps.logger.debug('dsh-llm-wiki: %s', describeError(error))
        throw error
      }
    },
  })
}
