import { hostname, userInfo } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AuthorizationDeclinedError, AuthorizationError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationOutcome, AuthorizationPrompt, AuthorizationRequest } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecordInfo } from '@deepseek-ai/dsh-credentials'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { apply, inject, name } from '../src/index.ts'
import { CODEX_CALLBACK_PORT, currentSshLocalForwardCommand, sshLocalForwardCommand } from '../src/port-forward.ts'

const osMock = vi.hoisted(() => ({ failUserInfo: false }))

vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  return {
    ...os,
    hostname: () => 'codex-host',
    userInfo: () => {
      if (osMock.failUserInfo) throw new Error('uv_os_get_passwd returned ENOENT')
      return { username: 'codex-user', uid: -1, gid: -1, homedir: '/home/codex-user', shell: null }
    },
  }
})

const KEY = credentialKey('llm-pi-ai', 'openai-codex')

interface Harness {
  readonly ctx: Context
  readonly commands: Map<string, CommandDefinition>
  readonly begin: Mock<(request: AuthorizationRequest) => Promise<AuthorizationOutcome>>
  readonly cancel: Mock<() => void>
  readonly info: CredentialRecordInfo
  readonly describeRecord: Mock<() => Promise<CredentialRecordInfo>>
  readonly deleteRecord: Mock<() => Promise<void>>
}

/** Compose the plugin over fakes for the three host services it injects. */
function harness(beginImpl?: (request: AuthorizationRequest) => Promise<AuthorizationOutcome>): Harness {
  const ctx = new Context()
  const commands = new Map<string, CommandDefinition>()
  ctx.provide('commands', {
    register(definition: CommandDefinition) {
      commands.set(definition.name, definition)
      return () => { commands.delete(definition.name) }
    },
  } as never)
  const begin = vi.fn(beginImpl ?? (async (_request: AuthorizationRequest) => ({ status: 'authorized' as const })))
  const cancel = vi.fn()
  ctx.provide('authorization', { begin, cancel } as never)
  const info: CredentialRecordInfo = { configured: false, writable: true }
  const describeRecord = vi.fn(async () => info)
  const deleteRecord = vi.fn(async () => { info.configured = false; delete info.kind })
  ctx.provide('credentials', { describeRecord, deleteRecord } as never)
  apply(ctx)
  return { ctx, commands, begin, cancel, info, describeRecord, deleteRecord }
}

const harnesses: Harness[] = []
afterEach(async () => {
  for (const entry of harnesses.splice(0)) await entry.ctx.fiber.dispose()
  vi.restoreAllMocks()
})

function run(beginImpl?: (request: AuthorizationRequest) => Promise<AuthorizationOutcome>): Harness {
  const created = harness(beginImpl)
  harnesses.push(created)
  return created
}

function invocation(overrides: Partial<CommandInvocation> = {}): CommandInvocation {
  return {
    commandId: 'command-1' as CommandInvocation['commandId'],
    agent: {} as CommandInvocation['agent'],
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
    ...overrides,
  }
}

function handler(entry: Harness, command: string): (value: CommandInvocation) => Promise<CommandResult> | CommandResult {
  const definition = entry.commands.get(command)
  if (definition === undefined) throw new Error(`command ${command} is not registered`)
  return definition.handler
}

const SELECT: AuthorizationPrompt = {
  kind: 'select',
  message: 'Select OpenAI Codex login method:',
  options: [
    { id: 'device_code', label: 'Device code login (headless)' },
    { id: 'browser', label: 'Browser login (default)' },
  ],
}

const AUTH = {
  message: 'A browser window should open. Complete login to finish.',
  url: 'https://auth.openai.com/oauth/authorize?state=abc',
}

const FORWARD_LEAD = 'From another machine, forward the callback port first:'
const LOGIN_PASTE = 'If the browser cannot reach the callback (port 1455 is already taken by the Codex CLI), paste what the browser shows with /codex-code <value>.'

describe('SSH port forward', () => {
  it('renders the local forward from the given user, host, and port', () => {
    expect(CODEX_CALLBACK_PORT).toBe(1455)
    expect(sshLocalForwardCommand('ada', 'lab.example', 2222)).toBe('ssh -N -L 2222:127.0.0.1:2222 ada@lab.example')
  })

  it('uses the current user and hostname from node:os on the Codex callback port', () => {
    expect(currentSshLocalForwardCommand()).toBe(
      sshLocalForwardCommand(userInfo().username, hostname(), CODEX_CALLBACK_PORT),
    )
    expect(currentSshLocalForwardCommand()).toBe('ssh -N -L 1455:127.0.0.1:1455 codex-user@codex-host')
  })

  it('uses USER, then LOGNAME, then user when userInfo throws', () => {
    osMock.failUserInfo = true
    const previousUser = process.env.USER
    const previousLogname = process.env.LOGNAME
    try {
      process.env.USER = 'env-user'
      delete process.env.LOGNAME
      expect(currentSshLocalForwardCommand()).toBe('ssh -N -L 1455:127.0.0.1:1455 env-user@codex-host')
      delete process.env.USER
      process.env.LOGNAME = 'log-user'
      expect(currentSshLocalForwardCommand()).toBe('ssh -N -L 1455:127.0.0.1:1455 log-user@codex-host')
      delete process.env.LOGNAME
      expect(currentSshLocalForwardCommand()).toBe('ssh -N -L 1455:127.0.0.1:1455 user@codex-host')
    } finally {
      osMock.failUserInfo = false
      if (previousUser === undefined) delete process.env.USER
      else process.env.USER = previousUser
      if (previousLogname === undefined) delete process.env.LOGNAME
      else process.env.LOGNAME = previousLogname
    }
  })
})

describe('registration', () => {
  it('declares its name and the services it drives', () => {
    expect(name).toBe('openai-codex-oauth')
    expect(inject).toEqual(['authorization', 'commands', 'credentials'])
  })

  it('registers the five commands with descriptions', () => {
    const entry = run()
    expect([...entry.commands.keys()]).toEqual([
      'codex-login', 'codex-code', 'codex-status', 'codex-logout', 'codex-cancel',
    ])
    for (const definition of entry.commands.values()) expect(definition.description.length).toBeGreaterThan(0)
  })
})

describe('/codex-login', () => {
  it('answers the method question with browser and prints the authorization URL', async () => {
    const gate = Promise.withResolvers<undefined>()
    let method = 'unset'
    const entry = run(async (request) => {
      method = await request.interaction.prompt(SELECT)
      request.interaction.notify({ message: 'Contacting OpenAI…' })
      request.interaction.notify(AUTH)
      await gate.promise
      entry.info.configured = true
      entry.info.kind = 'grant'
      return { status: 'authorized' }
    })
    const result = await handler(entry, 'codex-login')(invocation())
    expect(method).toBe('browser')
    expect(result.kind).toBe('success')
    const lines = (result.text ?? '').split('\n')
    expect(lines[0]).toBe(`Sign in to OpenAI Codex at ${AUTH.url}.`)
    expect(result.text).toBe([
      `Sign in to OpenAI Codex at ${AUTH.url}.`,
      AUTH.message,
      `Open: ${AUTH.url}`,
      `Finish in this browser to sign in automatically. ${FORWARD_LEAD}`,
      currentSshLocalForwardCommand(),
      LOGIN_PASTE,
    ].join('\n'))
    expect(entry.begin).toHaveBeenCalledOnce()
    const [firstCall] = entry.begin.mock.calls
    if (firstCall === undefined) throw new Error('begin was not called')
    const [request] = firstCall
    expect(request.key).toBe(KEY)
    expect(request.method).toBe('oauth')
    expect(request.signal).toBeInstanceOf(AbortSignal)
    expect(typeof request.interaction.notify).toBe('function')
    gate.resolve(undefined)
    await vi.waitFor(async () => {
      const status = await handler(entry, 'codex-status')(invocation())
      expect(status.text).toContain('Sign-in: authorized.')
    })
  })

  it('waits for the authorization URL when an earlier notice carries no page', async () => {
    const gate = Promise.withResolvers<undefined>()
    const entry = run(async (request) => {
      await request.interaction.prompt(SELECT)
      request.interaction.notify({ message: 'Contacting OpenAI…' })
      await Promise.resolve()
      request.interaction.notify(AUTH)
      await gate.promise
      return { status: 'authorized' }
    })
    const result = await handler(entry, 'codex-login')(invocation())
    expect(result.text).toContain(AUTH.url)
    expect(result.text).not.toContain('Contacting OpenAI')
    gate.resolve(undefined)
  })

  it('rejects a method question that offers no browser login', async () => {
    let caught: unknown
    const entry = run(async (request) => {
      try {
        await request.interaction.prompt({
          kind: 'select',
          message: 'Select OpenAI Codex login method:',
          options: [{ id: 'device_code', label: 'Device code login (headless)' }],
        })
      } catch (error) {
        caught = error
        throw error
      }
      return { status: 'authorized' }
    })
    const result = await handler(entry, 'codex-login')(invocation())
    expect(caught).toBeInstanceOf(AuthorizationDeclinedError)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('no browser login')
    expect(result.text).toContain('DECLINED')
    expect(result.text).not.toContain('device_code')
  })

  it('reports a missing flow', async () => {
    const entry = run(async () => { throw new AuthorizationError('no flow', 'NO_FLOW') })
    const result = await handler(entry, 'codex-login')(invocation())
    expect(result.kind).toBe('error')
    expect(result.text).toContain('registers no OpenAI Codex OAuth flow')
  })

  it('reports the other authorization failure codes', async () => {
    const method = run(async () => { throw new AuthorizationError('method', 'UNKNOWN_METHOD') })
    expect((await handler(method, 'codex-login')(invocation())).text).toContain('no longer offers its OAuth method')
    const uncommitted = run(async () => { throw new AuthorizationError('commit', 'NOT_COMMITTED') })
    expect((await handler(uncommitted, 'codex-login')(invocation())).text).toContain('without storing a credential')
  })

  it('reports an attempt already started elsewhere', async () => {
    const entry = run(async () => { throw new AuthorizationError('busy', 'ALREADY_IN_FLIGHT') })
    const result = await handler(entry, 'codex-login')(invocation())
    expect(result.text).toContain('Another OpenAI Codex sign-in is already running')
  })

  it('reports an unexpected authorization code and a plain error', async () => {
    const coded = run(async () => { throw new AuthorizationError('boom', 'SOMETHING_ELSE') })
    expect((await handler(coded, 'codex-login')(invocation())).text).toContain('SOMETHING_ELSE')
    const plain = run(async () => { throw new Error('network down') })
    expect((await handler(plain, 'codex-login')(invocation())).text).toContain('network down')
    // The plugin must stay diagnosable when a flow rejects with a non-Error value.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercising that path needs a string rejection
    const unknown = run(() => Promise.reject('offline'))
    expect((await handler(unknown, 'codex-login')(invocation())).text).toContain('offline')
  })

  it('reports an immediate authorization and an immediate cancellation', async () => {
    const authorized = run(async (request) => {
      await request.interaction.prompt(SELECT)
      return { status: 'authorized' }
    })
    expect((await handler(authorized, 'codex-login')(invocation())).text).toContain('Signed in to OpenAI Codex')
    const status = await handler(authorized, 'codex-status')(invocation())
    expect(status.text).toContain('Sign-in: authorized.')
    expect(status.text).toContain('Paste: not expected.')

    const cancelled = run(async () => ({ status: 'cancelled' }))
    expect((await handler(cancelled, 'codex-login')(invocation())).text).toContain('cancelled')
    const cancelledStatus = await handler(cancelled, 'codex-status')(invocation())
    expect(cancelledStatus.text).toContain('Sign-in: cancelled.')
  })

  it('starts another sign-in after the previous one finished', async () => {
    const entry = run(async () => ({ status: 'authorized' }))
    await handler(entry, 'codex-login')(invocation())
    await handler(entry, 'codex-login')(invocation())
    expect(entry.begin).toHaveBeenCalledTimes(2)
  })

  it('refuses arguments', async () => {
    const entry = run()
    const result = await handler(entry, 'codex-login')(invocation({ rawInput: 'now' }))
    expect(result.kind).toBe('error')
    expect(result.text).toContain('Usage: /codex-login')
    expect(entry.begin).not.toHaveBeenCalled()
  })

  it('cancels when the calling request is withdrawn', async () => {
    const entry = run(request => new Promise<AuthorizationOutcome>((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => { reject(new Error('withdrawn')) }, { once: true })
    }))
    const controller = new AbortController()
    const pending = handler(entry, 'codex-login')(invocation({ signal: controller.signal }))
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    const result = await pending
    expect(result.text).toContain('cancelled')
    expect(entry.cancel).toHaveBeenCalledWith(KEY)
  })

  it('cancels an already-withdrawn request without waiting', async () => {
    const entry = run(async () => ({ status: 'authorized' }))
    const result = await handler(entry, 'codex-login')(invocation({ signal: AbortSignal.abort() }))
    expect(result.text).toContain('cancelled')
    expect(entry.cancel).toHaveBeenCalledWith(KEY)
  })

  it('refuses a second sign-in while one is waiting, showing the pending page', async () => {
    const gate = Promise.withResolvers<undefined>()
    const entry = run(async (request) => {
      await request.interaction.prompt(SELECT)
      request.interaction.notify(AUTH)
      await gate.promise
      return { status: 'authorized' }
    })
    await handler(entry, 'codex-login')(invocation())
    const second = await handler(entry, 'codex-login')(invocation())
    expect(second.kind).toBe('error')
    expect(second.text).toContain('already running')
    expect(second.text).toContain(AUTH.url)
    gate.resolve(undefined)
  })

  it('refuses a second sign-in before a page is available', async () => {
    const gate = Promise.withResolvers<undefined>()
    const entry = run(async () => {
      await gate.promise
      return { status: 'authorized' }
    })
    const controller = new AbortController()
    const first = handler(entry, 'codex-login')(invocation({ signal: controller.signal }))
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = await handler(entry, 'codex-login')(invocation())
    expect(second.text).toContain('already running')
    expect(second.text).not.toContain('Open:')
    const status = await handler(entry, 'codex-status')(invocation())
    expect(status.text).toContain('Sign-in: signing-in.')
    expect(status.text).not.toContain('Open:')
    expect(status.text).toContain('Paste: not expected.')
    controller.abort()
    await first
    gate.resolve(undefined)
  })
})

describe('/codex-code', () => {
  it('resolves the parked paste with the trimmed argument and does not echo it', async () => {
    const gate = Promise.withResolvers<undefined>()
    let pasted = 'unset'
    const entry = run(async (request) => {
      await request.interaction.prompt(SELECT)
      request.interaction.notify(AUTH)
      pasted = await request.interaction.prompt({
        kind: 'text',
        message: 'Complete login in your browser, or paste the authorization code / redirect URL here:',
        placeholder: 'http://localhost:1455/auth/callback',
      })
      await gate.promise
      return { status: 'authorized' }
    })
    await handler(entry, 'codex-login')(invocation())
    const waiting = await handler(entry, 'codex-status')(invocation())
    expect(waiting.text).toContain('Paste: expected. Submit it with /codex-code <value>.')
    expect(waiting.text).toContain(`Sign in to OpenAI Codex at ${AUTH.url}.`)
    const warn = vi.spyOn(entry.ctx.logger, 'warn')
    const info = vi.spyOn(entry.ctx.logger, 'info')
    const submitted = await handler(entry, 'codex-code')(invocation({ rawInput: '  super-secret-code  ' }))
    expect(submitted.kind).toBe('success')
    expect(submitted.text).toContain('Submitted the value')
    expect(submitted.text).not.toContain('super-secret-code')
    expect(pasted).toBe('super-secret-code')
    const logged = [...info.mock.calls, ...warn.mock.calls].flat().join('\n')
    expect(logged).not.toContain('super-secret-code')
    gate.resolve(undefined)
    await vi.waitFor(async () => {
      const status = await handler(entry, 'codex-status')(invocation())
      expect(status.text).toContain('Sign-in: authorized.')
      expect(status.text).toContain('Paste: not expected.')
      expect(status.text).not.toContain('super-secret-code')
    })
  })

  it('passes a full redirect URL through unchanged', async () => {
    let pasted = 'unset'
    const entry = run(async (request) => {
      await request.interaction.prompt(SELECT)
      request.interaction.notify(AUTH)
      pasted = await request.interaction.prompt({ kind: 'text', message: 'paste the redirect URL' })
      return { status: 'authorized' }
    })
    await handler(entry, 'codex-login')(invocation())
    const redirect = 'http://localhost:1455/auth/callback?code=abc&state=xyz'
    await handler(entry, 'codex-code')(invocation({ rawInput: `  ${redirect}  ` }))
    expect(pasted).toBe(redirect)
  })

  it('parks a secret prompt the same way', async () => {
    let pasted = 'unset'
    const entry = run(async (request) => {
      await request.interaction.prompt(SELECT)
      request.interaction.notify(AUTH)
      pasted = await request.interaction.prompt({ kind: 'secret', message: 'paste the code' })
      return { status: 'authorized' }
    })
    await handler(entry, 'codex-login')(invocation())
    await handler(entry, 'codex-code')(invocation({ rawInput: 'secret-code' }))
    expect(pasted).toBe('secret-code')
  })

  it('keeps the first paste when a second one arrives', async () => {
    let first = 'unset'
    let second: Promise<string> | undefined
    const entry = run(async (request) => {
      await request.interaction.prompt(SELECT)
      request.interaction.notify(AUTH)
      const parked = request.interaction.prompt({ kind: 'text', message: 'first' })
      second = request.interaction.prompt({ kind: 'secret', message: 'second' })
      first = await parked
      return { status: 'authorized' }
    })
    await handler(entry, 'codex-login')(invocation())
    const outcome = await second?.then(() => 'resolved', (error: unknown) => error)
    expect(outcome).toBeInstanceOf(Error)
    expect(outcome).not.toBeInstanceOf(AuthorizationDeclinedError)
    expect((outcome as Error).message).toContain('already waiting')
    await handler(entry, 'codex-code')(invocation({ rawInput: 'kept' }))
    expect(first).toBe('kept')
  })

  it('rejects a paste whose own signal already aborted', async () => {
    let caught: unknown
    const entry = run(async (request) => {
      await request.interaction.prompt(SELECT)
      try {
        await request.interaction.prompt({ kind: 'text', message: 'paste', signal: AbortSignal.abort() })
      } catch (error) {
        caught = error
        throw error
      }
      return { status: 'authorized' }
    })
    const result = await handler(entry, 'codex-login')(invocation())
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(AuthorizationDeclinedError)
    expect(result.text).toContain('paste prompt was withdrawn')
    const status = await handler(entry, 'codex-status')(invocation())
    expect(status.text).toContain('Paste: not expected.')
    expect(status.text).toContain('Sign-in: failed.')
  })

  it('rejects a paste when its own signal fires and leaves no stuck promise', async () => {
    const pasteAbort = new AbortController()
    let pasted: Promise<string> | undefined
    const entry = run(async (request) => {
      await request.interaction.prompt(SELECT)
      request.interaction.notify(AUTH)
      pasted = request.interaction.prompt({
        kind: 'text',
        message: 'paste',
        signal: pasteAbort.signal,
      })
      const seen = pasted.then(() => 'resolved', (error: unknown) => error)
      pasteAbort.abort()
      const outcome = await seen
      expect(outcome).toBeInstanceOf(Error)
      expect(outcome).not.toBeInstanceOf(AuthorizationDeclinedError)
      expect((outcome as Error).message).toContain('paste prompt was withdrawn')
      return { status: 'authorized' }
    })
    await handler(entry, 'codex-login')(invocation())
    await expect(pasted).rejects.toThrow('paste prompt was withdrawn')
    await vi.waitFor(async () => {
      const status = await handler(entry, 'codex-status')(invocation())
      expect(status.text).toContain('Paste: not expected.')
      expect(status.text).toContain('Sign-in: authorized.')
    })
    const late = await handler(entry, 'codex-code')(invocation({ rawInput: 'too-late' }))
    expect(late.kind).toBe('error')
    expect(late.text).toContain('No OpenAI Codex sign-in is running.')
  })

  it('rejects a missing argument, a finished attempt, and a sign-in that is not asking', async () => {
    const idle = run()
    expect((await handler(idle, 'codex-code')(invocation())).text).toContain('Usage: /codex-code')
    expect((await handler(idle, 'codex-code')(invocation({ rawInput: '   ' }))).text).toContain('Usage: /codex-code')
    expect((await handler(idle, 'codex-code')(invocation({ rawInput: 'code' }))).text).toContain('No OpenAI Codex sign-in is running.')

    const gate = Promise.withResolvers<undefined>()
    const entry = run(async (request) => {
      await request.interaction.prompt(SELECT)
      request.interaction.notify(AUTH)
      await gate.promise
      return { status: 'authorized' }
    })
    await handler(entry, 'codex-login')(invocation())
    const missing = await handler(entry, 'codex-code')(invocation({ rawInput: 'code' }))
    expect(missing.kind).toBe('error')
    expect(missing.text).toContain('No OpenAI Codex paste is expected')
    gate.resolve(undefined)
    await vi.waitFor(async () => {
      const done = await handler(entry, 'codex-code')(invocation({ rawInput: 'code' }))
      expect(done.text).toContain('No OpenAI Codex sign-in is running.')
    })
  })
})

describe('/codex-status', () => {
  it('reprints the SSH forward while signing in and omits it when idle or signed out', async () => {
    const idle = run()
    expect((await handler(idle, 'codex-status')(invocation())).text).not.toContain(FORWARD_LEAD)
    expect((await handler(idle, 'codex-status')(invocation())).text).not.toContain('ssh -N -L')

    const signedOut = run()
    signedOut.info.configured = true
    await handler(signedOut, 'codex-logout')(invocation())
    const afterLogout = await handler(signedOut, 'codex-status')(invocation())
    expect(afterLogout.text).toContain('Not signed in to OpenAI Codex.')
    expect(afterLogout.text).not.toContain(FORWARD_LEAD)
    expect(afterLogout.text).not.toContain('ssh -N -L')

    const gate = Promise.withResolvers<undefined>()
    const entry = run(async (request) => {
      await request.interaction.prompt(SELECT)
      request.interaction.notify(AUTH)
      await gate.promise
      return { status: 'authorized' }
    })
    await handler(entry, 'codex-login')(invocation())
    const waiting = await handler(entry, 'codex-status')(invocation())
    expect(waiting.text).toContain('Sign-in: signing-in.')
    const waitingLines = (waiting.text ?? '').split('\n')
    expect(waitingLines.at(-2)).toBe(FORWARD_LEAD)
    expect(waitingLines.at(-1)).toBe(currentSshLocalForwardCommand())
    expect(waiting.text).not.toContain('Finish in this browser')
    expect(waiting.text).not.toContain('If the browser cannot reach the callback')
    gate.resolve(undefined)
    await vi.waitFor(async () => {
      const done = await handler(entry, 'codex-status')(invocation())
      expect(done.text).toContain('Sign-in: authorized.')
      expect(done.text).not.toContain('ssh -N -L')
    })
  })

  it('reports a missing credential and rejects arguments', async () => {
    const entry = run()
    expect((await handler(entry, 'codex-status')(invocation())).text).toContain('Not signed in to OpenAI Codex.')
    expect((await handler(entry, 'codex-status')(invocation())).text).toContain('Paste: not expected.')
    expect((await handler(entry, 'codex-status')(invocation({ rawInput: 'x' }))).text).toContain('Usage: /codex-status')
  })

  it('reports a stored credential and the last failure', async () => {
    const entry = run(async () => { throw new Error('network down') })
    await handler(entry, 'codex-login')(invocation())
    entry.info.configured = true
    entry.info.kind = 'grant'
    const status = await handler(entry, 'codex-status')(invocation())
    expect(status.text).toContain('Signed in to OpenAI Codex.')
    expect(status.text).toContain('Sign-in: failed.')
    expect(status.text).toContain('network down')
    expect(status.text).not.toContain('Open:')
    expect(entry.describeRecord).toHaveBeenCalledWith(KEY)
  })
})

describe('/codex-logout', () => {
  it('removes a stored credential', async () => {
    const entry = run()
    entry.info.configured = true
    entry.info.kind = 'grant'
    const result = await handler(entry, 'codex-logout')(invocation())
    expect(result.text).toContain('Signed out of OpenAI Codex')
    expect(result.text).toContain('llm-pi-ai/openai-codex')
    expect(entry.deleteRecord).toHaveBeenCalledWith(KEY)
  })

  it('reports nothing to remove and rejects arguments', async () => {
    const entry = run()
    expect((await handler(entry, 'codex-logout')(invocation())).text).toContain('nothing to remove')
    expect((await handler(entry, 'codex-logout')(invocation({ rawInput: 'x' }))).text).toContain('Usage: /codex-logout')
    expect(entry.deleteRecord).not.toHaveBeenCalled()
  })

  it('withdraws a running sign-in and settles a parked paste before deleting', async () => {
    let pasted: Promise<string> | undefined
    const entry = run(async (request) => {
      await request.interaction.prompt(SELECT)
      request.interaction.notify(AUTH)
      pasted = request.interaction.prompt({ kind: 'text', message: 'paste', signal: new AbortController().signal })
      await pasted
      return { status: 'cancelled' }
    })
    await handler(entry, 'codex-login')(invocation())
    entry.info.configured = true
    const seen = pasted?.then(() => 'resolved', (error: unknown) => error)
    const result = await handler(entry, 'codex-logout')(invocation())
    expect(result.text).toContain('Signed out of OpenAI Codex')
    expect(entry.cancel).toHaveBeenCalledWith(KEY)
    expect(entry.deleteRecord).toHaveBeenCalledWith(KEY)
    const outcome = await seen
    expect(outcome).toBeInstanceOf(Error)
    expect(outcome).not.toBeInstanceOf(AuthorizationDeclinedError)
  })
})

describe('/codex-cancel', () => {
  it('withdraws a running sign-in', async () => {
    const gate = Promise.withResolvers<undefined>()
    let signal: AbortSignal | undefined
    let pasted: Promise<string> | undefined
    const entry = run(async (request) => {
      signal = request.signal
      await request.interaction.prompt(SELECT)
      request.interaction.notify(AUTH)
      pasted = request.interaction.prompt({ kind: 'text', message: 'paste' })
      await gate.promise
      return { status: 'cancelled' }
    })
    await handler(entry, 'codex-login')(invocation())
    const seen = pasted?.then(() => 'resolved', (error: unknown) => error)
    const result = await handler(entry, 'codex-cancel')(invocation())
    expect(result.text).toContain('Cancelling the OpenAI Codex sign-in.')
    expect(entry.cancel).toHaveBeenCalledWith(KEY)
    expect(signal?.aborted).toBe(true)
    const outcome = await seen
    expect(outcome).toBeInstanceOf(Error)
    expect(outcome).not.toBeInstanceOf(AuthorizationDeclinedError)
    gate.resolve(undefined)
  })

  it('reports no running sign-in and rejects arguments', async () => {
    const entry = run()
    expect((await handler(entry, 'codex-cancel')(invocation())).text).toContain('No OpenAI Codex sign-in is running.')
    expect((await handler(entry, 'codex-cancel')(invocation({ rawInput: 'x' }))).text).toContain('Usage: /codex-cancel')
  })

  it('treats a finished sign-in as not running', async () => {
    const entry = run(async () => ({ status: 'authorized' }))
    await handler(entry, 'codex-login')(invocation())
    expect((await handler(entry, 'codex-cancel')(invocation())).text).toContain('No OpenAI Codex sign-in is running.')
  })
})

describe('lifecycle', () => {
  it('withdraws a running sign-in, rejects a parked paste, and unregisters the commands', async () => {
    const gate = Promise.withResolvers<undefined>()
    let signal: AbortSignal | undefined
    let pasted: Promise<string> | undefined
    const entry = run(async (request) => {
      signal = request.signal
      await request.interaction.prompt(SELECT)
      request.interaction.notify(AUTH)
      pasted = request.interaction.prompt({ kind: 'text', message: 'paste' })
      await gate.promise
      return { status: 'cancelled' }
    })
    await handler(entry, 'codex-login')(invocation())
    const seen = pasted?.then(() => 'resolved', (error: unknown) => error)
    await entry.ctx.fiber.dispose()
    expect(signal?.aborted).toBe(true)
    expect(entry.cancel).toHaveBeenCalledWith(KEY)
    expect(entry.commands.size).toBe(0)
    const outcome = await seen
    expect(outcome).toBeInstanceOf(Error)
    expect(outcome).not.toBeInstanceOf(AuthorizationDeclinedError)
    gate.resolve(undefined)
  })

  it('cancels authorization on disposal when nothing is running', async () => {
    const entry = run()
    await entry.ctx.fiber.dispose()
    expect(entry.cancel).toHaveBeenCalledWith(KEY)
    expect(entry.commands.size).toBe(0)
  })
})
