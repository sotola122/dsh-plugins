/**
 * `knowledge-common` — the private module `@tep-hardware/dsh-memory` and
 * `@tep-hardware/dsh-llm-wiki` share (DESIGN §3.1, §11 order 1).
 *
 * It is a library, not a Cordis plugin: no `name`, no `apply`, no
 * `dsh.bundle.patch`, no `schemastery`, and no runtime `@deepseek-ai/*` import.
 * Consumers bundle it with `noExternal`, and pass the two seams it must not own:
 *
 * - **atomic write** — `withFileLock` and `writeFileAtomic` from
 *   `@deepseek-ai/dsh-atomic-write` (a peer of both plugins per §3.1), given to
 *   {@link updateFileLocked} and {@link ensureGitignoreBlock};
 * - **git** — a {@link GitRunner}; the default one uses `node:child_process`,
 *   because `@deepseek-ai/dsh-subprocess` is a Cordis service a plain library
 *   cannot reach.
 *
 * Reading order for a consumer:
 *
 * 1. {@link scanText} — the §9 verdict for text from a model or from a file.
 * 2. {@link parseDocument} / {@link serializeDocument} — the `§` entry format.
 * 3. {@link updateFileLocked} — `mkdir` → lock → read → write, all or nothing.
 * 4. {@link resolveContainedTarget} — the `write`/`edit` containment check.
 * 5. {@link resolveGitRoots} / {@link checkIgnored} / {@link listTrackedFiles} —
 *    the workspace store's preconditions.
 * 6. {@link expectedGitignoreLines} / {@link ensureGitignoreBlock} — the
 *    managed `.gitignore` block.
 * 7. {@link createApprovalGate} / {@link resolveEffectivePolicy} — the shared
 *    pre-execute approval gate and the session policy it reads.
 * 8. {@link appendClaimedMessage} — insert an injected message after the last
 *    message a step claimed.
 *
 * @module knowledge-common
 */

export * from './approval.ts'
export * from './atomic.ts'
export * from './entries.ts'
export * from './errors.ts'
export * from './git.ts'
export * from './gitignore.ts'
export * from './hash.ts'
export * from './inject.ts'
export * from './paths.ts'
export * from './process.ts'
export * from './scan.ts'
export * from './text.ts'
