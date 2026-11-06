/**
 * Path containment by `realpath` (DESIGN §5.2).
 *
 * The predicate is used by the *mutating* tools only (`write`, `edit`) to decide
 * whether a path lands inside a protected tree; `read` is not stopped. It is a
 * pure computation plus one `realpath` of the deepest existing ancestor, so a
 * path whose tail does not exist yet — the normal case for a page about to be
 * written — resolves to the canonical location it would occupy.
 *
 * `..` and symlinks are closed by construction: the lexical resolution removes
 * `..` before the split, and every existing component is passed through
 * `realpath`, so a symlinked parent cannot smuggle a write outside the root.
 * The remaining race (a path component replaced by a symlink between this check
 * and the rename) is the acknowledged limit of DESIGN §5.2 and §6.4.
 * @module knowledge-common/paths
 */

import { realpath } from 'node:fs/promises'
import path from 'node:path'

/**
 * Whether `child` is `parent` itself or sits below it. Pure: it compares the
 * two resolved paths and never touches the filesystem.
 * @param parent - the containing root.
 * @param child - the candidate path.
 * @returns true when the child is the root or below it.
 */
export function isPathWithin(parent: string, child: string): boolean {
  const root = path.resolve(parent)
  const target = path.resolve(child)
  const normalizeCase = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value
  const normalizedRoot = normalizeCase(root)
  const normalizedTarget = normalizeCase(target)
  if (normalizedRoot === normalizedTarget) return true
  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`
  return normalizedTarget.startsWith(prefix)
}

/**
 * Canonicalize a path whose tail may not exist: `realpath` the deepest existing
 * ancestor and re-attach the missing components (the approach of
 * `@deepseek-ai/dsh-home-paths`, `canonicalizeWatchPath`).
 *
 * `..` is resolved lexically first, so no missing component can be one. `ENOENT`
 * and `ENOTDIR` mean "does not exist yet" and walk up; any other failure (a
 * symlink loop, a permission error) is rethrown, and the caller treats it as
 * "cannot prove containment" rather than as containment.
 * @param target - the path to canonicalize, absolute or relative to `cwd`.
 * @param cwd - base for a relative target; defaults to the process directory.
 * @returns the canonical path, with the missing tail appended verbatim.
 */
export async function canonicalizeTargetPath(
  target: string,
  cwd: string = process.cwd(),
): Promise<string> {
  const absolute = path.resolve(cwd, target)
  const missing: string[] = []
  let current = absolute
  for (;;) {
    try {
      const resolved = await realpath(current)
      return missing.length === 0 ? resolved : path.join(resolved, ...missing)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = path.dirname(current)
      if (parent === current) return absolute
      missing.unshift(path.basename(current))
      current = parent
    }
  }
}

/**
 * Resolve `target` and report it only when it lands inside `root`, both after
 * `realpath` (DESIGN §5.2).
 * @param root - the containing root, possibly not existing yet.
 * @param target - the candidate path, possibly not existing yet.
 * @param cwd - base for a relative target.
 * @returns the canonical target when it is contained, otherwise `null`.
 */
export async function resolveContainedTarget(
  root: string,
  target: string,
  cwd: string = process.cwd(),
): Promise<string | null> {
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    canonicalizeTargetPath(root, cwd),
    canonicalizeTargetPath(target, cwd),
  ])
  return isPathWithin(canonicalRoot, canonicalTarget) ? canonicalTarget : null
}

/**
 * Whether `target` lands inside `root`, both after `realpath`.
 * @param root - the containing root.
 * @param target - the candidate path.
 * @param cwd - base for a relative target.
 * @returns true only when containment is proved.
 */
export async function isContainedPath(
  root: string,
  target: string,
  cwd: string = process.cwd(),
): Promise<boolean> {
  return (await resolveContainedTarget(root, target, cwd)) !== null
}
