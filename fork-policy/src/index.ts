/**
 * Fork profile layers and the Node egress guard.
 *
 * Importing this module installs the guard in the current process.
 * @module @anago-harness/fork-policy
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

/** Hostname decision exposed by the installed egress guard. */
export interface EgressGuard {
  /**
   * Decide whether a hostname is denied.
   * @param host - Raw host from a connect, lookup, or proxy target.
   * @returns A reason string when the host is denied, otherwise `undefined`.
   */
  verdict(host: string): string | undefined
  /**
   * Normalize a host the way the denylist matches it.
   * @param host - Raw host text.
   * @returns The ASCII hostname used for matching.
   */
  normalize(host: string): string
}

interface GuardModule {
  readonly guard: EgressGuard
}

// A string keeps the file in the worker image. A computed URL is omitted, and
// import.meta.url in that image is not a file URL. A desktop bundle rebases that
// string onto lib/main.js, where the file is not a sibling; the packaged copy is.
function loadGuard(): GuardModule {
  try {
    // oxlint-disable-next-line typescript/no-unsafe-return -- createRequire returns any; egress-guard.cjs exports the installed guard
    return require('../egress-guard.cjs')
  } catch (error) {
    if (!isModuleNotFound(error)) throw error
    const fallback = egressGuardFallbacks(dirname(fileURLToPath(import.meta.url)), electronResourcesPath(process)).find(path => existsSync(path))
    if (fallback === undefined) throw error
    // oxlint-disable-next-line typescript/no-unsafe-return -- createRequire returns any; the fallback file is the same guard
    return require(fallback)
  }
}

function isModuleNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND'
}

/**
 * Read Electron's resources directory when this process is the packaged shell.
 * Plain Node does not set the field.
 * @param host - The current process, or a test double with the same field.
 * @returns The resources root, or `undefined` when the field is absent or empty.
 */
function electronResourcesPath(host: object): string | undefined {
  if (!('resourcesPath' in host)) return undefined
  const value = host.resourcesPath
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Paths searched when the package-relative guard require misses.
 * The first existing file is loaded. The desktop shell looks beside `lib/` and under the archived dsh tree.
 * @param moduleDirectory - Directory of the module whose package-relative require failed.
 * @param resourcesPath - Electron `process.resourcesPath`, when this process is the packaged shell.
 * @returns Candidate guard files, in search order.
 */
export function egressGuardFallbacks(moduleDirectory: string, resourcesPath: string | undefined): readonly string[] {
  const candidates = [
    join(moduleDirectory, '..', 'egress-guard.cjs'),
    join(moduleDirectory, '..', 'dsh', 'node_modules', '@anago-harness', 'fork-policy', 'egress-guard.cjs'),
    join(moduleDirectory, '..', '..', '..', 'plugins', 'fork-policy', 'egress-guard.cjs'),
  ]
  if (resourcesPath !== undefined && resourcesPath !== '') {
    candidates.push(join(resourcesPath, 'app.asar', 'dsh', 'node_modules', '@anago-harness', 'fork-policy', 'egress-guard.cjs'))
  }
  return candidates
}

const guardModule: GuardModule = loadGuard()

/** Installed egress guard. Evaluating this binding installs the denylist. */
export const guard: EgressGuard = guardModule.guard

/**
 * Fork profile patches applied with the bundle layers.
 * The current list is empty.
 * @param entries - Composed bundle rows supplied by the boot composer.
 * @returns No patches.
 */
export function forkDefaultPatches(entries: readonly unknown[]): readonly never[] {
  void entries
  return []
}

/**
 * Fork profile patches applied after every other layer.
 * The current list is empty.
 * @param entries - Composed rows present before this final layer.
 * @returns No patches.
 */
export function forkLockPatches(entries: readonly unknown[]): readonly never[] {
  void entries
  return []
}
