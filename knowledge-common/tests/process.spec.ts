/**
 * Git subprocess seam suite: the default `execFile` runner, its environment
 * override, the reported non-zero status for a missing executable, and the
 * rejection that carries cancellation instead of a status.
 * @module knowledge-common/test/process.test
 */
import { describe, expect, it } from 'vitest'
import { createNodeGitRunner, GIT_SPAWN_FAILURE_CODE } from '../src/index.ts'

const cwd = process.cwd()

describe('createNodeGitRunner', () => {
  it('runs the command and reports its status and streams', async () => {
    const runner = createNodeGitRunner()
    const result = await runner(['--version'], { cwd })
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/^git version /u)
    expect(result.stderr).toBe('')
  })

  it('runs with the supplied environment instead of the parent one', async () => {
    const runner = createNodeGitRunner({ env: { PATH: process.env.PATH ?? '' } })
    expect((await runner(['--version'], { cwd })).code).toBe(0)
  })

  it('reports an executable that could not start as a spawn failure status', async () => {
    const runner = createNodeGitRunner({ gitPath: 'knowledge-common-no-such-git', env: {} })
    const result = await runner(['--version'], { cwd })
    expect(result.code).toBe(GIT_SPAWN_FAILURE_CODE)
    expect(result.stderr).not.toBe('')
  })

  it('rejects a cancelled command instead of reporting a status', async () => {
    const runner = createNodeGitRunner()
    const controller = new AbortController()
    controller.abort()
    await expect(runner(['--version'], { cwd, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})
