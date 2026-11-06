/**
 * Staged writes: `$DSH_HOME/memories/pending/` (DESIGN §4.5, sixth revision).
 *
 * When the session's effective approval policy is `never`, `writeApproval:
 * ask` cannot ask anyone, so every operation of a `memory` call is recorded as
 * a `PendingOp` instead of being written. The records live **outside the
 * working tree**, under the harness home, which is what keeps them out of a
 * `workspace-write` sandbox (`bash` cannot write there, S18):
 *
 * ```text
 * $DSH_HOME/memories/pending/
 * ├── memory/<id>.json                     target 'memory'
 * ├── user/<id>.json                       target 'user'
 * └── workspaces/<sha256(root)>/<id>.json  target 'workspace'
 * ```
 *
 * The store directories are the pending scope: the two global ones always, and
 * for a workspace one only the key of the repository the session is in, so an
 * id from another repository is not addressable here. There is deliberately
 * **no `issued.json`** (removed in the sixth revision): an id is accepted when
 * its form is right, its file is directly inside an addressable pending
 * directory, its JSON `id` equals the file name, and its shape is exactly
 * {@link PendingOp}. The body's authenticity is not verified — anyone who can
 * write the directory can plant a well-formed file (§9).
 *
 * Approval re-checks everything inside the store's writer lock and runs the
 * **same** §9 scan, delimiter, duplicate, and limit functions the direct write
 * path uses: `patch`/`remove` require the whole `baseEntry` recorded at staging
 * time to still be present, and `add` must still be duplicate-free and within
 * the limit. A refusal there means the store moved on, so the pending file is
 * removed and `MEMORY_PENDING_STALE` is reported (hermes parity). Approvals are
 * per operation: the batch atomicity of a direct write is **not** kept, because
 * each staged operation is applied by its own locked read-modify-write.
 * @module @anago-harness/memory/pending
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  type AtomicWriteApi,
  type MemoryDocument,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  type SecretKind,
  sha256Hex,
} from '@anago-harness/knowledge-common'
import { applyOperations, assertWithinLimit, type MemoryOperation } from './entries.ts'
import { describeError, isMemoryError, memoryError } from './errors.ts'
import type { MemoryLogger } from './inject.ts'
import { type MemoryTarget, type StoreLocation, updateStoreChecked } from './store.ts'

/** Directory under `$DSH_HOME/memories` that holds the staged operations. */
export const PENDING_DIRECTORY_NAME = 'pending'

/** Sub-directory of the workspace pendings, keyed by the root's digest. */
export const PENDING_WORKSPACES_DIRECTORY = 'workspaces'

/** The id shape of DESIGN §4.5: `YYYYMMDDThhmmss` plus eight hex digits. */
export const PENDING_ID_PATTERN = /^\d{8}T\d{6}-[0-9a-f]{8}$/u

/** `approve all` refuses more operations than this (DESIGN §4.5). */
export const ALL_MAX_OPERATIONS = 20

/** `approve all` refuses more text than this, in bytes (DESIGN §4.5). */
export const ALL_MAX_BYTES = 65_536

/** The stores a pending operation can address. */
export type PendingSource = 'tool' | 'review'

/** One staged operation (DESIGN §4.5). */
export interface PendingOp {
  /** `YYYYMMDDThhmmss-<8 hex>` (UTC), equal to the file name without `.json`. */
  readonly id: string
  /** ISO-8601 instant the operation was staged. */
  readonly createdAt: string
  /** The session that staged it; sessions are not unique across machines. */
  readonly sessionId: string
  /** `tool` for a `memory` call; `review` for the turn-end review (DESIGN §4.7). */
  readonly source: PendingSource
  /** Which store the operation addresses. */
  readonly target: MemoryTarget
  /** The entry-level operation. */
  readonly op: 'add' | 'patch' | 'remove'
  /** `add` and `patch`: the text to store. */
  readonly text?: string
  /** `patch` and `remove`: the selector, re-resolved at approval time. */
  readonly old_text?: string
  /** `patch` and `remove`: the whole entry the selector matched when staged. */
  readonly baseEntry?: string
}

/**
 * A parsed record before validation: every `PendingOp` field with an
 * unverified type, so a validator that checked each one can return the
 * operation it proved.
 */
type PendingOpCandidate = { readonly [K in keyof PendingOp]?: unknown }

/**
 * The key that separates one repository's workspace pendings (DESIGN §4.5).
 * @param root - the canonical workspace root (DESIGN §5.1).
 * @returns 64 lower-case hex characters.
 */
export function workspacePendingKey(root: string): string {
  return sha256Hex(root)
}

/**
 * `$DSH_HOME/memories/pending`.
 * @returns the absolute root holding every store's pending directory.
 */
export function pendingRoot(): string {
  return dshHomePath('memories', PENDING_DIRECTORY_NAME)
}

/**
 * The pending directory of a global store.
 * @param target - `memory` or `user`.
 * @param root - the pending root; overridable for a test.
 * @returns the absolute directory.
 */
export function globalPendingDirectory(target: 'memory' | 'user', root = pendingRoot()): string {
  return path.join(root, target)
}

/**
 * The pending directory of one repository's workspace store.
 * @param key - {@link workspacePendingKey}.
 * @param root - the pending root; overridable for a test.
 * @returns the absolute directory.
 */
export function workspacePendingDirectory(key: string, root = pendingRoot()): string {
  return path.join(root, PENDING_WORKSPACES_DIRECTORY, key)
}

/** One pending directory this session can address. */
export interface PendingDirectory {
  /** Which store its files belong to. */
  readonly target: MemoryTarget
  /** The absolute directory. */
  readonly directory: string
  /** The workspace key, for the `workspace` target only. */
  readonly key?: string
}

/**
 * The pending directories of one session: the two global stores, and the
 * workspace store of the repository the session is in (when there is one).
 * A workspace pending of another repository is deliberately not addressable
 * from here — approving it would have to write into a checkout this session
 * cannot see.
 * @param options - the session's workspace key, when it has a workspace.
 * @param root - the pending root; overridable for a test.
 * @returns the directories, in store order.
 */
export function pendingDirectories(
  options: { readonly workspaceKey?: string },
  root = pendingRoot(),
): PendingDirectory[] {
  const directories: PendingDirectory[] = [
    { target: 'memory', directory: globalPendingDirectory('memory', root) },
    { target: 'user', directory: globalPendingDirectory('user', root) },
  ]
  if (options.workspaceKey !== undefined && options.workspaceKey !== '') {
    directories.push({
      target: 'workspace',
      directory: workspacePendingDirectory(options.workspaceKey, root),
      key: options.workspaceKey,
    })
  }
  return directories
}

/** One accepted pending record. */
export interface PendingRecord {
  /** The validated operation. */
  readonly op: PendingOp
  /** Its absolute path. */
  readonly file: string
  /** The directory it was found in. */
  readonly directory: PendingDirectory
}

/** One file that claims to be a pending operation but is not usable. */
export interface PendingProblem {
  /** Its absolute path. */
  readonly file: string
  /** Why it was refused, without a code prefix. */
  readonly detail: string
}

/**
 * Build the id for one staged operation (DESIGN §4.5).
 * @param now - the staging instant; only its UTC second is encoded, so two
 * operations in one second are told apart by `hex` alone.
 * @param hex - the eight-hex-digit suffix; one batch counts up from a single
 * seed, so sorting the ids as strings keeps the batch's order.
 * @returns `YYYYMMDDThhmmss-<hex>`, which is also the file name without `.json`.
 */
export function pendingId(now: Date, hex: string): string {
  const iso = now.toISOString()
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`
  return `${stamp}-${hex}`
}

/**
 * Build the refusal for a file that may not be acted on (DESIGN §4.5).
 * @param source - the file path.
 * @param detail - what is wrong with it.
 * @returns the error to throw.
 */
function pendingUnknown(source: string, detail: string): ReturnType<typeof memoryError> {
  return memoryError('MEMORY_PENDING_UNKNOWN', `${source} is not a usable pending operation: ${detail}`)
}

/**
 * Validate one parsed object as a `PendingOp` (DESIGN §4.5).
 *
 * The shape is closed: an unknown key, a missing one, a `baseEntry` on an
 * `add` (or a missing one on `patch`/`remove`), or a `text`/`old_text` that
 * does not match the operation all refuse. Every refusal is
 * `MEMORY_PENDING_UNKNOWN`, because the caller may not act on the file.
 * @param raw - the parsed JSON.
 * @param expectedId - the id the file name carries.
 * @param source - the file path, for the message.
 * @returns the operation.
 * @throws MemoryError `MEMORY_PENDING_UNKNOWN` when the shape is wrong.
 */
export function parsePendingOp(raw: unknown, expectedId: string, source: string): PendingOp {
  const refuse: (detail: string) => never = (detail) => {
    throw pendingUnknown(source, detail)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) refuse('the JSON is not an object')
  const record = raw as PendingOpCandidate
  const allowed = new Set(['id', 'createdAt', 'sessionId', 'source', 'target', 'op', 'text', 'old_text', 'baseEntry'])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) refuse(`it carries the unknown key ${JSON.stringify(key)}`)
  }
  if (record.id !== expectedId) {
    refuse(`its id ${JSON.stringify(String(record.id))} does not equal the file name (${expectedId})`)
  }
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) {
    refuse('`createdAt` must be an ISO-8601 instant')
  }
  if (typeof record.sessionId !== 'string') refuse('`sessionId` must be a string')
  if (record.source !== 'tool' && record.source !== 'review') {
    refuse('`source` must be tool or review')
  }
  if (record.target !== 'memory' && record.target !== 'user' && record.target !== 'workspace') {
    refuse('`target` must be memory, user, or workspace')
  }
  if (record.op !== 'add' && record.op !== 'patch' && record.op !== 'remove') {
    refuse('`op` must be add, patch, or remove')
  }
  const text = record.text
  const oldText = record.old_text
  if (text !== undefined && typeof text !== 'string') refuse('`text` must be a string')
  if (oldText !== undefined && typeof oldText !== 'string') refuse('`old_text` must be a string')
  if (record.baseEntry !== undefined && typeof record.baseEntry !== 'string') {
    refuse('`baseEntry` must be a string')
  }
  if (record.op === 'add' && (typeof text !== 'string' || text.trim() === '')) {
    refuse('an add requires a non-empty `text`')
  }
  if (record.op === 'patch') {
    if (typeof text !== 'string' || text.trim() === '') refuse('a patch requires a non-empty `text`')
    if (typeof oldText !== 'string' || oldText === '') refuse('a patch requires `old_text`')
    if (typeof record.baseEntry !== 'string') refuse('a patch requires `baseEntry`')
  }
  if (record.op === 'remove') {
    if (typeof oldText !== 'string' || oldText === '') refuse('a remove requires `old_text`')
    if (typeof record.baseEntry !== 'string') refuse('a remove requires `baseEntry`')
  }
  if (record.op === 'add' && record.baseEntry !== undefined) {
    refuse('an add carries no `baseEntry`')
  }
  return record as PendingOp
}

/**
 * Read and validate one candidate file (DESIGN §4.5).
 *
 * The file must be a regular file directly inside `directory`, resolved
 * through `realpath` on both sides, so a symlink planted under the pending root
 * cannot make the plugin read or delete something else.
 * @param file - the candidate path.
 * @param directory - the addressable pending directory it must be inside.
 * @returns the validated record.
 * @throws MemoryError `MEMORY_PENDING_UNKNOWN` for any mismatch.
 */
export async function readPendingFile(
  file: string,
  directory: PendingDirectory,
): Promise<PendingRecord> {
  const refuse: (detail: string) => never = (detail) => {
    throw pendingUnknown(file, detail)
  }
  const name = path.basename(file)
  if (!name.endsWith('.json')) refuse('the file name does not end in .json')
  const expectedId = name.slice(0, -'.json'.length)
  if (!PENDING_ID_PATTERN.test(expectedId)) {
    refuse('the file name is not <YYYYMMDDThhmmss>-<8 hex>.json')
  }
  let info
  try {
    info = await stat(file)
  } catch (error) {
    refuse(`it could not be read (${describeError(error)})`)
  }
  if (!info.isFile()) refuse('it is not a regular file')
  try {
    const [canonicalDirectory, canonicalFile] = await Promise.all([
      realpath(directory.directory),
      realpath(file),
    ])
    if (path.dirname(canonicalFile) !== canonicalDirectory) {
      refuse(`it does not resolve directly inside ${directory.directory}`)
    }
  } catch (error) {
    refuse(`its real path could not be resolved (${describeError(error)})`)
  }
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    refuse(`it could not be read (${describeError(error)})`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    refuse(`it is not valid JSON (${describeError(error)})`)
  }
  const op = parsePendingOp(raw, expectedId, file)
  // The directory *is* the store (DESIGN §4.5): a record that claims another
  // target than the directory it sits in would write somewhere the id does not
  // address, so it is not a usable pending operation at all.
  if (op.target !== directory.target) {
    refuse(`it declares target ${JSON.stringify(op.target)} but lives in the ${directory.target} directory`)
  }
  return { op, file, directory }
}

/**
 * List the pending files of the addressable directories (DESIGN §4.5).
 *
 * A missing directory is empty, not an error. Files whose name is not an id,
 * and files that fail {@link readPendingFile}, are reported as problems and
 * left alone: `approve all` skips them, and a person can delete them by hand.
 * @param directories - the addressable pending directories.
 * @returns the records sorted by id, and the files that are not usable.
 */
export async function listPending(directories: readonly PendingDirectory[]): Promise<{
  readonly records: PendingRecord[]
  readonly problems: PendingProblem[]
}> {
  const records: PendingRecord[] = []
  const problems: PendingProblem[] = []
  for (const directory of directories) {
    let names: string[]
    try {
      names = await readdir(directory.directory)
    } catch {
      continue
    }
    for (const name of names.sort((left, right) => left.localeCompare(right, 'en'))) {
      const file = path.join(directory.directory, name)
      try {
        records.push(await readPendingFile(file, directory))
      } catch (error) {
        problems.push({ file, detail: describeError(error) })
      }
    }
  }
  records.sort((left, right) => left.op.id.localeCompare(right.op.id, 'en'))
  return { records, problems }
}

/**
 * Count the pending files of one directory (DESIGN §4.5: the bound is the
 * whole store's file count, not one session's).
 * @param directory - the pending directory.
 * @returns the number of entries; a missing directory counts as zero.
 */
export async function countPending(directory: string): Promise<number> {
  try {
    return (await readdir(directory)).length
  } catch {
    return 0
  }
}

/**
 * Count the pending files of the workspace pendings this session cannot
 * address, so `/memory pending` can say they exist.
 * @param root - the pending root.
 * @param ownKey - the session's workspace key, when it has one.
 * @returns the number of files in the other workspace directories.
 */
export async function countOtherWorkspacePending(
  root: string,
  ownKey: string | undefined,
): Promise<number> {
  const base = path.join(root, PENDING_WORKSPACES_DIRECTORY)
  let names: string[]
  try {
    names = await readdir(base)
  } catch {
    return 0
  }
  let total = 0
  for (const name of names) {
    if (name === ownKey) continue
    total += await countPending(path.join(base, name))
  }
  return total
}

/** Everything {@link stageOperations} needs. */
export interface StageInput {
  /** Which store the batch addresses. */
  readonly target: MemoryTarget
  /** The store's pending directory (see {@link pendingDirectories}). */
  readonly directory: string
  /** The staging session's id. */
  readonly sessionId: string
  /** `tool` for a `memory` call; `review` for the turn-end review. */
  readonly source: PendingSource
  /** One to eight validated operations, as the tool received them. */
  readonly operations: readonly MemoryOperation[]
  /** The store as it was read before staging; its entries are the batch's base. */
  readonly document: MemoryDocument
  /** The store's code-point limit (DESIGN §4.3). */
  readonly limit: number
  /** `pending.maxPerStore` (DESIGN §4.4). */
  readonly maxPerStore: number
  /** The instant to stamp; defaults to now. */
  readonly now?: Date
}

/** What one staged batch produced. */
export interface StageOutcome {
  /** The pending ids, in operation order. */
  readonly ids: string[]
  /** The secret kinds the §9 scan replaced, in first-seen order. */
  readonly redacted: SecretKind[]
  /** The texts the staged batch would add, replace, or remove. */
  readonly applied: string[]
  /** `baseEntry` per operation; `undefined` for an `add`. */
  readonly bases: (string | undefined)[]
}

/**
 * Validate a batch and record it as pending operations (DESIGN §4.5).
 *
 * Validation is the **direct write's** validation: `applyOperations` runs the
 * §9 scan, the delimiter rule, the duplicate rule, and the `old_text`
 * uniqueness rule against the store as it is now, so a batch that could not be
 * written is refused here with the same code rather than staged. What the
 * simulation adds is `baseEntry`: the whole entry each `patch`/`remove`
 * selected, which approval re-checks.
 *
 * Nothing here takes the store's writer lock: staging writes only the pending
 * files, and the approval is where the lock is held (see the module comment).
 * @param input - target, pending directory, operations, and the store's current document.
 * @returns the ids and what the batch would do.
 * @throws MemoryError `MEMORY_PENDING_FULL` at the bound, any refusal
 * `applyOperations` raises, or `MEMORY_IO` when a file could not be written.
 */
export async function stageOperations(input: StageInput): Promise<StageOutcome> {
  const bases: (string | undefined)[] = []
  const applied = applyOperations(input.document.entries, input.operations, (position, match) => {
    bases[position] = match.baseEntry
  })
  // The limit is part of the same all-or-nothing check the direct write makes:
  // an over-limit batch is refused here rather than staged into an operation
  // that approval could only refuse (DESIGN §4.3, §4.5).
  assertWithinLimit({ header: input.document.header, entries: applied.entries }, input.limit)
  const existing = await countPending(input.directory)
  if (existing + input.operations.length > input.maxPerStore) {
    throw memoryError(
      'MEMORY_PENDING_FULL',
      `${input.directory} already holds ${String(existing)} staged operation(s) and pending.maxPerStore is ${String(input.maxPerStore)}; approve or reject them with /memory approve or /memory reject first`,
    )
  }
  const now = input.now ?? new Date()
  const createdAt = now.toISOString()
  const ops: PendingOp[] = input.operations.map((operation, position) => ({
    id: '',
    createdAt,
    sessionId: input.sessionId,
    source: input.source,
    target: input.target,
    op: operation.op,
    ...(operation.text === undefined ? {} : { text: operation.text }),
    ...(operation.old_text === undefined ? {} : { old_text: operation.old_text }),
    ...(bases[position] === undefined ? {} : { baseEntry: bases[position] }),
  }))
  try {
    await mkdir(input.directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  } catch (error) {
    throw memoryError(
      'MEMORY_IO',
      `${input.directory} could not be created (${describeError(error)}); nothing was staged`,
    )
  }
  const written: string[] = []
  const ids: string[] = []
  // The eight hex digits are drawn once and then counted up, so the operations
  // of one batch keep their order when they are listed and approved: a batch may
  // depend on itself (an add followed by a patch of the entry it created), and
  // ids sorted as strings are the only order approval has.
  let counter = randomBytes(4).readUInt32BE(0)
  const nextHex = (): string => {
    const hex = counter.toString(16).padStart(8, '0')
    counter = (counter + 1) % 0x1_0000_0000
    return hex
  }
  try {
    for (const op of ops) {
      const file = await writePendingFile(input.directory, op, now, nextHex)
      written.push(file)
      ids.push(path.basename(file, '.json'))
    }
  } catch (error) {
    // Best effort: a rollback failure must not hide the original refusal.
    await Promise.all(
      written.map(async (file) => {
        try {
          await rm(file, { force: true })
        } catch {
          // The file stays; the error below still says what happened.
        }
      }),
    )
    if (isMemoryError(error)) throw error
    throw memoryError(
      'MEMORY_IO',
      `${input.directory} could not be written (${describeError(error)}); nothing was staged`,
    )
  }
  return { ids, redacted: applied.redacted, applied: applied.applied, bases }
}

/**
 * Write one pending file with a fresh id, retrying the (astronomically
 * unlikely) name collision rather than overwriting someone else's record.
 * @param directory - the store's pending directory.
 * @param op - the record, without its id yet.
 * @param now - the instant the batch is stamped with.
 * @param nextSuffix - the next eight-hex-digit suffix of this batch.
 * @returns the file that was written.
 */
async function writePendingFile(
  directory: string,
  op: PendingOp,
  now: Date,
  nextSuffix: () => string,
): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const id = pendingId(now, nextSuffix())
    const file = path.join(directory, `${id}.json`)
    const record: PendingOp = { ...op, id }
    try {
      await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, {
        mode: PRIVATE_FILE_MODE,
        flag: 'wx',
      })
      return file
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
  }
  throw memoryError('MEMORY_IO', `${directory} kept naming collisions; nothing was staged`)
}

/** How one store is reached when a pending operation is approved. */
export interface ApprovalTargets {
  /**
   * Resolve the store one target addresses, ready to be written (the workspace
   * path runs the §5.1 preconditions and may add the managed `.gitignore`
   * block, which is the first write this store sees).
   */
  readonly locationFor: (target: MemoryTarget) => Promise<StoreLocation>
  /** `withFileLock` and `writeFileAtomic` from `@deepseek-ai/dsh-atomic-write`. */
  readonly api: AtomicWriteApi
  /** Writer-lock budget. */
  readonly lockWaitMs: number
  /** Cancellation. */
  readonly signal?: AbortSignal
  /** Where a dropped or kept record is explained. */
  readonly logger: MemoryLogger
}

/** What happened to one requested pending operation. */
export type PendingOutcome = PendingApplied | PendingFailed

/** A staged operation the caller applied (`approve`) or deleted (`reject`). */
export interface PendingApplied {
  /** The pending id. */
  readonly id: string
  /** The store it addressed. */
  readonly target: MemoryTarget
  /** Whether it was applied (`approve`) or deleted (`reject`). */
  readonly ok: true
}

/** A staged operation that could not be applied or deleted. */
export interface PendingFailed {
  /** The pending id. */
  readonly id: string
  /** The store it addressed. */
  readonly target: MemoryTarget
  /** Whether it was applied (`approve`) or deleted (`reject`). */
  readonly ok: false
  /** The refusal code, starting with `MEMORY_`. */
  readonly code: string
  /** The refusal message. */
  readonly message: string
  /**
   * Whether the pending file was removed anyway: a content-level refusal
   * (`MEMORY_PENDING_STALE` and the rules approval re-checks) drops the record,
   * while an infrastructure failure keeps it for a retry.
   */
  readonly dropped?: boolean
}

/**
 * The store changed under a staged operation, so approval removes the record
 * rather than keeping an operation that can never be applied. Lock timeouts and
 * I/O failures are **not** in this set: they are transient, and dropping the
 * user's text for them would be silent data loss.
 */
const DROPPING_CODES: ReadonlySet<string> = new Set([
  'MEMORY_PENDING_STALE',
  'MEMORY_DUPLICATE',
  'MEMORY_NOT_FOUND',
  'MEMORY_NOT_FOUND_AMBIGUOUS',
  'MEMORY_LIMIT_EXCEEDED',
  'MEMORY_REJECTED',
])

/** Re-check one staged operation against the store as it is now (DESIGN §4.5). */
function guardFor(op: PendingOp): (document: MemoryDocument) => void {
  if (op.op === 'add') return () => {}
  const base = op.baseEntry ?? ''
  return (document) => {
    if (document.entries.includes(base)) return
    throw memoryError(
      'MEMORY_PENDING_STALE',
      `the entry staged for this ${op.op} is no longer in the store, so it was dropped instead of applied (nothing was written)`,
    )
  }
}

/**
 * Project one pending operation onto the operation list `applyOperations` takes.
 * @param op - the staged operation, which also carries the staging id, source,
 * target, and `baseEntry`.
 * @returns the operation kind with only the `text` and `old_text` fields that are set;
 * the staging-only fields are dropped.
 */
export function toMemoryOperation(op: PendingOp): MemoryOperation {
  return {
    op: op.op,
    ...(op.text === undefined ? {} : { text: op.text }),
    ...(op.old_text === undefined ? {} : { old_text: op.old_text }),
  }
}

/**
 * Apply the staged operations the caller selected, one locked read-modify-write
 * each (DESIGN §4.5).
 *
 * The re-check runs **inside** the lock, so a store edited between the read and
 * the write cannot smuggle a stale operation through. A content-level refusal
 * removes the pending file; an infrastructure failure keeps it.
 * @param records - the selected operations, in the order to apply.
 * @param targets - how to reach each store, and the atomic-write seam.
 * @returns one outcome per record, in the same order.
 */
export async function approvePending(
  records: readonly PendingRecord[],
  targets: ApprovalTargets,
): Promise<PendingOutcome[]> {
  const outcomes: PendingOutcome[] = []
  for (const record of records) {
    const { op, file } = record
    try {
      const location = await targets.locationFor(op.target)
      await updateStoreChecked(
        location,
        [toMemoryOperation(op)],
        {
          api: targets.api,
          lockWaitMs: targets.lockWaitMs,
          ...(targets.signal === undefined ? {} : { signal: targets.signal }),
        },
        guardFor(op),
      )
      await rm(file, { force: true })
      outcomes.push({ id: op.id, target: op.target, ok: true })
    } catch (error) {
      const code = isMemoryError(error) ? error.code : 'MEMORY_IO'
      const message = describeError(error)
      const dropped = DROPPING_CODES.has(code)
      if (dropped) {
        await rm(file, { force: true })
        targets.logger.warn('dsh-memory: dropped the staged operation %s (%s)', op.id, message)
      } else {
        targets.logger.warn('dsh-memory: kept the staged operation %s (%s)', op.id, message)
      }
      outcomes.push({
        id: op.id,
        target: op.target,
        ok: false,
        code: dropped && code !== 'MEMORY_PENDING_STALE' ? 'MEMORY_PENDING_STALE' : code,
        message: dropped && code !== 'MEMORY_PENDING_STALE' ? `${code}: ${message}` : message,
        dropped,
      })
    }
  }
  return outcomes
}

/**
 * Delete the staged operations the caller selected (DESIGN §4.5).
 * @param records - the selected operations.
 * @returns one outcome per record; `ok` means the file is gone.
 */
export async function rejectPending(records: readonly PendingRecord[]): Promise<PendingOutcome[]> {
  const outcomes: PendingOutcome[] = []
  for (const record of records) {
    try {
      await unlink(record.file)
      outcomes.push({ id: record.op.id, target: record.op.target, ok: true })
    } catch (error) {
      outcomes.push({
        id: record.op.id,
        target: record.op.target,
        ok: false,
        code: 'MEMORY_IO',
        message: `${record.file} could not be removed (${describeError(error)})`,
      })
    }
  }
  return outcomes
}

/** The pending files one `/memory approve`/`reject` invocation selected. */
export interface PendingSelection {
  /** The records to act on, sorted by id. */
  readonly records: PendingRecord[]
  /** Ids the caller named that are not addressable pending operations. */
  readonly unknown: string[]
  /** Files that claim to be pending operations but are not usable. */
  readonly problems: PendingProblem[]
}

/**
 * Resolve the ids of one `/memory approve`/`reject` invocation (DESIGN §4.5).
 *
 * `all` selects every usable record; an explicit list selects only ids present
 * in the addressable set, and every other id is reported rather than guessed
 * at. The id's form is checked before the lookup, so `../../../etc/passwd` is
 * refused as an id rather than as a path.
 * @param ids - the ids the user typed, or `all`.
 * @param directories - the addressable pending directories.
 * @returns the selection.
 */
export async function selectPending(
  ids: readonly string[] | 'all',
  directories: readonly PendingDirectory[],
): Promise<PendingSelection> {
  const { records, problems } = await listPending(directories)
  if (ids === 'all') return { records, unknown: [], problems }
  const byId = new Map(records.map(record => [record.op.id, record]))
  const selected: PendingRecord[] = []
  const unknown: string[] = []
  for (const id of ids) {
    if (!PENDING_ID_PATTERN.test(id)) {
      unknown.push(id)
      continue
    }
    const record = byId.get(id)
    if (record === undefined) {
      unknown.push(id)
      continue
    }
    if (!selected.includes(record)) selected.push(record)
  }
  selected.sort((left, right) => left.op.id.localeCompare(right.op.id, 'en'))
  return { records: selected, unknown, problems }
}

/**
 * Enforce `approve all`'s bounds (DESIGN §4.5): more than 20 operations, or
 * more than 64 KiB of `text` and `old_text` together, applies **none** of them.
 * @param records - the selected records.
 * @throws MemoryError `MEMORY_PENDING_ALL_LIMIT`.
 */
export function assertAllWithinLimits(records: readonly PendingRecord[]): void {
  if (records.length > ALL_MAX_OPERATIONS) {
    throw memoryError(
      'MEMORY_PENDING_ALL_LIMIT',
      `approve all would apply ${String(records.length)} operations, and the limit is ${String(ALL_MAX_OPERATIONS)}; nothing was applied. Name the ids explicitly to approve more`,
    )
  }
  const bytes = records.reduce((total, record) => total + pendingBytes(record.op), 0)
  if (bytes > ALL_MAX_BYTES) {
    throw memoryError(
      'MEMORY_PENDING_ALL_LIMIT',
      `approve all would apply ${String(bytes)} bytes of text, and the limit is ${String(ALL_MAX_BYTES)}; nothing was applied. Name the ids explicitly to approve more`,
    )
  }
}

/**
 * The bytes `approve all`'s bound counts for one operation.
 * @param op - the pending operation.
 * @returns the UTF-8 length of `text` plus `old_text`.
 */
export function pendingBytes(op: PendingOp): number {
  return Buffer.byteLength(op.text ?? '', 'utf8') + Buffer.byteLength(op.old_text ?? '', 'utf8')
}
