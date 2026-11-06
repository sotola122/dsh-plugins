/** The Remote read over a fake GitHub API: normalized quota, isolated failures, bounded time, and no secret in any output. */

import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCopilotUsage, resolveCopilotEndpoint } from '../src/copilot.ts'
import ProviderUsageService from '../src/index.ts'
import type { UsageReport } from '../src/types.ts'

const TOKEN = 'gho_fixture_secret_token'
const GRANT: CredentialRecord = { kind: 'grant', payload: { type: 'oauth', refresh: TOKEN, access: 'copilot-proxy-token', expires: 0 } }

/** The response fields this plugin reads, as a fixed fixture. */
const QUOTA = {
  login: 'fixture-account',
  copilot_plan: 'individual_pro',
  quota_reset_date: '2026-12-01T00:00:00.000Z',
  quota_snapshots: {
    premium_interactions: { entitlement: 300, remaining: 120.5, percent_remaining: 40.2, unlimited: false },
    chat: { unlimited: true },
  },
}

const servers: Server[] = []
const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(closeServer))
})

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  return new Promise((resolve) => { server.close(() => { resolve() }) })
}

/** Start a fake API on an ephemeral loopback port; the spec's teardown closes it. */
async function fakeApi(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const requests: IncomingMessage[] = []
  const server = createServer((request, response) => {
    requests.push(request)
    handler(request, response)
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { requests, endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/copilot_internal/user` }
}

function respondJson(status: number, body: unknown) {
  return (_request: IncomingMessage, response: ServerResponse): void => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
}

function service(options: {
  endpoint?: string
  enabled?: boolean
  timeoutMs?: number
  readRecord?: () => Promise<CredentialRecord | undefined>
} = {}) {
  const ctx = new Context()
  roots.push(ctx)
  const readRecord = vi.fn(options.readRecord ?? (() => Promise.resolve<CredentialRecord | undefined>(GRANT)))
  ctx.provide('credentials', { readRecord } as never)
  const warn = vi.spyOn(ctx.logger, 'warn')
  const usage = new ProviderUsageService(ctx, ProviderUsageService.Config({
    ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    copilot: {
      ...options.enabled === undefined ? {} : { enabled: options.enabled },
      ...options.endpoint === undefined ? {} : { endpoint: options.endpoint },
    },
  }))
  return { usage, readRecord, warn }
}

const read = (usage: ProviderUsageService, signal = new AbortController().signal): Promise<UsageReport> => usage.report(signal)
const copilotRow = (report: UsageReport) => report.providers.find(row => row.provider === 'github-copilot')

describe('providerUsage report', () => {
  it('normalizes Copilot quota and authorizes with the GitHub token from the grant', async () => {
    const api = await fakeApi(respondJson(200, QUOTA))
    const { usage, warn } = service({ endpoint: api.endpoint })
    const report = await read(usage)
    expect(report.providers).toEqual([
      {
        provider: 'github-copilot',
        status: 'ok',
        plan: 'individual_pro',
        resetAt: Date.parse('2026-12-01T00:00:00.000Z'),
        meters: [
          { id: 'premium_interactions', unlimited: false, entitlement: 300, remaining: 120.5, percentRemaining: 40.2 },
          { id: 'chat', unlimited: true },
        ],
      },
      { provider: 'openai-codex', status: 'unsupported', reason: 'no-usage-endpoint' },
      { provider: 'xai', status: 'unsupported', reason: 'no-usage-endpoint' },
      { provider: 'opencode-go', status: 'unsupported', reason: 'no-usage-endpoint' },
    ])
    expect(api.requests).toHaveLength(1)
    expect(api.requests[0]?.url).toBe('/copilot_internal/user')
    expect(api.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(warn).not.toHaveBeenCalled()
  })

  it('never carries an account identifier from the response into the row', async () => {
    const api = await fakeApi(respondJson(200, QUOTA))
    const { usage } = service({ endpoint: api.endpoint })
    expect(JSON.stringify(await read(usage))).not.toContain('fixture-account')
  })

  it('sends no request and reads no credential while Copilot is turned off', async () => {
    const api = await fakeApi(respondJson(200, QUOTA))
    const { usage, readRecord } = service({ endpoint: api.endpoint, enabled: false })
    expect(copilotRow(await read(usage))).toEqual({ provider: 'github-copilot', status: 'unsupported', reason: 'disabled' })
    expect(readRecord).not.toHaveBeenCalled()
    expect(api.requests).toHaveLength(0)
  })

  it.each<[string, CredentialRecord | undefined, string]>([
    ['no record', undefined, 'not-signed-in'],
    ['an API-key record', { kind: 'api-key', key: TOKEN }, 'not-signed-in'],
    ['a grant without a token', { kind: 'grant', payload: { type: 'oauth' } }, 'credential-unusable'],
    ['a grant with an empty token', { kind: 'grant', payload: { refresh: '' } }, 'credential-unusable'],
    ['a grant that is not an object', { kind: 'grant', payload: [TOKEN] }, 'credential-unusable'],
    ['an enterprise value that is not a hostname', { kind: 'grant', payload: { refresh: TOKEN, enterpriseUrl: 'evil.example/path?x=' } }, 'credential-unusable'],
    ['an enterprise value that is not text', { kind: 'grant', payload: { refresh: TOKEN, enterpriseUrl: 7 } }, 'credential-unusable'],
  ])('sends no request for %s', async (_name, record, reason) => {
    const api = await fakeApi(respondJson(200, QUOTA))
    const { usage } = service({ endpoint: api.endpoint, readRecord: () => Promise.resolve(record) })
    expect(copilotRow(await read(usage))).toEqual({ provider: 'github-copilot', status: 'failed', reason })
    expect(api.requests).toHaveLength(0)
  })

  it('accepts a github.com grant that stored its enterprise value as null', async () => {
    const api = await fakeApi(respondJson(200, QUOTA))
    const { usage } = service({
      endpoint: api.endpoint,
      readRecord: () => Promise.resolve({ kind: 'grant', payload: { refresh: TOKEN, enterpriseUrl: null } }),
    })
    expect(copilotRow(await read(usage))).toMatchObject({ status: 'ok' })
  })

  it('reads an enterprise grant through the configured endpoint', async () => {
    const api = await fakeApi(respondJson(200, QUOTA))
    const { usage } = service({
      endpoint: api.endpoint,
      readRecord: () => Promise.resolve({ kind: 'grant', payload: { refresh: TOKEN, enterpriseUrl: 'corp.ghe.com' } }),
    })
    expect(copilotRow(await read(usage))).toMatchObject({ status: 'ok' })
    expect(api.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it.each([
    [401, { reason: 'unauthorized' }],
    [403, { reason: 'unauthorized' }],
    [429, { reason: 'rate-limited' }],
    [500, { reason: 'http-error', httpStatus: 500 }],
    [404, { reason: 'http-error', httpStatus: 404 }],
  ])('reports HTTP %i as its own failure and keeps every other row', async (status, expected) => {
    const api = await fakeApi(respondJson(status, { message: 'refused' }))
    const { usage } = service({ endpoint: api.endpoint })
    const report = await read(usage)
    expect(copilotRow(report)).toEqual({ provider: 'github-copilot', status: 'failed', ...expected })
    expect(report.providers.filter(row => row.status === 'unsupported')).toHaveLength(3)
  })

  it.each([
    ['text that is not JSON', (_request: IncomingMessage, response: ServerResponse) => { response.end('<html>') }],
    ['JSON without a usage field', respondJson(200, { login: 'fixture-account' })],
  ])('reports %s as an invalid response', async (_name, handler) => {
    const api = await fakeApi(handler)
    const { usage } = service({ endpoint: api.endpoint })
    expect(copilotRow(await read(usage))).toEqual({ provider: 'github-copilot', status: 'failed', reason: 'invalid-response' })
  })

  it('stops at the configured time limit when the provider never answers', async () => {
    const api = await fakeApi(() => { /* Hold the response open; teardown closes the connection. */ })
    const { usage } = service({ endpoint: api.endpoint, timeoutMs: 20 })
    expect(copilotRow(await read(usage))).toEqual({ provider: 'github-copilot', status: 'failed', reason: 'timeout' })
  })

  it('stops at the time limit when the response body stalls', async () => {
    const api = await fakeApi((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{')
    })
    const { usage } = service({ endpoint: api.endpoint, timeoutMs: 50 })
    expect(copilotRow(await read(usage))).toEqual({ provider: 'github-copilot', status: 'failed', reason: 'timeout' })
  })

  it('reports an unreachable provider as a network failure', async () => {
    const api = await fakeApi(respondJson(200, QUOTA))
    await Promise.all(servers.splice(0).map(closeServer))
    const { usage } = service({ endpoint: api.endpoint })
    expect(copilotRow(await read(usage))).toEqual({ provider: 'github-copilot', status: 'failed', reason: 'network' })
  })

  it('refuses a redirect, so the token never reaches its target', async () => {
    const target = await fakeApi(respondJson(200, QUOTA))
    const api = await fakeApi((_request, response) => {
      response.writeHead(302, { location: target.endpoint })
      response.end()
    })
    const { usage } = service({ endpoint: api.endpoint })
    expect(copilotRow(await read(usage))).toEqual({ provider: 'github-copilot', status: 'failed', reason: 'network' })
    expect(target.requests).toHaveLength(0)
  })

  it('rejects with the caller cancellation instead of reporting a failure', async () => {
    const api = await fakeApi(() => { /* Hold the response open until the caller cancels. */ })
    const { usage, warn } = service({ endpoint: api.endpoint })
    const caller = new AbortController()
    const reason = new Error('page closed')
    const pending = read(usage, caller.signal)
    await vi.waitFor(() => { expect(api.requests).toHaveLength(1) })
    caller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(warn).not.toHaveBeenCalled()
  })

  it('rejects with the caller cancellation while the credential read is pending', async () => {
    const pendingRecord = Promise.withResolvers<CredentialRecord | undefined>()
    const api = await fakeApi(respondJson(200, QUOTA))
    const { usage } = service({ endpoint: api.endpoint, readRecord: () => pendingRecord.promise })
    const caller = new AbortController()
    const pending = read(usage, caller.signal)
    caller.abort(new Error('page closed'))
    pendingRecord.resolve(GRANT)
    await expect(pending).rejects.toThrow('page closed')
    expect(api.requests).toHaveLength(0)
  })

  it('rejects with the caller cancellation when the credential read fails after it', async () => {
    const pendingRecord = Promise.withResolvers<CredentialRecord | undefined>()
    const { usage } = service({ readRecord: () => pendingRecord.promise })
    const caller = new AbortController()
    const pending = read(usage, caller.signal)
    caller.abort(new Error('page closed'))
    pendingRecord.reject(new Error('store unavailable'))
    await expect(pending).rejects.toThrow('page closed')
  })

  it('keeps secrets out of every row and log line when the provider and the store quote them', async () => {
    const api = await fakeApi(respondJson(500, { echoed: TOKEN }))
    const quoted = service({ endpoint: api.endpoint })
    const failing = service({ readRecord: () => Promise.reject(new Error(`cannot decrypt ${TOKEN}`)) })
    const reports = [await read(quoted.usage), await read(failing.usage)]
    expect(copilotRow(reports[1] as UsageReport)).toEqual({ provider: 'github-copilot', status: 'failed', reason: 'credential-unusable' })
    const output = JSON.stringify([reports, quoted.warn.mock.calls, failing.warn.mock.calls])
    expect(output).not.toContain(TOKEN)
    expect(quoted.warn).toHaveBeenCalledWith('ui-settings-usage: github-copilot usage read failed (http-error)')
    expect(failing.warn).toHaveBeenCalledWith('ui-settings-usage: github-copilot usage read failed (credential-unusable)')
  })
})

describe('resolveCopilotEndpoint', () => {
  it('prefers the override, then the enterprise API host, then github.com', () => {
    expect(resolveCopilotEndpoint('https://proxy.test/quota', 'corp.ghe.com')).toBe('https://proxy.test/quota')
    expect(resolveCopilotEndpoint(undefined, 'corp.ghe.com')).toBe('https://api.corp.ghe.com/copilot_internal/user')
    expect(resolveCopilotEndpoint(undefined, undefined)).toBe('https://api.github.com/copilot_internal/user')
  })
})

describe('parseCopilotUsage', () => {
  it.each([[null], ['text'], [[]], [{}], [{ quota_snapshots: 'none' }], [{ copilot_plan: '' }], [{ quota_snapshots: { chat: 'x' } }]])(
    'finds no usage in %j',
    (body) => { expect(parseCopilotUsage(body)).toBeUndefined() },
  )

  it('keeps a plan with no quota and drops a reset date it cannot read', () => {
    expect(parseCopilotUsage({ copilot_plan: 'free', quota_reset_date: 'soon' })).toEqual({ plan: 'free', meters: [] })
  })

  it('keeps only the numbers the provider reported as finite', () => {
    expect(parseCopilotUsage({ quota_snapshots: { chat: { entitlement: '300', remaining: null, percent_remaining: Number.NaN } } }))
      .toEqual({ meters: [{ id: 'chat', unlimited: false }] })
  })

  it('bounds how many quotas and characters one row retains', () => {
    const snapshots = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`${String(index)}${'x'.repeat(80)}`, { remaining: index }]))
    const usage = parseCopilotUsage({ copilot_plan: 'p'.repeat(80), quota_snapshots: snapshots })
    expect(usage?.meters).toHaveLength(16)
    expect(usage?.meters[0]?.id).toHaveLength(64)
    expect(usage?.plan).toHaveLength(64)
  })
})

describe('Config', () => {
  it('applies working defaults to an empty row', () => {
    expect(ProviderUsageService.Config({})).toEqual({ timeoutMs: 10_000, copilot: { enabled: true } })
  })

  it.each([
    'https://api.github.com/copilot_internal/user',
    'https://ghe.corp.test:8443/api',
    'http://127.0.0.1:3000/quota',
    'http://localhost/quota',
    'http://[::1]:3000/quota',
  ])('accepts the endpoint %s', (endpoint) => {
    expect(ProviderUsageService.Config({ copilot: { endpoint } }).copilot.endpoint).toBe(endpoint)
  })

  it.each([
    'http://api.github.com/copilot_internal/user',
    'http://localhost.evil.test/quota',
    'ftp://api.github.com/quota',
    'api.github.com/quota',
    'https://api.github.com/quota?token=x',
    'https://api.github.com/a b',
    '',
  ])('fails loud on the endpoint %j', (endpoint) => {
    expect(() => ProviderUsageService.Config({ copilot: { endpoint } })).toThrow()
  })

  it.each([0, -1, 1.5, 120_001])('fails loud on the time limit %d', (timeoutMs) => {
    expect(() => ProviderUsageService.Config({ timeoutMs })).toThrow()
  })

  it.each([1, 120_000])('accepts the time limit %d', (timeoutMs) => {
    expect(ProviderUsageService.Config({ timeoutMs }).timeoutMs).toBe(timeoutMs)
  })
})

describe('bundle manifest', () => {
  const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

  it('selects the row through the bare package name its client half attaches to', () => {
    expect(read('cordis.patch.yml')).toContain("name: '@anago-harness/ui-settings-usage'")
    const manifest = JSON.parse(read('package.json')) as { name: string; dsh: { bundle: { patch: string } } }
    expect(manifest.name).toBe('@anago-harness/ui-settings-usage')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
  })
})
