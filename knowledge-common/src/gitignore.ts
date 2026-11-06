/**
 * The managed `.gitignore` block of the workspace memory store (DESIGN §5.1,
 * N1, the block text of §3.2).
 *
 * The block is delimited by `# >>> dsh-memory` and `# <<< dsh-memory`. Editing
 * it is idempotent and surgically honest:
 *
 * - the whole plan is a pure function of the current bytes, so every branch is
 *   unit-testable without a filesystem;
 * - **only the bytes between the two marker lines change** — the markers, their
 *   line terminators, and everything outside the block are copied from the
 *   input, which is what keeps CRLF files and hand-formatted headers intact;
 * - no markers appends the block (finishing with a newline and a blank
 *   separator line when the file has content), one ordered pair replaces only
 *   the inner lines, and an identical result writes nothing;
 * - a one-sided, duplicated, or reversed marker pair is refused without
 *   touching the file ({@link GitignoreEditError} `GITIGNORE_MALFORMED`).
 *
 * The write itself re-reads the file's size and mtime immediately before the
 * replacement and re-checks the file afterwards, so an editor that saved in
 * between wins and the caller sees `GITIGNORE_CONFLICT` instead of losing the
 * edit (DESIGN §5.1, §9).
 * @module knowledge-common/gitignore
 */

import type { Stats } from 'node:fs'
import { lstat, stat } from 'node:fs/promises'
import path from 'node:path'
import { updateFileLocked, type AtomicWriteApi, SHARED_FILE_MODE } from './atomic.ts'
import { FileLockTimeoutError, GitignoreEditError } from './errors.ts'

/** File name the block lives in. */
export const GITIGNORE_FILE_NAME = '.gitignore'

/** Start marker, without the human-readable suffix. */
export const GITIGNORE_START_MARKER = '# >>> dsh-memory'

/** End marker. */
export const GITIGNORE_END_MARKER = '# <<< dsh-memory'

/** The start marker line as DESIGN §3.2 writes it. */
export const GITIGNORE_START_LINE = `${GITIGNORE_START_MARKER} (managed by @tep-hardware/dsh-memory)`

/** Permission bits for a `.gitignore` this plugin creates (DESIGN §5.1). */
export const GITIGNORE_FILE_MODE = SHARED_FILE_MODE

/** Permission bits for the directory holding it, created only if absent. */
export const GITIGNORE_DIRECTORY_MODE = 0o755

/** The inputs that decide which conditional lines the block carries (DESIGN §5.1). */
export interface GitignoreBlockInputs {
  /** `<checkoutRoot>/.dsh/wiki.yml` has `commit: true`, so the wiki is tracked. */
  readonly wikiCommitted?: boolean
  /** `git ls-files -- .dsh/skills` is not empty. */
  readonly skillsTracked?: boolean
}

/**
 * The lines the block must hold, in order (DESIGN §3.2, §5.1).
 * @param inputs - whether the wiki is committed and whether skills are tracked.
 * @returns the block's inner lines, without markers.
 */
export function expectedGitignoreLines(inputs: GitignoreBlockInputs = {}): readonly string[] {
  const lines = ['.dsh/*', '!.dsh/wiki.yml']
  if (inputs.wikiCommitted === true) lines.push('!.dsh/wiki/')
  if (inputs.skillsTracked === true) lines.push('!.dsh/skills/')
  return lines
}

/**
 * Render the complete block, markers included.
 * @param lines - the inner lines.
 * @param eol - line terminator to use.
 * @returns the block, terminated by `eol`.
 */
export function renderGitignoreBlock(lines: readonly string[], eol = '\n'): string {
  return [GITIGNORE_START_LINE, ...lines, GITIGNORE_END_MARKER].join(eol) + eol
}

/** One line of the file, with the offsets it occupies in the original content. */
interface GitignoreLine {
  /** The line without its terminator. */
  readonly text: string
  /** Offset of the line's first character. */
  readonly start: number
  /** Offset just past the line's terminator (or the line's end at EOF). */
  readonly end: number
}

/** Split content into lines, remembering where each one sits. */
function splitLinesWithOffsets(content: string): GitignoreLine[] {
  const lines: GitignoreLine[] = []
  let start = 0
  for (let index = 0; index < content.length; index += 1) {
    if (content.charAt(index) !== '\n') continue
    const raw = content.slice(start, index)
    lines.push({
      text: raw.endsWith('\r') ? raw.slice(0, -1) : raw,
      start,
      end: index + 1,
    })
    start = index + 1
  }
  if (start < content.length) {
    lines.push({ text: content.slice(start), start, end: content.length })
  }
  return lines
}

/** Whether a line is one of our markers, ignoring trailing whitespace and a suffix. */
function markerOf(line: string): 'start' | 'end' | null {
  const trimmed = line.replace(/[ \t]+$/u, '')
  for (const [marker, kind] of [
    [GITIGNORE_START_MARKER, 'start'],
    [GITIGNORE_END_MARKER, 'end'],
  ] as const) {
    if (trimmed === marker) return kind
    if (trimmed.startsWith(marker)) {
      const next = trimmed.charAt(marker.length)
      if (next === ' ' || next === '\t' || next === '(') return kind
    }
  }
  return null
}

/** Where the managed block sits in the content. */
export interface GitignoreBlockRegion {
  /** Index of the start marker line. */
  readonly startLine: number
  /** Index of the end marker line. */
  readonly endLine: number
  /** Offset just past the start marker line: where the inner lines begin. */
  readonly innerStart: number
  /** Offset where the end marker line begins: where the inner lines end. */
  readonly innerEnd: number
}

/** What the content currently holds. */
export type GitignoreLayout =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly region: GitignoreBlockRegion }
  | { readonly kind: 'malformed'; readonly detail: string }

/**
 * Find the managed block without changing anything.
 * @param content - the current file content.
 * @returns the block's region, its absence, or why the markers are unusable.
 */
export function inspectGitignoreBlock(content: string): GitignoreLayout {
  const lines = splitLinesWithOffsets(content)
  const starts: GitignoreLine[] = []
  const ends: GitignoreLine[] = []
  for (const line of lines) {
    const marker = markerOf(line.text)
    if (marker === 'start') starts.push(line)
    else if (marker === 'end') ends.push(line)
  }
  if (starts.length === 0 && ends.length === 0) return { kind: 'absent' }
  const startLine = starts[0]
  const endLine = ends[0]
  if (starts.length !== 1 || ends.length !== 1 || startLine === undefined || endLine === undefined) {
    return {
      kind: 'malformed',
      detail: `${GITIGNORE_START_MARKER} appears ${String(starts.length)} time(s) and ${GITIGNORE_END_MARKER} ${String(ends.length)} time(s); nothing was changed`,
    }
  }
  const startIndex = lines.indexOf(startLine)
  const endIndex = lines.indexOf(endLine)
  if (startIndex > endIndex) {
    return {
      kind: 'malformed',
      detail: `${GITIGNORE_END_MARKER} precedes ${GITIGNORE_START_MARKER}; nothing was changed`,
    }
  }
  return {
    kind: 'present',
    region: {
      startLine: startIndex,
      endLine: endIndex,
      innerStart: startLine.end,
      innerEnd: endLine.start,
    },
  }
}

/**
 * The line terminator to write with: CRLF once the file uses it.
 * @param content - the current file content.
 * @returns `\r\n` when the content contains a CRLF sequence, otherwise `\n`.
 */
export function detectGitignoreEol(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n'
}

/** What a planned update would do. */
export interface GitignorePlan {
  /** The complete content after the update. */
  readonly content: string
  /** Whether that content differs from the input, i.e. whether a write is needed. */
  readonly changed: boolean
  /** Whether the block was absent and is added by this plan. */
  readonly added: boolean
}

/**
 * Compute the next content for the managed block, purely (DESIGN §5.1).
 *
 * The result is identical to the input when the block already holds exactly
 * these lines, so callers can skip the write. The bytes outside the block are
 * never rewritten.
 * @param content - the current file content (`''` when the file does not exist).
 * @param lines - the inner lines the block must hold.
 * @returns the plan.
 * @throws GitignoreEditError `GITIGNORE_MALFORMED` when the markers are unusable.
 * @throws TypeError when `lines` is empty, which would silently empty the block.
 */
export function planGitignoreUpdate(content: string, lines: readonly string[]): GitignorePlan {
  if (lines.length === 0) {
    throw new TypeError('knowledge-common: the managed .gitignore block needs at least one line')
  }
  const layout = inspectGitignoreBlock(content)
  if (layout.kind === 'malformed') {
    throw new GitignoreEditError('GITIGNORE_MALFORMED', layout.detail)
  }
  const eol = detectGitignoreEol(content)
  if (layout.kind === 'present') {
    const next =
      content.slice(0, layout.region.innerStart) +
      lines.join(eol) +
      eol +
      content.slice(layout.region.innerEnd)
    return { content: next, changed: next !== content, added: false }
  }
  let next = content
  if (next !== '' && !next.endsWith(eol)) next += eol
  if (next !== '' && !next.endsWith(eol + eol)) next += eol
  next += renderGitignoreBlock(lines, eol)
  return { content: next, changed: next !== content, added: true }
}

/** What one {@link ensureGitignoreBlock} call did. */
export interface GitignoreUpdateResult {
  /** The `.gitignore` path that was inspected. */
  readonly path: string
  /** Whether the file was written. */
  readonly changed: boolean
  /** Whether the file did not exist before this call. */
  readonly created: boolean
  /** Whether the managed block was absent before this call. */
  readonly added: boolean
  /** The file's content after the call (the planned content when unchanged). */
  readonly content: string
}

/** Options for {@link ensureGitignoreBlock}. */
export interface EnsureGitignoreOptions {
  /** The git root that holds `.gitignore`; it must exist. */
  readonly root: string
  /** The inner lines the block must hold, from {@link expectedGitignoreLines}. */
  readonly lines: readonly string[]
  /** Lock budget; defaults to {@link DEFAULT_LOCK_WAIT_MS}. */
  readonly lockWaitMs?: number
  /** Cancellation. */
  readonly signal?: AbortSignal
}

/** `stat` that reports absence instead of throwing. */
async function statOrNull(target: string): Promise<Stats | null> {
  try {
    return await stat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** `lstat` that reports absence instead of throwing. */
async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Whether two stats describe the same size and modification time. */
function sameStat(before: Stats | null, after: Stats | null): boolean {
  if (before === null || after === null) return before === after
  return before.size === after.size && before.mtimeMs === after.mtimeMs
}

/** A conflict with the outside bytes we read. */
function conflict(target: string, detail: string): GitignoreEditError {
  return new GitignoreEditError(
    'GITIGNORE_CONFLICT',
    `${target} changed while the managed block was being edited (${detail}); nothing was written`,
  )
}

/** Map filesystem failures a user can fix onto the documented refusal. */
function mapGitignoreError(error: unknown, target: string): unknown {
  if (error instanceof GitignoreEditError || error instanceof FileLockTimeoutError) return error
  const code = (error as NodeJS.ErrnoException).code
  if (
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'EROFS' ||
    code === 'EISDIR' ||
    code === 'ENOTDIR'
  ) {
    return new GitignoreEditError('GITIGNORE_UNWRITABLE', `${target} cannot be written (${code})`)
  }
  return error
}

/**
 * Bring `<root>/.gitignore` up to date: create the block, replace only its
 * inner lines, or leave the file untouched (DESIGN §5.1).
 *
 * Runs under the writer lock with the `mkdir` → lock → read → write shape of
 * {@link updateFileLocked}. A symbolic link is refused rather than replaced,
 * because the atomic replacement would swap the link itself (S17).
 * @param api - `withFileLock` and `writeFileAtomic` from `@deepseek-ai/dsh-atomic-write`.
 * @param options - root, expected lines, lock budget, cancellation.
 * @returns what happened, including the content now on disk.
 * @throws GitignoreEditError when the markers are unusable, the bytes changed
 * underneath the edit, or the file cannot be written.
 * @throws FileLockTimeoutError when the lock is not acquired in time.
 */
export async function ensureGitignoreBlock(
  api: AtomicWriteApi,
  options: EnsureGitignoreOptions,
): Promise<GitignoreUpdateResult> {
  const target = path.join(options.root, GITIGNORE_FILE_NAME)
  try {
    const result = await updateFileLocked(
      api,
      target,
      async (current): Promise<{ content: string | null; result: GitignoreUpdateResult }> => {
        const link = await lstatOrNull(target)
        if (link !== null && link.isSymbolicLink()) {
          throw new GitignoreEditError(
            'GITIGNORE_UNWRITABLE',
            `${target} is a symbolic link; the atomic replacement would swap the link itself`,
          )
        }
        const before = await statOrNull(target)
        if (before !== null && current !== null && before.size !== Buffer.byteLength(current, 'utf8')) {
          throw conflict(target, 'the file changed while it was being read')
        }
        const plan = planGitignoreUpdate(current ?? '', options.lines)
        if (!plan.changed) {
          return {
            content: null,
            result: {
              path: target,
              changed: false,
              created: current === null,
              added: false,
              // A present block plans its own content unchanged; an absent file
              // always plans the block, so `changed: false` implies a string here.
              content: plan.content,
            },
          }
        }
        const after = await statOrNull(target)
        if (!sameStat(before, after)) {
          throw conflict(target, 'size or mtime changed before the replacement')
        }
        return {
          content: plan.content,
          result: {
            path: target,
            changed: true,
            created: current === null,
            added: plan.added,
            content: plan.content,
          },
        }
      },
      {
        mode: GITIGNORE_FILE_MODE,
        dirMode: GITIGNORE_DIRECTORY_MODE,
        ...(options.lockWaitMs === undefined ? {} : { lockWaitMs: options.lockWaitMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    )
    if (result.changed) {
      const written = await statOrNull(target)
      if (written === null || written.size !== Buffer.byteLength(result.content, 'utf8')) {
        throw new GitignoreEditError(
          'GITIGNORE_WRITE_MISMATCH',
          `${target} does not hold the ${String(Buffer.byteLength(result.content, 'utf8'))}-byte block that was written`,
        )
      }
    }
    return result
  } catch (error) {
    throw mapGitignoreError(error, target)
  }
}
