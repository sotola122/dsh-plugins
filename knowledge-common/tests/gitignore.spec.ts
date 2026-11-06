/**
 * Managed `.gitignore` block suite (DESIGN §5.1, §3.2; §10 `.gitignore` 編集):
 * append, inner-only replacement, idempotence, CRLF and no-trailing-newline
 * handling, marker anomalies, the size/mtime re-check, and the unwritable cases.
 * @module knowledge-common/test/gitignore.test
 */
import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureGitignoreBlock,
  expectedGitignoreLines,
  GitignoreEditError,
  GITIGNORE_START_LINE,
  inspectGitignoreBlock,
  planGitignoreUpdate,
  renderGitignoreBlock,
} from '../src/index.ts'
import { createTempDir, createTestAtomicWrite, removeTempDirs } from './support.ts'

afterEach(removeTempDirs)

const BASE_LINES = expectedGitignoreLines()
const ALL_LINES = expectedGitignoreLines({ wikiCommitted: true, skillsTracked: true })

/** The block exactly as DESIGN §3.2 writes it. */
const FULL_BLOCK = [
  GITIGNORE_START_LINE,
  '.dsh/*',
  '!.dsh/wiki.yml',
  '!.dsh/wiki/',
  '!.dsh/skills/',
  '# <<< dsh-memory',
  '',
].join('\n')

describe('expectedGitignoreLines', () => {
  it('always ignores the store and keeps the configuration file', () => {
    expect(BASE_LINES).toEqual(['.dsh/*', '!.dsh/wiki.yml'])
  })

  it('adds the wiki directory only when the wiki is committed', () => {
    expect(expectedGitignoreLines({ wikiCommitted: true })).toEqual([
      '.dsh/*',
      '!.dsh/wiki.yml',
      '!.dsh/wiki/',
    ])
  })

  it('adds the skills directory only when skills are tracked', () => {
    expect(expectedGitignoreLines({ skillsTracked: true })).toEqual([
      '.dsh/*',
      '!.dsh/wiki.yml',
      '!.dsh/skills/',
    ])
  })

  it('renders the block of DESIGN §3.2', () => {
    expect(renderGitignoreBlock(ALL_LINES)).toBe(FULL_BLOCK)
    expect(renderGitignoreBlock(ALL_LINES, '\r\n')).toBe(FULL_BLOCK.replace(/\n/gu, '\r\n'))
  })
})

describe('inspectGitignoreBlock', () => {
  it('reports absence, presence, and anomaly', () => {
    expect(inspectGitignoreBlock('dist/\n')).toEqual({ kind: 'absent' })
    const present = inspectGitignoreBlock(`${FULL_BLOCK}dist/\n`)
    expect(present.kind).toBe('present')
    expect(inspectGitignoreBlock('# >>> dsh-memory\n').kind).toBe('malformed')
    expect(inspectGitignoreBlock('# <<< dsh-memory\n').kind).toBe('malformed')
    expect(inspectGitignoreBlock('# <<< dsh-memory\n# >>> dsh-memory\n').kind).toBe('malformed')
    expect(
      inspectGitignoreBlock('# >>> dsh-memory\n# >>> dsh-memory\n# <<< dsh-memory\n').kind,
    ).toBe('malformed')
  })

  it('accepts the managed suffix and trailing whitespace on a marker line', () => {
    expect(inspectGitignoreBlock(`${GITIGNORE_START_LINE}   \ninner\n# <<< dsh-memory\n`).kind).toBe(
      'present',
    )
  })

  it('accepts a marker carrying a tab or a parenthesized note', () => {
    for (const suffix of ['\tlegacy', '(note)']) {
      expect(
        inspectGitignoreBlock(`# >>> dsh-memory${suffix}\ninner\n# <<< dsh-memory\n`).kind,
      ).toBe('present')
    }
  })

  it('does not treat a longer word that merely starts with a marker as one', () => {
    expect(inspectGitignoreBlock('# >>> dsh-memoryX\ninner\n').kind).toBe('absent')
  })
})

describe('planGitignoreUpdate', () => {
  it('appends the block to an empty file', () => {
    const plan = planGitignoreUpdate('', BASE_LINES)
    expect(plan.changed).toBe(true)
    expect(plan.added).toBe(true)
    expect(plan.content).toBe(renderGitignoreBlock(BASE_LINES))
  })

  it('finishes the last line and separates the block with a blank line', () => {
    expect(planGitignoreUpdate('dist/', BASE_LINES).content).toBe(
      `dist/\n\n${renderGitignoreBlock(BASE_LINES)}`,
    )
    expect(planGitignoreUpdate('dist/\n', BASE_LINES).content).toBe(
      `dist/\n\n${renderGitignoreBlock(BASE_LINES)}`,
    )
  })

  it('does not stack blank lines on a file that already ends with one', () => {
    expect(planGitignoreUpdate('dist/\n\n', BASE_LINES).content).toBe(
      `dist/\n\n${renderGitignoreBlock(BASE_LINES)}`,
    )
  })

  it('replaces only the inner lines and keeps every other byte', () => {
    const content = `# header\n\n${renderGitignoreBlock(BASE_LINES)}\ndist/\n`
    const plan = planGitignoreUpdate(content, ALL_LINES)
    expect(plan.changed).toBe(true)
    expect(plan.added).toBe(false)
    expect(plan.content).toBe(`# header\n\n${renderGitignoreBlock(ALL_LINES)}\ndist/\n`)
    expect(plan.content.startsWith('# header\n\n')).toBe(true)
    expect(plan.content.endsWith('\ndist/\n')).toBe(true)
  })

  it('keeps CRLF and the byte layout of the marker lines', () => {
    const content = 'dist/\r\n# >>> dsh-memory\r\n.dsh/*\r\n# <<< dsh-memory\r\ntmp/\r\n'
    const plan = planGitignoreUpdate(content, BASE_LINES)
    expect(plan.content).toBe(
      'dist/\r\n# >>> dsh-memory\r\n.dsh/*\r\n!.dsh/wiki.yml\r\n# <<< dsh-memory\r\ntmp/\r\n',
    )
  })

  it('adds CRLF lines when the file is a CRLF file', () => {
    const plan = planGitignoreUpdate('dist/\r\n', BASE_LINES)
    expect(plan.content).toBe(`dist/\r\n\r\n${renderGitignoreBlock(BASE_LINES, '\r\n')}`)
  })

  it('keeps a marker line with trailing whitespace untouched', () => {
    const content = '# >>> dsh-memory   \n.dsh/*\n# <<< dsh-memory\n'
    const plan = planGitignoreUpdate(content, BASE_LINES)
    expect(plan.content).toBe(`# >>> dsh-memory   \n${BASE_LINES.join('\n')}\n# <<< dsh-memory\n`)
  })

  it('is idempotent: the second plan writes nothing', () => {
    const once = planGitignoreUpdate('dist/\n', ALL_LINES)
    const twice = planGitignoreUpdate(once.content, ALL_LINES)
    expect(twice.changed).toBe(false)
    expect(twice.content).toBe(once.content)
    const fromBlock = planGitignoreUpdate(renderGitignoreBlock(ALL_LINES), ALL_LINES)
    expect(fromBlock.changed).toBe(false)
  })

  it('refuses an anomalous marker pair without changing anything', () => {
    for (const content of [
      '# >>> dsh-memory\n.dsh/*\n',
      '.dsh/*\n# <<< dsh-memory\n',
      '# <<< dsh-memory\n.dsh/*\n# >>> dsh-memory\n',
      '# >>> dsh-memory\n# >>> dsh-memory\n# <<< dsh-memory\n',
    ]) {
      const failure = (() => {
        try {
          planGitignoreUpdate(content, BASE_LINES)
          return undefined
        } catch (error) {
          return error
        }
      })()
      expect(failure).toBeInstanceOf(GitignoreEditError)
      expect((failure as GitignoreEditError).code).toBe('GITIGNORE_MALFORMED')
    }
  })

  it('rejects an empty line list instead of emptying the block', () => {
    expect(() => planGitignoreUpdate('', [])).toThrow(TypeError)
  })
})

describe('ensureGitignoreBlock', () => {
  it('creates the file with 0644 and the block', async () => {
    const root = await createTempDir()
    const api = createTestAtomicWrite()
    const result = await ensureGitignoreBlock(api, { root, lines: BASE_LINES })
    expect(result).toMatchObject({ changed: true, created: true, added: true })
    expect(await readFile(result.path, 'utf8')).toBe(renderGitignoreBlock(BASE_LINES))
    expect((await stat(result.path)).mode & 0o777).toBe(0o644)
  })

  it('updates only the block on the second, different expectation', async () => {
    const root = await createTempDir()
    const api = createTestAtomicWrite()
    await writeFile(path.join(root, '.gitignore'), 'dist/\n')
    await ensureGitignoreBlock(api, { root, lines: BASE_LINES })
    const result = await ensureGitignoreBlock(api, { root, lines: ALL_LINES })
    expect(result).toMatchObject({ changed: true, created: false, added: false })
    expect(await readFile(result.path, 'utf8')).toBe(`dist/\n\n${renderGitignoreBlock(ALL_LINES)}`)
  })

  it('writes nothing when the block already matches', async () => {
    const root = await createTempDir()
    const api = createTestAtomicWrite()
    const first = await ensureGitignoreBlock(api, { root, lines: ALL_LINES })
    const before = await stat(first.path)
    const second = await ensureGitignoreBlock(api, { root, lines: ALL_LINES })
    expect(second.changed).toBe(false)
    expect((await stat(second.path)).ino).toBe(before.ino)
    expect(api.events.filter(event => event.kind === 'write')).toHaveLength(1)
  })

  it('refuses when the file changes between the read and the replacement', async () => {
    const root = await createTempDir()
    const api = createTestAtomicWrite()
    const file = path.join(root, '.gitignore')
    await writeFile(file, 'dist/\n')
    // An editor saving while the block is being rendered: the getter runs
    // inside planGitignoreUpdate, before the size/mtime re-check.
    const lines = [...BASE_LINES]
    Object.defineProperty(lines, '1', {
      get() {
        writeFileSync(file, 'dist/\nchanged elsewhere\n')
        return '!.dsh/wiki.yml'
      },
    })
    const failure = await ensureGitignoreBlock(api, { root, lines }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(GitignoreEditError)
    expect((failure as GitignoreEditError).code).toBe('GITIGNORE_CONFLICT')
    expect(await readFile(file, 'utf8')).toBe('dist/\nchanged elsewhere\n')
  })

  it('refuses an anomalous marker pair without touching the file', async () => {
    const root = await createTempDir()
    const api = createTestAtomicWrite()
    const file = path.join(root, '.gitignore')
    await writeFile(file, '# >>> dsh-memory\n.dsh/*\n')
    const failure = await ensureGitignoreBlock(api, { root, lines: BASE_LINES }).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(GitignoreEditError)
    expect((failure as GitignoreEditError).code).toBe('GITIGNORE_MALFORMED')
    expect(await readFile(file, 'utf8')).toBe('# >>> dsh-memory\n.dsh/*\n')
  })

  it('refuses to replace a symbolic link', async () => {
    const root = await createTempDir()
    const api = createTestAtomicWrite()
    const elsewhere = path.join(root, 'elsewhere')
    await writeFile(elsewhere, 'dist/\n')
    await symlink(elsewhere, path.join(root, '.gitignore'))
    const failure = await ensureGitignoreBlock(api, { root, lines: BASE_LINES }).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(GitignoreEditError)
    expect((failure as GitignoreEditError).code).toBe('GITIGNORE_UNWRITABLE')
    expect(await readFile(elsewhere, 'utf8')).toBe('dist/\n')
  })

  it.skipIf(process.getuid?.() === 0)('refuses to write into a read-only directory', async () => {
    const root = await createTempDir()
    const api = createTestAtomicWrite()
    await writeFile(path.join(root, '.gitignore'), 'dist/\n')
    await chmod(root, 0o555)
    try {
      const failure = await ensureGitignoreBlock(api, { root, lines: BASE_LINES }).catch(
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(GitignoreEditError)
      expect((failure as GitignoreEditError).code).toBe('GITIGNORE_UNWRITABLE')
    } finally {
      await chmod(root, 0o755)
    }
  })

  it('reports the lock deadline', async () => {
    const root = await createTempDir()
    const api = createTestAtomicWrite()
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, '.gitignore.lock'), '999999\n')
    const failure = await ensureGitignoreBlock(api, { root, lines: BASE_LINES, lockWaitMs: 120 }).catch(
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ code: 'LOCK_TIMEOUT' })
  })

  it.each(['EACCES', 'EPERM', 'EROFS', 'EISDIR', 'ENOTDIR'])(
    'maps a %s failure from the write seam onto the documented refusal',
    async (code) => {
      const root = await createTempDir()
      const api = {
        async writeFileAtomic(): Promise<void> {},
        async withFileLock(): Promise<never> {
          throw Object.assign(new Error(`simulated ${code}`), { code })
        },
      }
      const failure = await ensureGitignoreBlock(api, { root, lines: BASE_LINES }).catch(
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(GitignoreEditError)
      expect((failure as GitignoreEditError).code).toBe('GITIGNORE_UNWRITABLE')
      expect((failure as Error).message).toContain(code)
    },
  )

  it('rethrows a failure whose code it does not map', async () => {
    const root = await createTempDir()
    const api = {
      async writeFileAtomic(): Promise<void> {},
      async withFileLock(): Promise<never> {
        throw Object.assign(new Error('simulated ENOSPC'), { code: 'ENOSPC' })
      },
    }
    const failure = await ensureGitignoreBlock(api, { root, lines: BASE_LINES }).catch(
      (error: unknown) => error,
    )
    expect(failure).not.toBeInstanceOf(GitignoreEditError)
    expect((failure as Error).message).toBe('simulated ENOSPC')
  })

  it('maps a permission failure from inspecting the target', async () => {
    const root = await createTempDir()
    await writeFile(path.join(root, '.gitignore'), 'dist/\n')
    const api = {
      async writeFileAtomic(): Promise<void> {},
      async withFileLock<T>(_filename: string, operation: () => Promise<T>): Promise<T> {
        return operation()
      },
    }
    await chmod(root, 0o000)
    try {
      const failure = await ensureGitignoreBlock(api, { root, lines: BASE_LINES }).catch(
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(GitignoreEditError)
      expect((failure as GitignoreEditError).code).toBe('GITIGNORE_UNWRITABLE')
    } finally {
      await chmod(root, 0o755)
    }
  })

  it('refuses a write that does not land the planned byte count', async () => {
    const root = await createTempDir()
    const api = {
      async writeFileAtomic(filename: string, content: string | Uint8Array): Promise<void> {
        const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8')
        await writeFile(filename, text.slice(0, Math.max(0, text.length - 2)), { mode: 0o644 })
      },
      async withFileLock<T>(_filename: string, operation: () => Promise<T>): Promise<T> {
        return operation()
      },
    }
    const failure = await ensureGitignoreBlock(api, { root, lines: BASE_LINES }).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(GitignoreEditError)
    expect((failure as GitignoreEditError).code).toBe('GITIGNORE_WRITE_MISMATCH')
  })

  it('forwards the caller signal into the locked update', async () => {
    const root = await createTempDir()
    const api = createTestAtomicWrite()
    const result = await ensureGitignoreBlock(api, {
      root,
      lines: BASE_LINES,
      signal: new AbortController().signal,
    })
    expect(result.changed).toBe(true)
  })
})
