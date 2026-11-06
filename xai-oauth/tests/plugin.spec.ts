import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AuthorizationError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationOutcome, AuthorizationRequest } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecordInfo } from '@deepseek-ai/dsh-credentials'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { apply, inject, name } from '../src/index.ts'

const KEY = credentialKey('llm-pi-ai', 'xai')

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

const DEVICE = {
  message: 'Enter this code on the verification page to finish signing in.',
  url: 'https://auth.x.ai/device',
  code: 'ABCD-1234',
}

describe('registration', () => {
  it('declares its name and the services it drives', () => {
    expect(name).toBe('xai-oauth')
    expect(inject).toEqual(['authorization', 'commands', 'credentials'])
  })

  it('registers the four commands with descriptions', () => {
    const entry = run()
    expect([...entry.commands.keys()]).toEqual(['xai-login', 'xai-status', 'xai-logout', 'xai-cancel'])
    for (const definition of entry.commands.values()) expect(definition.description.length).toBeGreaterThan(0)
  })
})

describe('/xai-login', () => {
  it('starts the existing flow and prints the device notice', async () => {
    const gate = Promise.withResolvers<undefined>()
    const entry = run(async (request) => {
      request.interaction.notify({ message: 'Contacting xAI…' })
      request.interaction.notify(DEVICE)
      await gate.promise
      entry.info.configured = true
      entry.info.kind = 'grant'
      return { status: 'authorized' }
    })
    const result = await handler(entry, 'xai-login')(invocation())
    expect(result.kind).toBe('success')
    expect(result.text).toContain('https://auth.x.ai/device')
    expect(result.text).toContain('ABCD-1234')
    expect(result.text).toContain('Sign in to xAI at https://auth.x.ai/device and enter code ABCD-1234.')
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
      const status = await handler(entry, 'xai-status')(invocation())
      expect(status.text).toContain('Sign-in: authorized.')
    })
  })

  it('waits for the device notice when an earlier notice carries no page', async () => {
    const gate = Promise.withResolvers<undefined>()
    const entry = run(async (request) => {
      request.interaction.notify({ message: 'Contacting xAI…' })
      await Promise.resolve()
      request.interaction.notify(DEVICE)
      await gate.promise
      return { status: 'authorized' }
    })
    const result = await handler(entry, 'xai-login')(invocation())
    expect(result.text).toContain('ABCD-1234')
    gate.resolve(undefined)
  })

  it('reports a missing flow', async () => {
    const entry = run(async () => { throw new AuthorizationError('no flow', 'NO_FLOW') })
    const result = await handler(entry, 'xai-login')(invocation())
    expect(result.kind).toBe('error')
    expect(result.text).toContain('registers no xAI OAuth flow')
  })

  it('reports the other authorization failure codes', async () => {
    const method = run(async () => { throw new AuthorizationError('method', 'UNKNOWN_METHOD') })
    expect((await handler(method, 'xai-login')(invocation())).text).toContain('no longer offers its OAuth method')
    const uncommitted = run(async () => { throw new AuthorizationError('commit', 'NOT_COMMITTED') })
    expect((await handler(uncommitted, 'xai-login')(invocation())).text).toContain('without storing a credential')
  })

  it('renders a page without a code and a code without a page', async () => {
    const gate = Promise.withResolvers<undefined>()
    const urlOnly = run(async (request) => {
      request.interaction.notify({ message: 'Open the page', url: 'https://auth.x.ai/only-url' })
      await gate.promise
      return { status: 'authorized' }
    })
    const first = await handler(urlOnly, 'xai-login')(invocation())
    expect(first.text).toContain('https://auth.x.ai/only-url')
    const firstStatus = await handler(urlOnly, 'xai-status')(invocation())
    expect(firstStatus.text).toContain('https://auth.x.ai/only-url')
    expect(firstStatus.text).not.toContain('Code:')
    gate.resolve(undefined)
    const codeGate = Promise.withResolvers<undefined>()
    const codeOnly = run(async (request) => {
      request.interaction.notify({ message: 'Enter the code', code: 'ONLY-CODE' })
      await codeGate.promise
      return { status: 'authorized' }
    })
    const second = await handler(codeOnly, 'xai-login')(invocation())
    expect(second.text).toContain('ONLY-CODE')
    const secondStatus = await handler(codeOnly, 'xai-status')(invocation())
    expect(secondStatus.text).toContain('ONLY-CODE')
    expect(secondStatus.text).not.toContain('Open:')
    codeGate.resolve(undefined)
  })

  it('reports an attempt already started elsewhere', async () => {
    const entry = run(async () => { throw new AuthorizationError('busy', 'ALREADY_IN_FLIGHT') })
    const result = await handler(entry, 'xai-login')(invocation())
    expect(result.text).toContain('Another xAI sign-in is already running')
  })

  it('reports an unexpected authorization code and a plain error', async () => {
    const coded = run(async () => { throw new AuthorizationError('boom', 'SOMETHING_ELSE') })
    expect((await handler(coded, 'xai-login')(invocation())).text).toContain('SOMETHING_ELSE')
    const plain = run(async () => { throw new Error('network down') })
    expect((await handler(plain, 'xai-login')(invocation())).text).toContain('network down')
    // The plugin must stay diagnosable when a flow rejects with a non-Error value.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercising that path needs a string rejection
    const unknown = run(() => Promise.reject('offline'))
    expect((await handler(unknown, 'xai-login')(invocation())).text).toContain('offline')
  })

  it('fails when the flow asks a question the command cannot show', async () => {
    const entry = run(async (request) => {
      await request.interaction.prompt({ kind: 'text', message: 'Enter the code' })
      return { status: 'authorized' }
    })
    const result = await handler(entry, 'xai-login')(invocation())
    expect(result.text).toContain('interactive input')
  })

  it('reports an immediate authorization and an immediate cancellation', async () => {
    const authorized = run(async () => ({ status: 'authorized' }))
    expect((await handler(authorized, 'xai-login')(invocation())).text).toContain('Signed in to xAI')
    const cancelled = run(async () => ({ status: 'cancelled' }))
    expect((await handler(cancelled, 'xai-login')(invocation())).text).toContain('cancelled')
  })

  it('refuses arguments', async () => {
    const entry = run()
    const result = await handler(entry, 'xai-login')(invocation({ rawInput: 'now' }))
    expect(result.kind).toBe('error')
    expect(result.text).toContain('Usage: /xai-login')
  })

  it('cancels when the calling request is withdrawn', async () => {
    const entry = run(request => new Promise<AuthorizationOutcome>((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => { reject(new Error('withdrawn')) }, { once: true })
    }))
    const controller = new AbortController()
    const pending = handler(entry, 'xai-login')(invocation({ signal: controller.signal }))
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    const result = await pending
    expect(result.text).toContain('cancelled')
    expect(entry.cancel).toHaveBeenCalledWith(KEY)
  })

  it('cancels an already-withdrawn request without waiting', async () => {
    const entry = run(async () => ({ status: 'authorized' }))
    const result = await handler(entry, 'xai-login')(invocation({ signal: AbortSignal.abort() }))
    expect(result.text).toContain('cancelled')
    expect(entry.cancel).toHaveBeenCalledWith(KEY)
  })

  it('refuses a second sign-in while one is waiting, showing the pending page', async () => {
    const gate = Promise.withResolvers<undefined>()
    const entry = run(async (request) => {
      request.interaction.notify(DEVICE)
      await gate.promise
      return { status: 'authorized' }
    })
    await handler(entry, 'xai-login')(invocation())
    const second = await handler(entry, 'xai-login')(invocation())
    expect(second.kind).toBe('error')
    expect(second.text).toContain('already running')
    expect(second.text).toContain('https://auth.x.ai/device')
    gate.resolve(undefined)
  })

  it('refuses a second sign-in before a page is available', async () => {
    const gate = Promise.withResolvers<undefined>()
    const entry = run(async () => {
      await gate.promise
      return { status: 'authorized' }
    })
    const controller = new AbortController()
    const first = handler(entry, 'xai-login')(invocation({ signal: controller.signal }))
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = await handler(entry, 'xai-login')(invocation())
    expect(second.text).toContain('already running')
    expect(second.text).not.toContain('Open:')
    const status = await handler(entry, 'xai-status')(invocation())
    expect(status.text).toContain('Sign-in: signing-in.')
    expect(status.text).not.toContain('Open:')
    controller.abort()
    await first
    gate.resolve(undefined)
  })
})

describe('/xai-status', () => {
  it('reports a missing credential and rejects arguments', async () => {
    const entry = run()
    expect((await handler(entry, 'xai-status')(invocation())).text).toContain('Not signed in to xAI.')
    expect((await handler(entry, 'xai-status')(invocation({ rawInput: 'x' }))).text).toContain('Usage: /xai-status')
  })

  it('reports a stored credential and the last failure', async () => {
    const entry = run(async () => { throw new Error('network down') })
    await handler(entry, 'xai-login')(invocation())
    entry.info.configured = true
    entry.info.kind = 'grant'
    const status = await handler(entry, 'xai-status')(invocation())
    expect(status.text).toContain('Signed in to xAI.')
    expect(status.text).toContain('Sign-in: failed.')
    expect(status.text).toContain('network down')
  })

  it('shows the pending page and code while a sign-in waits', async () => {
    const gate = Promise.withResolvers<undefined>()
    const entry = run(async (request) => {
      request.interaction.notify(DEVICE)
      await gate.promise
      return { status: 'authorized' }
    })
    await handler(entry, 'xai-login')(invocation())
    const status = await handler(entry, 'xai-status')(invocation())
    expect(status.text).toContain('Sign-in: signing-in.')
    expect(status.text).toContain('https://auth.x.ai/device')
    expect(status.text).toContain('ABCD-1234')
    gate.resolve(undefined)
  })
})

describe('/xai-logout', () => {
  it('removes a stored credential', async () => {
    const entry = run()
    entry.info.configured = true
    entry.info.kind = 'grant'
    const result = await handler(entry, 'xai-logout')(invocation())
    expect(result.text).toContain('Signed out of xAI')
    expect(entry.deleteRecord).toHaveBeenCalledWith(KEY)
  })

  it('reports nothing to remove and rejects arguments', async () => {
    const entry = run()
    expect((await handler(entry, 'xai-logout')(invocation())).text).toContain('nothing to remove')
    expect((await handler(entry, 'xai-logout')(invocation({ rawInput: 'x' }))).text).toContain('Usage: /xai-logout')
    expect(entry.deleteRecord).not.toHaveBeenCalled()
  })

  it('withdraws a running sign-in before deleting', async () => {
    const gate = Promise.withResolvers<undefined>()
    const entry = run(async (request) => {
      request.interaction.notify(DEVICE)
      await gate.promise
      return { status: 'cancelled' }
    })
    await handler(entry, 'xai-login')(invocation())
    entry.info.configured = true
    const result = await handler(entry, 'xai-logout')(invocation())
    expect(result.text).toContain('Signed out of xAI')
    expect(entry.cancel).toHaveBeenCalledWith(KEY)
    gate.resolve(undefined)
  })
})

describe('/xai-cancel', () => {
  it('withdraws a running sign-in', async () => {
    const gate = Promise.withResolvers<undefined>()
    let signal: AbortSignal | undefined
    const entry = run(async (request) => {
      signal = request.signal
      request.interaction.notify(DEVICE)
      await gate.promise
      return { status: 'cancelled' }
    })
    await handler(entry, 'xai-login')(invocation())
    const result = handler(entry, 'xai-cancel')(invocation())
    expect((result as CommandResult).text).toContain('Cancelling the xAI sign-in.')
    expect(entry.cancel).toHaveBeenCalledWith(KEY)
    expect(signal?.aborted).toBe(true)
    gate.resolve(undefined)
  })

  it('reports no running sign-in and rejects arguments', () => {
    const entry = run()
    expect((handler(entry, 'xai-cancel')(invocation()) as CommandResult).text).toContain('No xAI sign-in is running.')
    expect((handler(entry, 'xai-cancel')(invocation({ rawInput: 'x' })) as CommandResult).text).toContain('Usage: /xai-cancel')
  })

  it('treats a finished sign-in as not running', async () => {
    const entry = run(async () => ({ status: 'authorized' }))
    await handler(entry, 'xai-login')(invocation())
    expect((handler(entry, 'xai-cancel')(invocation()) as CommandResult).text).toContain('No xAI sign-in is running.')
  })
})

describe('lifecycle', () => {
  it('withdraws a running sign-in and unregisters the commands on disposal', async () => {
    const gate = Promise.withResolvers<undefined>()
    let signal: AbortSignal | undefined
    const entry = run(async (request) => {
      signal = request.signal
      request.interaction.notify(DEVICE)
      await gate.promise
      return { status: 'cancelled' }
    })
    await handler(entry, 'xai-login')(invocation())
    await entry.ctx.fiber.dispose()
    expect(signal?.aborted).toBe(true)
    expect(entry.cancel).toHaveBeenCalledWith(KEY)
    expect(entry.commands.size).toBe(0)
    gate.resolve(undefined)
  })
})
