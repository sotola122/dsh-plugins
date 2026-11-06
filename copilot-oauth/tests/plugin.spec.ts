import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AuthorizationError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationOutcome, AuthorizationPrompt, AuthorizationRequest } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecordInfo } from '@deepseek-ai/dsh-credentials'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { apply, inject, name } from '../src/index.ts'

const KEY = credentialKey('llm-pi-ai', 'github-copilot')

interface Harness {
  readonly ctx: Context
  readonly commands: Map<string, CommandDefinition>
  readonly begin: Mock<(request: AuthorizationRequest) => Promise<AuthorizationOutcome>>
  readonly cancel: Mock<() => void>
  readonly describe: Mock<(key: string) => unknown>
  readonly info: CredentialRecordInfo
  readonly describeRecord: Mock<() => Promise<CredentialRecordInfo>>
  readonly deleteRecord: Mock<() => Promise<void>>
  readonly holds: Array<{ readonly agent: unknown; released: boolean }>
}

/** Compose the plugin over fakes for the three host services it injects. */
function harness(
  beginImpl?: (request: AuthorizationRequest) => Promise<AuthorizationOutcome>,
  flowRegistered = true,
): Harness {
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
  const describe = vi.fn(() => flowRegistered ? {
    key: KEY,
    label: 'GitHub Copilot',
    methods: [{ id: 'oauth', label: 'GitHub Copilot' }],
    inFlight: false,
  } : undefined)
  ctx.provide('authorization', { begin, cancel, describe } as never)
  const info: CredentialRecordInfo = { configured: false, writable: true }
  const describeRecord = vi.fn(async () => info)
  const deleteRecord = vi.fn(async () => { info.configured = false; delete info.kind })
  ctx.provide('credentials', { describeRecord, deleteRecord } as never)
  const holds: Array<{ agent: unknown; released: boolean }> = []
  ctx.provide('agents', {
    hold(agent: unknown) {
      const entry = { agent, released: false }
      holds.push(entry)
      return { [Symbol.dispose]: () => { entry.released = true } }
    },
  } as never)
  apply(ctx)
  return { ctx, commands, begin, cancel, describe, info, describeRecord, deleteRecord, holds }
}

const harnesses: Harness[] = []
afterEach(async () => {
  for (const entry of harnesses.splice(0)) await entry.ctx.fiber.dispose()
  vi.restoreAllMocks()
})

function run(
  beginImpl?: (request: AuthorizationRequest) => Promise<AuthorizationOutcome>,
  flowRegistered = true,
): Harness {
  const created = harness(beginImpl, flowRegistered)
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
  url: 'https://github.com/login/device',
  code: 'ABCD-1234',
}

const CHOICES: AuthorizationPrompt = {
  kind: 'select',
  message: 'Pick a GitHub host',
  options: [
    { id: 'github.com', label: 'GitHub.com' },
    { id: 'ghe', label: 'company.ghe.com' },
  ],
}

describe('agent hold', () => {
  it('holds the Agent for the duration of a command', async () => {
    const entry = run()
    await handler(entry, 'copilot-status')(invocation())
    expect(entry.holds).toHaveLength(1)
    expect(entry.holds[0]?.released).toBe(true)
  })
})

describe('registration', () => {
  it('declares its name and the services it drives', () => {
    expect(name).toBe('copilot-oauth')
    expect(inject).toEqual(['authorization', 'commands', 'credentials'])
  })

  it('registers the four commands with descriptions', () => {
    const entry = run()
    expect([...entry.commands.keys()]).toEqual(['copilot-login', 'copilot-status', 'copilot-logout', 'copilot-cancel'])
    for (const definition of entry.commands.values()) expect(definition.description.length).toBeGreaterThan(0)
  })
})

describe('/copilot-login', () => {
  it('reports a missing flow before starting one', async () => {
    const entry = run(undefined, false)
    const result = await handler(entry, 'copilot-login')(invocation())
    expect(result.kind).toBe('error')
    expect(result.text).toContain('no GitHub Copilot OAuth flow')
    expect(result.text).toContain('registers no flow of its own')
    expect(entry.begin).not.toHaveBeenCalled()
    expect(entry.describe).toHaveBeenCalledWith(KEY)
  })

  it('starts the existing flow and prints the device notice on the first line', async () => {
    const gate = Promise.withResolvers<undefined>()
    const entry = run(async (request) => {
      request.interaction.notify({ message: 'Contacting GitHub…' })
      request.interaction.notify(DEVICE)
      await gate.promise
      entry.info.configured = true
      entry.info.kind = 'grant'
      return { status: 'authorized' }
    })
    const result = await handler(entry, 'copilot-login')(invocation())
    expect(result.kind).toBe('success')
    const [firstLine] = (result.text ?? '').split('\n')
    expect(firstLine).toContain('https://github.com/login/device')
    expect(firstLine).toContain('ABCD-1234')
    expect(firstLine).toBe('Sign in to GitHub Copilot at https://github.com/login/device and enter code ABCD-1234.')
    expect(result.text).toContain(DEVICE.message)
    expect(result.text).toContain('/copilot-status')
    expect(result.text).toContain('/copilot-cancel')
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
      const status = await handler(entry, 'copilot-status')(invocation())
      expect(status.text).toContain('Sign-in: authorized.')
    })
  })

  it('waits for the device notice when an earlier notice carries no page', async () => {
    const gate = Promise.withResolvers<undefined>()
    const entry = run(async (request) => {
      request.interaction.notify({ message: 'Contacting GitHub…' })
      await Promise.resolve()
      request.interaction.notify(DEVICE)
      await gate.promise
      return { status: 'authorized' }
    })
    const result = await handler(entry, 'copilot-login')(invocation())
    expect(result.text).toContain('ABCD-1234')
    gate.resolve(undefined)
  })

  it('answers a text prompt with the trimmed enterprise argument', async () => {
    let answered = 'unset'
    const entry = run(async (request) => {
      answered = await request.interaction.prompt({
        kind: 'text',
        message: 'GitHub Enterprise URL/domain (blank for github.com)',
        placeholder: 'company.ghe.com',
      })
      return { status: 'authorized' }
    })
    const warn = vi.spyOn(entry.ctx.logger, 'warn')
    const info = vi.spyOn(entry.ctx.logger, 'info')
    const result = await handler(entry, 'copilot-login')(invocation({ rawInput: '  company.ghe.com  ' }))
    expect(answered).toBe('company.ghe.com')
    expect(result.text).toContain('Signed in to GitHub Copilot')
    expect(result.text).not.toContain('company.ghe.com')
    const logged = [...info.mock.calls, ...warn.mock.calls].flat().join('\n')
    expect(logged).not.toContain('company.ghe.com')
  })

  it('answers a blank text prompt with an empty string for github.com', async () => {
    let answered = 'unset'
    const entry = run(async (request) => {
      answered = await request.interaction.prompt({ kind: 'text', message: 'GitHub Enterprise URL/domain (blank for github.com)' })
      return { status: 'authorized' }
    })
    await handler(entry, 'copilot-login')(invocation({ rawInput: '   ' }))
    expect(answered).toBe('')
  })

  it('answers a secret prompt with the same trimmed argument', async () => {
    let answered = 'unset'
    const entry = run(async (request) => {
      answered = await request.interaction.prompt({ kind: 'secret', message: 'Enterprise domain' })
      return { status: 'authorized' }
    })
    await handler(entry, 'copilot-login')(invocation({ rawInput: ' secret.ghe.com ' }))
    expect(answered).toBe('secret.ghe.com')
  })

  it('answers a select prompt when the argument matches an option id or label', async () => {
    let byId = 'unset'
    const matchedId = run(async (request) => {
      byId = await request.interaction.prompt(CHOICES)
      return { status: 'authorized' }
    })
    await handler(matchedId, 'copilot-login')(invocation({ rawInput: 'github.com' }))
    expect(byId).toBe('github.com')

    let byLabel = 'unset'
    const matchedLabel = run(async (request) => {
      byLabel = await request.interaction.prompt(CHOICES)
      return { status: 'authorized' }
    })
    await handler(matchedLabel, 'copilot-login')(invocation({ rawInput: 'company.ghe.com' }))
    expect(byLabel).toBe('ghe')
  })

  it('rejects a select prompt the argument does not name', async () => {
    const entry = run(async (request) => {
      await request.interaction.prompt(CHOICES)
      return { status: 'authorized' }
    })
    const result = await handler(entry, 'copilot-login')(invocation({ rawInput: 'elsewhere' }))
    expect(result.kind).toBe('error')
    expect(result.text).toContain('Pick a GitHub host')
    expect(result.text).toContain('github.com (GitHub.com)')
    expect(result.text).toContain('ghe (company.ghe.com)')
    expect(result.text).not.toContain('elsewhere')
  })

  it('reports a missing flow raised by begin', async () => {
    const entry = run(async () => { throw new AuthorizationError('no flow', 'NO_FLOW') })
    const result = await handler(entry, 'copilot-login')(invocation())
    expect(result.kind).toBe('error')
    expect(result.text).toContain('github-copilot provider is absent')
  })

  it('reports the other authorization failure codes', async () => {
    const method = run(async () => { throw new AuthorizationError('method', 'UNKNOWN_METHOD') })
    expect((await handler(method, 'copilot-login')(invocation())).text).toContain('no longer offers its OAuth method')
    const uncommitted = run(async () => { throw new AuthorizationError('commit', 'NOT_COMMITTED') })
    expect((await handler(uncommitted, 'copilot-login')(invocation())).text).toContain('without storing a credential')
  })

  it('renders a page without a code and a code without a page', async () => {
    const gate = Promise.withResolvers<undefined>()
    const urlOnly = run(async (request) => {
      request.interaction.notify({ message: 'Open the page', url: 'https://github.com/only-url' })
      await gate.promise
      return { status: 'authorized' }
    })
    const first = await handler(urlOnly, 'copilot-login')(invocation())
    expect(first.text).toContain('https://github.com/only-url')
    const firstStatus = await handler(urlOnly, 'copilot-status')(invocation())
    expect(firstStatus.text).toContain('https://github.com/only-url')
    expect(firstStatus.text).not.toContain('Code:')
    gate.resolve(undefined)
    const codeGate = Promise.withResolvers<undefined>()
    const codeOnly = run(async (request) => {
      request.interaction.notify({ message: 'Enter the code', code: 'ONLY-CODE' })
      await codeGate.promise
      return { status: 'authorized' }
    })
    const second = await handler(codeOnly, 'copilot-login')(invocation())
    expect(second.text).toContain('ONLY-CODE')
    const secondStatus = await handler(codeOnly, 'copilot-status')(invocation())
    expect(secondStatus.text).toContain('ONLY-CODE')
    expect(secondStatus.text).not.toContain('Open:')
    codeGate.resolve(undefined)
  })

  it('reports an attempt already started elsewhere', async () => {
    const entry = run(async () => { throw new AuthorizationError('busy', 'ALREADY_IN_FLIGHT') })
    const result = await handler(entry, 'copilot-login')(invocation())
    expect(result.text).toContain('Another GitHub Copilot sign-in is already running')
  })

  it('reports an unexpected authorization code and a plain error', async () => {
    const coded = run(async () => { throw new AuthorizationError('boom', 'SOMETHING_ELSE') })
    expect((await handler(coded, 'copilot-login')(invocation())).text).toContain('SOMETHING_ELSE')
    const plain = run(async () => { throw new Error('network down') })
    expect((await handler(plain, 'copilot-login')(invocation())).text).toContain('network down')
    // The plugin must stay diagnosable when a flow rejects with a non-Error value.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercising that path needs a string rejection
    const unknown = run(() => Promise.reject('offline'))
    expect((await handler(unknown, 'copilot-login')(invocation())).text).toContain('offline')
  })

  it('reports an immediate authorization and an immediate cancellation', async () => {
    const authorized = run(async () => ({ status: 'authorized' }))
    expect((await handler(authorized, 'copilot-login')(invocation())).text).toContain('Signed in to GitHub Copilot')
    const cancelled = run(async () => ({ status: 'cancelled' }))
    const cancelledResult = await handler(cancelled, 'copilot-login')(invocation())
    expect(cancelledResult.text).toContain('cancelled')
    const status = await handler(cancelled, 'copilot-status')(invocation())
    expect(status.text).toContain('Sign-in: cancelled.')
  })

  it('starts another sign-in after the previous one finished', async () => {
    const entry = run(async () => ({ status: 'authorized' }))
    await handler(entry, 'copilot-login')(invocation())
    await handler(entry, 'copilot-login')(invocation())
    expect(entry.begin).toHaveBeenCalledTimes(2)
  })

  it('cancels when the calling request is withdrawn', async () => {
    const entry = run(request => new Promise<AuthorizationOutcome>((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => { reject(new Error('withdrawn')) }, { once: true })
    }))
    const controller = new AbortController()
    const pending = handler(entry, 'copilot-login')(invocation({ signal: controller.signal }))
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    const result = await pending
    expect(result.text).toContain('cancelled')
    expect(entry.cancel).toHaveBeenCalledWith(KEY)
  })

  it('cancels an already-withdrawn request without waiting', async () => {
    const entry = run(async () => ({ status: 'authorized' }))
    const result = await handler(entry, 'copilot-login')(invocation({ signal: AbortSignal.abort() }))
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
    await handler(entry, 'copilot-login')(invocation())
    const second = await handler(entry, 'copilot-login')(invocation())
    expect(second.kind).toBe('error')
    expect(second.text).toContain('already running')
    expect(second.text).toContain('https://github.com/login/device')
    gate.resolve(undefined)
  })

  it('refuses a second sign-in before a page is available', async () => {
    const gate = Promise.withResolvers<undefined>()
    const entry = run(async () => {
      await gate.promise
      return { status: 'authorized' }
    })
    const controller = new AbortController()
    const first = handler(entry, 'copilot-login')(invocation({ signal: controller.signal }))
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = await handler(entry, 'copilot-login')(invocation())
    expect(second.text).toContain('already running')
    expect(second.text).not.toContain('Open:')
    const status = await handler(entry, 'copilot-status')(invocation())
    expect(status.text).toContain('Sign-in: signing-in.')
    expect(status.text).not.toContain('Open:')
    controller.abort()
    await first
    gate.resolve(undefined)
  })
})

describe('/copilot-status', () => {
  it('reports a missing credential and rejects arguments', async () => {
    const entry = run()
    expect((await handler(entry, 'copilot-status')(invocation())).text).toContain('Not signed in to GitHub Copilot.')
    expect((await handler(entry, 'copilot-status')(invocation({ rawInput: 'x' }))).text).toContain('Usage: /copilot-status')
  })

  it('reports a stored credential and the last failure', async () => {
    const entry = run(async () => { throw new Error('network down') })
    await handler(entry, 'copilot-login')(invocation())
    entry.info.configured = true
    entry.info.kind = 'grant'
    const status = await handler(entry, 'copilot-status')(invocation())
    expect(status.text).toContain('Signed in to GitHub Copilot.')
    expect(status.text).toContain('Sign-in: failed.')
    expect(status.text).toContain('network down')
    expect(entry.describeRecord).toHaveBeenCalledWith(KEY)
  })

  it('shows the pending page and code while a sign-in waits', async () => {
    const gate = Promise.withResolvers<undefined>()
    const entry = run(async (request) => {
      request.interaction.notify(DEVICE)
      await gate.promise
      return { status: 'authorized' }
    })
    await handler(entry, 'copilot-login')(invocation())
    const status = await handler(entry, 'copilot-status')(invocation())
    const text = status.text ?? ''
    const [firstLine] = text.split('\n')
    expect(firstLine).toContain('https://github.com/login/device')
    expect(firstLine).toContain('ABCD-1234')
    expect(text).toContain('Sign-in: signing-in.')
    gate.resolve(undefined)
  })
})

describe('/copilot-logout', () => {
  it('removes a stored credential', async () => {
    const entry = run()
    entry.info.configured = true
    entry.info.kind = 'grant'
    const result = await handler(entry, 'copilot-logout')(invocation())
    expect(result.text).toContain('Signed out of GitHub Copilot')
    expect(entry.deleteRecord).toHaveBeenCalledWith(KEY)
  })

  it('reports nothing to remove and rejects arguments', async () => {
    const entry = run()
    expect((await handler(entry, 'copilot-logout')(invocation())).text).toContain('nothing to remove')
    expect((await handler(entry, 'copilot-logout')(invocation({ rawInput: 'x' }))).text).toContain('Usage: /copilot-logout')
    expect(entry.deleteRecord).not.toHaveBeenCalled()
  })

  it('withdraws a running sign-in before deleting', async () => {
    const gate = Promise.withResolvers<undefined>()
    const entry = run(async (request) => {
      request.interaction.notify(DEVICE)
      await gate.promise
      return { status: 'cancelled' }
    })
    await handler(entry, 'copilot-login')(invocation())
    entry.info.configured = true
    const result = await handler(entry, 'copilot-logout')(invocation())
    expect(result.text).toContain('Signed out of GitHub Copilot')
    expect(entry.cancel).toHaveBeenCalledWith(KEY)
    gate.resolve(undefined)
  })
})

describe('/copilot-cancel', () => {
  it('withdraws a running sign-in', async () => {
    const gate = Promise.withResolvers<undefined>()
    let signal: AbortSignal | undefined
    const entry = run(async (request) => {
      signal = request.signal
      request.interaction.notify(DEVICE)
      await gate.promise
      return { status: 'cancelled' }
    })
    await handler(entry, 'copilot-login')(invocation())
    const result = await handler(entry, 'copilot-cancel')(invocation())
    expect(result.text).toContain('Cancelling the GitHub Copilot sign-in.')
    expect(entry.cancel).toHaveBeenCalledWith(KEY)
    expect(signal?.aborted).toBe(true)
    gate.resolve(undefined)
  })

  it('reports no running sign-in and rejects arguments', async () => {
    const entry = run()
    expect((await handler(entry, 'copilot-cancel')(invocation())).text).toContain('No GitHub Copilot sign-in is running.')
    expect((await handler(entry, 'copilot-cancel')(invocation({ rawInput: 'x' }))).text).toContain('Usage: /copilot-cancel')
  })

  it('treats a finished sign-in as not running', async () => {
    const entry = run(async () => ({ status: 'authorized' }))
    await handler(entry, 'copilot-login')(invocation())
    expect((await handler(entry, 'copilot-cancel')(invocation())).text).toContain('No GitHub Copilot sign-in is running.')
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
    await handler(entry, 'copilot-login')(invocation())
    await entry.ctx.fiber.dispose()
    expect(signal?.aborted).toBe(true)
    expect(entry.cancel).toHaveBeenCalledWith(KEY)
    expect(entry.commands.size).toBe(0)
    gate.resolve(undefined)
  })

  it('cancels authorization on disposal when nothing is running', async () => {
    const entry = run()
    await entry.ctx.fiber.dispose()
    expect(entry.cancel).toHaveBeenCalledWith(KEY)
    expect(entry.commands.size).toBe(0)
  })
})
