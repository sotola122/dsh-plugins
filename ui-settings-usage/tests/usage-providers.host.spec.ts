/**
 * The Remote read of OpenAI Codex, xAI, and OpenCode Go over fake APIs: normalized
 * usage, token renewal, sign-in states, isolated failures, retained reads, and a
 * composition over the real credential and authorization services.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AuthorizationRenewal } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCodexUsage } from '../src/codex.ts'
import ProviderUsageService from '../src/index.ts'
import { parseOpenCodeGoUsage } from '../src/opencode-go.ts'
import { amount, boundedText, instant } from '../src/read.ts'
import type { ProviderUsage, UsageProviderId, UsageReport } from '../src/types.ts'
import { parseXaiUsage } from '../src/xai.ts'
import { closeFakeApis, fakeApi, forbidExternalNetwork, respondJson } from './support.ts'

const CODEX_KEY = credentialKey('llm-pi-ai', 'openai-codex')
const XAI_KEY = credentialKey('llm-pi-ai', 'xai')
const OPENCODE_KEY = credentialKey('llm-pi-ai', 'opencode-go')
const HOUR = 3_600_000
const SECRET = 'fixture-secret-token'
const RESET = '2026-12-01T00:00:00.000Z'
const RESET_MS = Date.parse(RESET)

/** The fields of a real `wham/usage` response, values replaced. */
const CODEX_USAGE = {
  user_id: 'fixture-user',
  account_id: 'fixture-account',
  email: 'fixture@example.invalid',
  plan_type: 'plus',
  rate_limit: null,
  code_review_rate_limit: null,
  additional_rate_limits: null,
  model_usage: { 'fixture-model': { available: true, available_at: null, credits_would_enable: false } },
  credits: { has_credits: true, unlimited: false, overage_limit_reached: false, balance: '12.5', approx_local_messages: [1, 2], approx_cloud_messages: [1, 2] },
  spend_control: {
    reached: false,
    individual_limit: {
      source: 'fixture', unit: 'usd', limit: 50, used: 12, remaining: 38, used_percent: 24, remaining_percent: 76, reset_after_seconds: 3600, reset_at: RESET,
    },
  },
  rate_limit_reached_type: null,
  promo: null,
}

/** The fields of a real `zen/go/v1/usage` response, values replaced. */
const OPENCODE_USAGE = {
  usage: {
    rolling: { status: 'ok', percent: 12, resetsAt: RESET },
    weekly: { status: 'ok', percent: 34, resetsAt: RESET },
    monthly: { status: 'ok', percent: 56, resetsAt: RESET },
  },
}

/** The `billing?format=credits` fields a third-party client documents, values replaced. */
const XAI_USAGE = {
  config: {
    creditUsagePercent: 42.5,
    currentPeriod: { periodType: 'USAGE_PERIOD_TYPE_WEEKLY', end: RESET },
    billingPeriodEnd: '2020-01-01T00:00:00Z',
    onDemandCap: { val: 5000 },
    onDemandUsed: { val: 1840 },
    prepaidBalance: {},
    topUpMethod: 'fixture',
  },
}

const CODEX_ROW = {
  provider: 'openai-codex',
  status: 'ok',
  plan: 'plus',
  meters: [
    { id: 'spend_limit', unlimited: false, entitlement: 50, used: 12, remaining: 38, percentUsed: 24, percentRemaining: 76, unit: 'usd', resetAt: RESET_MS },
    { id: 'credits', unlimited: false, remaining: 12.5 },
  ],
}

const codexGrant = (access = SECRET, expires = Date.now() + HOUR): CredentialRecord => ({
  kind: 'grant', payload: { type: 'oauth', access, refresh: 'fixture-refresh', expires, accountId: 'fixture-account' },
})
const xaiGrant = (access = SECRET, expires = Date.now() + HOUR): CredentialRecord => ({
  kind: 'grant', payload: { type: 'oauth', access, refresh: 'fixture-refresh', expires },
})

const roots: Context[] = []
const dirs: string[] = []

forbidExternalNetwork()

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  await closeFakeApis()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** Raw config for the row, validated by the plugin's own schema. */
type RowConfig = Record<string, unknown>

interface Bench {
  /** Stored records by key. */
  records?: ReadonlyMap<CredentialKey, CredentialRecord>
  /** Stored references by name. */
  refs?: Readonly<Record<string, string>>
  /** The authorization service's renewal; absent mounts no authorization service. */
  renew?: (key: CredentialKey, signal: AbortSignal) => Promise<AuthorizationRenewal>
  /** Config for the row; a provider left out here is turned off. */
  config?: RowConfig
}

/** A service over stand-in stores, with only the providers named in `config` turned on. */
function service(bench: Bench = {}) {
  const ctx = new Context()
  roots.push(ctx)
  const records = new Map(bench.records)
  const readRecord = vi.fn((key: CredentialKey) => Promise.resolve(records.get(key)))
  const resolve = vi.fn((ref: string) => {
    const value = bench.refs?.[ref]
    return Promise.resolve(value === undefined ? undefined : { value, source: 'stored' })
  })
  ctx.provide('credentials', { readRecord, resolve } as never)
  const renew = bench.renew === undefined ? undefined : vi.fn(bench.renew)
  if (renew !== undefined) ctx.provide('authorization', { renew } as never)
  const warn = vi.spyOn(ctx.logger, 'warn')
  const off = { enabled: false }
  const raw: RowConfig = { copilot: off, openaiCodex: off, xai: off, opencodeGo: off, minRefreshIntervalMs: 0, ...bench.config }
  const usage = new ProviderUsageService(ctx, ProviderUsageService.Config(raw as never))
  return { ctx, usage, records, readRecord, resolve, renew, warn }
}

const read = (usage: ProviderUsageService, signal = new AbortController().signal): Promise<UsageReport> => usage.report(signal)
const rowOf = (report: UsageReport, provider: UsageProviderId): ProviderUsage | undefined => report.providers.find(row => row.provider === provider)

describe('OpenAI Codex usage', () => {
  it('normalizes the plan, spend limit, and credits, with the token and account in the headers', async () => {
    const api = await fakeApi(respondJson(200, CODEX_USAGE))
    const { usage, warn } = service({ records: new Map([[CODEX_KEY, codexGrant()]]), config: { openaiCodex: { endpoint: api.endpoint } } })
    expect(rowOf(await read(usage), 'openai-codex')).toEqual(CODEX_ROW)
    expect(api.requests[0]?.headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(api.requests[0]?.headers['chatgpt-account-id']).toBe('fixture-account')
    expect(warn).not.toHaveBeenCalled()
  })

  it('carries no account identifier from the response into the row', async () => {
    const api = await fakeApi(respondJson(200, CODEX_USAGE))
    const { usage } = service({ records: new Map([[CODEX_KEY, codexGrant()]]), config: { openaiCodex: { endpoint: api.endpoint } } })
    const text = JSON.stringify(await read(usage))
    for (const value of ['fixture-user', 'fixture-account', 'fixture@example.invalid', 'fixture-model']) expect(text).not.toContain(value)
  })

  it('asks for a sign-in without sending anything when no grant is stored', async () => {
    const api = await fakeApi(respondJson(200, CODEX_USAGE))
    const { usage } = service({ config: { openaiCodex: { endpoint: api.endpoint } } })
    expect(rowOf(await read(usage), 'openai-codex')).toEqual({ provider: 'openai-codex', status: 'sign-in-required', reason: 'not-signed-in' })
    expect(api.requests).toHaveLength(0)
  })

  it.each<[string, unknown]>([
    ['a payload that is not an object', ['token']],
    ['a grant without an access token', { expires: Date.now() + HOUR, accountId: 'a' }],
    ['a grant with an empty access token', { access: '', expires: Date.now() + HOUR, accountId: 'a' }],
    ['a grant without an expiry', { access: SECRET, accountId: 'a' }],
    ['a grant without an account', { access: SECRET, expires: Date.now() + HOUR }],
    ['a grant with an empty account', { access: SECRET, expires: Date.now() + HOUR, accountId: '' }],
  ])('sends nothing for %s', async (_name, payload) => {
    const api = await fakeApi(respondJson(200, CODEX_USAGE))
    const { usage } = service({ records: new Map([[CODEX_KEY, { kind: 'grant', payload }]]), config: { openaiCodex: { endpoint: api.endpoint } } })
    expect(rowOf(await read(usage), 'openai-codex')).toEqual({ provider: 'openai-codex', status: 'failed', reason: 'credential-unusable' })
    expect(api.requests).toHaveLength(0)
  })

  it('reports a store failure by its code alone', async () => {
    const { usage, readRecord, warn } = service({ config: { openaiCodex: { enabled: true } } })
    readRecord.mockRejectedValueOnce(new Error(`cannot decrypt ${SECRET}`))
    const report = await read(usage)
    expect(rowOf(report, 'openai-codex')).toEqual({ provider: 'openai-codex', status: 'failed', reason: 'credential-unusable' })
    expect(JSON.stringify([report, warn.mock.calls])).not.toContain(SECRET)
  })
})

describe('token renewal', () => {
  it('reads with the token the owning flow renewed, asking it about the same record', async () => {
    const api = await fakeApi(respondJson(200, CODEX_USAGE))
    const bench = service({
      records: new Map([[CODEX_KEY, codexGrant('expired-token', Date.now() - HOUR)]]),
      config: { openaiCodex: { endpoint: api.endpoint } },
      renew: (key) => {
        bench.records.set(key, codexGrant('renewed-token'))
        return Promise.resolve('current')
      },
    })
    expect(rowOf(await read(bench.usage), 'openai-codex')).toMatchObject({ status: 'ok' })
    expect(bench.renew).toHaveBeenCalledWith(CODEX_KEY, expect.any(AbortSignal))
    expect(api.requests[0]?.headers.authorization).toBe('Bearer renewed-token')
  })

  it('renews the xAI record through the same path', async () => {
    const api = await fakeApi(respondJson(200, XAI_USAGE))
    const bench = service({
      records: new Map([[XAI_KEY, xaiGrant('expired-token', Date.now() - HOUR)]]),
      config: { xai: { endpoint: api.endpoint } },
      renew: (key) => {
        bench.records.set(key, xaiGrant('renewed-token'))
        return Promise.resolve('current')
      },
    })
    expect(rowOf(await read(bench.usage), 'xai')).toMatchObject({ status: 'ok' })
    expect(bench.renew).toHaveBeenCalledWith(XAI_KEY, expect.any(AbortSignal))
    expect(api.requests[0]?.headers.authorization).toBe('Bearer renewed-token')
  })

  it('reports a failed renewal of an expired token by its code alone, and sends nothing', async () => {
    const api = await fakeApi(respondJson(200, CODEX_USAGE))
    const { usage, warn } = service({
      records: new Map([[CODEX_KEY, codexGrant(SECRET, Date.now() - HOUR)]]),
      config: { openaiCodex: { endpoint: api.endpoint } },
      renew: () => Promise.reject(new Error(`invalid_grant ${SECRET}`)),
    })
    const report = await read(usage)
    expect(rowOf(report, 'openai-codex')).toEqual({ provider: 'openai-codex', status: 'sign-in-required', reason: 'renewal-failed' })
    expect(api.requests).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith('ui-settings-usage: openai-codex usage read failed (renewal-failed)')
    expect(JSON.stringify([report, warn.mock.calls])).not.toContain(SECRET)
  })

  it('keeps using a token that has not expired when its early renewal fails', async () => {
    const api = await fakeApi(respondJson(200, CODEX_USAGE))
    const { usage } = service({
      records: new Map([[CODEX_KEY, codexGrant(SECRET, Date.now() + 60_000)]]),
      config: { openaiCodex: { endpoint: api.endpoint } },
      renew: () => Promise.reject(new Error('issuer unavailable')),
    })
    expect(rowOf(await read(usage), 'openai-codex')).toMatchObject({ status: 'ok' })
    expect(api.requests[0]?.headers.authorization).toBe(`Bearer ${SECRET}`)
  })

  it('asks for a sign-in when no authorization service can renew an expired token', async () => {
    const api = await fakeApi(respondJson(200, CODEX_USAGE))
    const { usage } = service({
      records: new Map([[CODEX_KEY, codexGrant(SECRET, Date.now() - HOUR)]]),
      config: { openaiCodex: { endpoint: api.endpoint } },
    })
    expect(rowOf(await read(usage), 'openai-codex')).toEqual({ provider: 'openai-codex', status: 'sign-in-required', reason: 'token-expired' })
    expect(api.requests).toHaveLength(0)
  })

  it('asks for a sign-in when no flow offers a renewal for an expired token', async () => {
    const { usage } = service({
      records: new Map([[XAI_KEY, xaiGrant(SECRET, Date.now() - HOUR)]]),
      config: { xai: { enabled: true } },
      renew: () => Promise.resolve('unavailable'),
    })
    expect(rowOf(await read(usage), 'xai')).toEqual({ provider: 'xai', status: 'sign-in-required', reason: 'token-expired' })
  })

  it('still uses an unexpired token when no flow offers a renewal', async () => {
    const api = await fakeApi(respondJson(200, CODEX_USAGE))
    const { usage } = service({
      records: new Map([[CODEX_KEY, codexGrant()]]),
      config: { openaiCodex: { endpoint: api.endpoint } },
      renew: () => Promise.resolve('unavailable'),
    })
    expect(rowOf(await read(usage), 'openai-codex')).toMatchObject({ status: 'ok' })
  })

  it('asks for a sign-in when a renewal leaves the token expired', async () => {
    const { usage } = service({
      records: new Map([[CODEX_KEY, codexGrant(SECRET, Date.now() - HOUR)]]),
      config: { openaiCodex: { enabled: true } },
      renew: () => Promise.resolve('current'),
    })
    expect(rowOf(await read(usage), 'openai-codex')).toEqual({ provider: 'openai-codex', status: 'sign-in-required', reason: 'token-expired' })
  })

  it('reports a record removed during the renewal as not signed in', async () => {
    const bench = service({
      records: new Map([[CODEX_KEY, codexGrant(SECRET, Date.now() - HOUR)]]),
      config: { openaiCodex: { enabled: true } },
      renew: (key) => {
        bench.records.delete(key)
        return Promise.resolve('current')
      },
    })
    expect(rowOf(await read(bench.usage), 'openai-codex')).toEqual({ provider: 'openai-codex', status: 'sign-in-required', reason: 'not-signed-in' })
  })

  it('counts the renewal against the time limit and reports it as a timeout', async () => {
    const { usage } = service({
      records: new Map([[CODEX_KEY, codexGrant(SECRET, Date.now() - HOUR)]]),
      config: { openaiCodex: { enabled: true }, timeoutMs: 20 },
      renew: (_key, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
      }),
    })
    expect(rowOf(await read(usage), 'openai-codex')).toEqual({ provider: 'openai-codex', status: 'failed', reason: 'timeout' })
  })

  it('reports a timeout when a renewal ignores the signal', async () => {
    const { usage } = service({
      records: new Map([[CODEX_KEY, codexGrant(SECRET, Date.now() - HOUR)]]),
      config: { openaiCodex: { enabled: true }, timeoutMs: 20 },
      renew: () => new Promise(() => { /* The flow never settles. */ }),
    })
    expect(rowOf(await read(usage), 'openai-codex')).toEqual({ provider: 'openai-codex', status: 'failed', reason: 'timeout' })
  })
})

describe('xAI usage', () => {
  it('normalizes included, on-demand, and prepaid credits, requesting the credits format', async () => {
    const api = await fakeApi(respondJson(200, XAI_USAGE))
    const { usage } = service({ records: new Map([[XAI_KEY, xaiGrant()]]), config: { xai: { endpoint: api.endpoint } } })
    expect(rowOf(await read(usage), 'xai')).toEqual({
      provider: 'xai',
      status: 'ok',
      meters: [
        { id: 'included_credits', unlimited: false, percentUsed: 42.5, resetAt: RESET_MS },
        { id: 'on_demand', unlimited: false, unit: 'USD', entitlement: 50, used: 18.4 },
        { id: 'prepaid_credits', unlimited: false, unit: 'USD', remaining: 0 },
      ],
    })
    expect(api.requests[0]?.url).toBe('/usage?format=credits')
    expect(api.requests[0]?.headers.authorization).toBe(`Bearer ${SECRET}`)
  })

  it('falls back to the legacy period end when the current period is absent', () => {
    expect(parseXaiUsage({ config: { creditUsagePercent: 1, billingPeriodEnd: RESET } })?.meters)
      .toEqual([{ id: 'included_credits', unlimited: false, percentUsed: 1, resetAt: RESET_MS }])
  })

  it('leaves out a money object whose amount cannot be read', () => {
    expect(parseXaiUsage({ config: { prepaidBalance: { val: 'n/a' }, onDemandCap: { val: '1000' } } })?.meters)
      .toEqual([{ id: 'on_demand', unlimited: false, unit: 'USD', entitlement: 10 }])
  })

  it.each([[null], ['text'], [{}], [{ config: 'none' }], [{ config: {} }], [{ config: { currentPeriod: { end: RESET } } }], [{ error: 'refused' }]])(
    'finds no usage in %j',
    (body) => { expect(parseXaiUsage(body)).toBeUndefined() },
  )
})

describe('OpenCode Go usage', () => {
  it('normalizes all three windows and authorizes with the first stored reference', async () => {
    const api = await fakeApi(respondJson(200, OPENCODE_USAGE))
    const { usage, readRecord } = service({
      refs: { OPENCODE_GO_API_KEY: SECRET, OPENCODE_API_KEY: 'unused' },
      config: { opencodeGo: { endpoint: api.endpoint } },
    })
    expect(rowOf(await read(usage), 'opencode-go')).toEqual({
      provider: 'opencode-go',
      status: 'ok',
      meters: [
        { id: 'rolling', unlimited: false, percentUsed: 12, resetAt: RESET_MS },
        { id: 'weekly', unlimited: false, percentUsed: 34, resetAt: RESET_MS },
        { id: 'monthly', unlimited: false, percentUsed: 56, resetAt: RESET_MS },
      ],
    })
    expect(api.requests[0]?.headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(readRecord).not.toHaveBeenCalled()
  })

  it('falls through the references, then to the key record', async () => {
    const api = await fakeApi(respondJson(200, OPENCODE_USAGE))
    const second = service({ refs: { OPENCODE_API_KEY: 'second-key' }, config: { opencodeGo: { endpoint: api.endpoint } } })
    await read(second.usage)
    expect(api.requests.at(-1)?.headers.authorization).toBe('Bearer second-key')
    const record = service({ records: new Map([[OPENCODE_KEY, { kind: 'api-key', key: 'record-key' }]]), config: { opencodeGo: { endpoint: api.endpoint } } })
    await read(record.usage)
    expect(api.requests.at(-1)?.headers.authorization).toBe('Bearer record-key')
  })

  it('reads only the references the profile names', async () => {
    const api = await fakeApi(respondJson(200, OPENCODE_USAGE))
    const { usage, resolve } = service({ refs: { CUSTOM_KEY: SECRET }, config: { opencodeGo: { endpoint: api.endpoint, apiKeyEnvs: ['CUSTOM_KEY'] } } })
    expect(rowOf(await read(usage), 'opencode-go')).toMatchObject({ status: 'ok' })
    expect(resolve.mock.calls).toEqual([['CUSTOM_KEY']])
  })

  it.each<[string, Bench]>([
    ['nothing stored', {}],
    ['an empty reference', { refs: { OPENCODE_GO_API_KEY: '' } }],
    ['a grant record', { records: new Map([[OPENCODE_KEY, { kind: 'grant', payload: {} }]]) }],
    ['a key record holding only environment values', { records: new Map([[OPENCODE_KEY, { kind: 'api-key' }]]) }],
    ['a key record with an empty key', { records: new Map([[OPENCODE_KEY, { kind: 'api-key', key: '' }]]) }],
  ])('asks for a key without sending anything for %s', async (_name, bench) => {
    const api = await fakeApi(respondJson(200, OPENCODE_USAGE))
    const { usage } = service({ ...bench, config: { opencodeGo: { endpoint: api.endpoint } } })
    expect(rowOf(await read(usage), 'opencode-go')).toEqual({ provider: 'opencode-go', status: 'sign-in-required', reason: 'not-signed-in' })
    expect(api.requests).toHaveLength(0)
  })

  it('reports a store failure by its code alone', async () => {
    const { usage, resolve } = service({ config: { opencodeGo: { enabled: true } } })
    resolve.mockRejectedValueOnce(new Error(`cannot read ${SECRET}`))
    const report = await read(usage)
    expect(rowOf(report, 'opencode-go')).toEqual({ provider: 'opencode-go', status: 'failed', reason: 'credential-unusable' })
    expect(JSON.stringify(report)).not.toContain(SECRET)
  })

  it('keeps the windows that are present and the numbers they report', () => {
    expect(parseOpenCodeGoUsage({ usage: { weekly: { percent: 5 }, monthly: { status: 'ok' }, rolling: 'none' } })?.meters)
      .toEqual([{ id: 'weekly', unlimited: false, percentUsed: 5 }])
  })

  it.each([[null], [{}], [{ usage: 'none' }], [{ usage: {} }], [{ usage: { rolling: { status: 'ok' } } }]])(
    'finds no usage in %j',
    (body) => { expect(parseOpenCodeGoUsage(body)).toBeUndefined() },
  )
})

describe('parseCodexUsage', () => {
  it('reads rate-limit windows on accounts that report them', () => {
    expect(parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 7, reset_at: 1_796_083_200 },
        secondary_window: { used_percent: 9, reset_after_seconds: 60 },
      },
      code_review_rate_limit: { primary_window: { used_percent: 11 } },
    })?.meters).toEqual([
      { id: 'primary_window', unlimited: false, percentUsed: 7, resetAt: 1_796_083_200_000 },
      { id: 'secondary_window', unlimited: false, percentUsed: 9, resetAt: expect.any(Number) as number },
      { id: 'code_review', unlimited: false, percentUsed: 11 },
    ])
  })

  it('keeps a plan alone when the response carries no quota', () => {
    expect(parseCodexUsage({ plan_type: 'free', rate_limit: null, spend_control: { reached: false } })).toEqual({ plan: 'free', meters: [] })
  })

  it('keeps the numbers a partial limit reports', () => {
    expect(parseCodexUsage({ spend_control: { individual_limit: { used: '3', limit: 'n/a' } } })?.meters)
      .toEqual([{ id: 'spend_limit', unlimited: false, used: 3 }])
  })

  it('reports unlimited credits and drops credits with no balance', () => {
    expect(parseCodexUsage({ credits: { unlimited: true } })?.meters).toEqual([{ id: 'credits', unlimited: true }])
    expect(parseCodexUsage({ plan_type: 'p', credits: { has_credits: false, balance: null } })?.meters).toEqual([])
  })

  it.each([[null], ['text'], [[]], [{}], [{ plan_type: '' }], [{ credits: 'x', spend_control: { individual_limit: { source: 'x' } } }]])(
    'finds no usage in %j',
    (body) => { expect(parseCodexUsage(body)).toBeUndefined() },
  )
})

describe('response value coercion', () => {
  it.each<[unknown, number | undefined]>([[3.5, 3.5], ['3.5', 3.5], [Number.NaN, undefined], ['', undefined], ['  ', undefined], ['n/a', undefined], [null, undefined]])(
    'reads the amount %j',
    (value, expected) => { expect(amount(value)).toBe(expected) },
  )

  it.each<[unknown, number | undefined]>([
    [1_796_083_200, 1_796_083_200_000], [1_796_083_200_000, 1_796_083_200_000], ['1796083200', 1_796_083_200_000], [RESET, RESET_MS],
    [0, undefined], [-5, undefined], ['soon', undefined], [null, undefined],
  ])('reads the instant %j', (value, expected) => { expect(instant(value)).toBe(expected) })

  it('bounds provider text and refuses anything else', () => {
    expect(boundedText('x'.repeat(80))).toHaveLength(64)
    expect(boundedText('')).toBeUndefined()
    expect(boundedText(7)).toBeUndefined()
  })
})

describe('default endpoints', () => {
  it.each<[UsageProviderId, Bench, string]>([
    ['openai-codex', { records: new Map([[CODEX_KEY, codexGrant()]]), config: { openaiCodex: { enabled: true } } }, 'https://chatgpt.com/backend-api/wham/usage'],
    ['xai', { records: new Map([[XAI_KEY, xaiGrant()]]), config: { xai: { enabled: true } } }, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'],
    ['opencode-go', { refs: { OPENCODE_GO_API_KEY: SECRET }, config: { opencodeGo: { enabled: true } } }, 'https://opencode.ai/zen/go/v1/usage'],
  ])('requests the %s usage URL, refusing redirects', async (provider, bench, url) => {
    const requests: [string, RequestInit | undefined][] = []
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
      requests.push([input, init])
      return Promise.resolve(Response.json({}))
    })
    const { usage } = service(bench)
    expect(rowOf(await read(usage), provider)).toEqual({ provider, status: 'failed', reason: 'invalid-response' })
    expect(requests.map(([requested]) => requested)).toEqual([url])
    expect(requests[0]?.[1]?.redirect).toBe('error')
  })
})

describe.each<[string, UsageProviderId, Bench, (endpoint: string) => RowConfig]>([
  ['OpenAI Codex', 'openai-codex', { records: new Map([[CODEX_KEY, codexGrant()]]) }, endpoint => ({ openaiCodex: { endpoint } })],
  ['xAI', 'xai', { records: new Map([[XAI_KEY, xaiGrant()]]) }, endpoint => ({ xai: { endpoint } })],
  ['OpenCode Go', 'opencode-go', { refs: { OPENCODE_GO_API_KEY: SECRET } }, endpoint => ({ opencodeGo: { endpoint } })],
])('%s failures', (_name, provider, stored, config) => {
  it.each([
    [401, { status: 'sign-in-required', reason: 'token-rejected' }],
    [403, { status: 'failed', reason: 'forbidden' }],
    [429, { status: 'failed', reason: 'rate-limited' }],
    [503, { status: 'failed', reason: 'http-error', httpStatus: 503 }],
  ])('reports HTTP %i as its own state', async (status, expected) => {
    const api = await fakeApi(respondJson(status, { echoed: SECRET }))
    const { usage, warn } = service({ ...stored, config: config(api.endpoint) })
    const report = await read(usage)
    expect(rowOf(report, provider)).toEqual({ provider, ...expected })
    expect(JSON.stringify([report, warn.mock.calls])).not.toContain(SECRET)
  })

  it('stops at the configured time limit', async () => {
    const api = await fakeApi(() => { /* Hold the response open; teardown closes the connection. */ })
    const { usage } = service({ ...stored, config: { ...config(api.endpoint), timeoutMs: 20 } })
    expect(rowOf(await read(usage), provider)).toEqual({ provider, status: 'failed', reason: 'timeout' })
  })

  it('reports a body without a usage field as an invalid response', async () => {
    const api = await fakeApi(respondJson(200, { unrelated: true }))
    const { usage } = service({ ...stored, config: config(api.endpoint) })
    expect(rowOf(await read(usage), provider)).toEqual({ provider, status: 'failed', reason: 'invalid-response' })
  })

  it('refuses a redirect, so the token never reaches its target', async () => {
    const target = await fakeApi(respondJson(200, {}))
    const api = await fakeApi((_request, response) => {
      response.writeHead(302, { location: target.endpoint })
      response.end()
    })
    const { usage } = service({ ...stored, config: config(api.endpoint) })
    expect(rowOf(await read(usage), provider)).toEqual({ provider, status: 'failed', reason: 'network' })
    expect(target.requests).toHaveLength(0)
  })
})

describe('provider isolation', () => {
  it('keeps every other row when one provider fails, stalls, or needs a sign-in', async () => {
    const codex = await fakeApi(respondJson(500, {}))
    const xai = await fakeApi(() => { /* Hold the response open; teardown closes the connection. */ })
    const opencode = await fakeApi(respondJson(200, OPENCODE_USAGE))
    const { usage } = service({
      records: new Map([[CODEX_KEY, codexGrant()], [XAI_KEY, xaiGrant()]]),
      refs: { OPENCODE_GO_API_KEY: SECRET },
      config: {
        timeoutMs: 30,
        copilot: { enabled: true },
        openaiCodex: { endpoint: codex.endpoint },
        xai: { endpoint: xai.endpoint },
        opencodeGo: { endpoint: opencode.endpoint },
      },
    })
    const report = await read(usage)
    expect(report.providers.map(row => [row.provider, row.status])).toEqual([
      ['github-copilot', 'sign-in-required'],
      ['openai-codex', 'failed'],
      ['xai', 'failed'],
      ['opencode-go', 'ok'],
    ])
  })

  it.each<[string, RowConfig]>([
    ['openai-codex', { openaiCodex: { enabled: false } }],
    ['xai', { xai: { enabled: false } }],
    ['opencode-go', { opencodeGo: { enabled: false } }],
  ])('reads no credential for %s while it is turned off', async (provider, config) => {
    const { usage, readRecord, resolve } = service({ config })
    expect(rowOf(await read(usage), provider as UsageProviderId)).toEqual({ provider, status: 'unsupported', reason: 'disabled' })
    expect(readRecord).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })
})

describe('retained reads', () => {
  const opencodeBench = async (minRefreshIntervalMs: number) => {
    const api = await fakeApi(respondJson(200, OPENCODE_USAGE))
    return { api, ...service({ refs: { OPENCODE_GO_API_KEY: SECRET }, config: { minRefreshIntervalMs, opencodeGo: { endpoint: api.endpoint } } }) }
  }

  it('answers from the last read within the interval and says when it was read', async () => {
    const { api, usage } = await opencodeBench(60_000)
    const before = Date.now()
    const first = await read(usage)
    const second = await read(usage)
    expect(api.requests).toHaveLength(1)
    expect(second).toEqual(first)
    expect(first.readAt).toBeGreaterThanOrEqual(before)
  })

  it('reads again once the interval has passed', async () => {
    const { api, usage } = await opencodeBench(60_000)
    const first = await read(usage)
    vi.spyOn(Date, 'now').mockReturnValue(first.readAt + 60_000)
    try {
      await read(usage)
      expect(api.requests).toHaveLength(2)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('reads every time when the interval is zero', async () => {
    const { api, usage } = await opencodeBench(0)
    await read(usage)
    await read(usage)
    expect(api.requests).toHaveLength(2)
  })

  it('shares one read between callers that arrive while it runs', async () => {
    const { api, usage } = await opencodeBench(0)
    const [first, second] = await Promise.all([read(usage), read(usage)])
    expect(second).toEqual(first)
    expect(api.requests).toHaveLength(1)
  })

  it('finishes a read its caller abandoned, so the next open reuses it', async () => {
    const hold = Promise.withResolvers<void>()
    const api = await fakeApi((request, response) => {
      void hold.promise.then(() => { respondJson(200, OPENCODE_USAGE)(request, response) })
    })
    const { usage } = service({ refs: { OPENCODE_GO_API_KEY: SECRET }, config: { minRefreshIntervalMs: 60_000, opencodeGo: { endpoint: api.endpoint } } })
    const caller = new AbortController()
    const abandoned = read(usage, caller.signal)
    await vi.waitFor(() => { expect(api.requests).toHaveLength(1) })
    caller.abort(new Error('page closed'))
    await expect(abandoned).rejects.toThrow('page closed')
    hold.resolve()
    expect(rowOf(await read(usage), 'opencode-go')).toMatchObject({ status: 'ok' })
    expect(api.requests).toHaveLength(1)
  })

  it.each(['credentials/record-updated', 'credentials/reference-updated'] as const)('reads again after %s', async (event) => {
    const { api, ctx, usage } = await opencodeBench(60_000)
    await read(usage)
    ctx.emit(event, 'fixture' as never)
    await read(usage)
    expect(api.requests).toHaveLength(2)
  })

  it('does not retain a read that a credential change overtook', async () => {
    const hold = Promise.withResolvers<void>()
    const api = await fakeApi((request, response) => {
      void hold.promise.then(() => { respondJson(200, OPENCODE_USAGE)(request, response) })
    })
    const { ctx, usage } = service({ refs: { OPENCODE_GO_API_KEY: SECRET }, config: { minRefreshIntervalMs: 60_000, opencodeGo: { endpoint: api.endpoint } } })
    const overtaken = read(usage)
    await vi.waitFor(() => { expect(api.requests).toHaveLength(1) })
    ctx.emit('credentials/reference-updated', 'fixture' as never)
    hold.resolve()
    await overtaken
    await read(usage)
    expect(api.requests).toHaveLength(2)
  })

  it('stops the shared read when the plugin unloads', async () => {
    const api = await fakeApi(() => { /* Hold the response open; unloading stops the request. */ })
    const { ctx, usage } = service({ refs: { OPENCODE_GO_API_KEY: SECRET }, config: { opencodeGo: { endpoint: api.endpoint } } })
    const pending = read(usage)
    await vi.waitFor(() => { expect(api.requests).toHaveLength(1) })
    const rejection = expect(pending).rejects.toThrow()
    await ctx.fiber.dispose()
    await rejection
  })
})

describe('over the real credential and authorization services', () => {
  /** Real services, with a flow that renews its record the way the record's owner does. */
  async function composition(stored: CredentialRecord, renewed: CredentialRecord | Error) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-usage-'))
    dirs.push(dir)
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)
    await ctx.credentials.modifyRecord(CODEX_KEY, () => Promise.resolve(stored))
    const run = vi.fn(() => Promise.resolve())
    ctx.authorization.registerFlow({
      key: CODEX_KEY,
      label: 'fixture',
      methods: [{ id: 'oauth', label: 'fixture' }],
      run,
      async renew() {
        if (renewed instanceof Error) throw renewed
        await ctx.credentials.modifyRecord(CODEX_KEY, () => Promise.resolve(renewed))
      },
    })
    return { ctx, run }
  }

  it('renews through the registered flow, stores the result, and reads with it', async () => {
    const api = await fakeApi(respondJson(200, CODEX_USAGE))
    const renewed = codexGrant('renewed-token')
    const { ctx, run } = await composition(codexGrant('expired-token', Date.now() - HOUR), renewed)
    const usage = new ProviderUsageService(ctx, ProviderUsageService.Config({
      copilot: { enabled: false }, xai: { enabled: false }, opencodeGo: { enabled: false }, openaiCodex: { endpoint: api.endpoint },
    }))
    expect(rowOf(await read(usage), 'openai-codex')).toEqual(CODEX_ROW)
    expect(api.requests[0]?.headers.authorization).toBe('Bearer renewed-token')
    await expect(ctx.credentials.readRecord(CODEX_KEY)).resolves.toEqual(renewed)
    expect(run).not.toHaveBeenCalled()
  })

  it('preserves the stored grant when the renewal fails and starts no sign-in', async () => {
    const stored = codexGrant('expired-token', Date.now() - HOUR)
    const { ctx, run } = await composition(stored, new Error('invalid_grant'))
    const usage = new ProviderUsageService(ctx, ProviderUsageService.Config({
      copilot: { enabled: false }, xai: { enabled: false }, opencodeGo: { enabled: false },
    }))
    expect(rowOf(await read(usage), 'openai-codex')).toEqual({ provider: 'openai-codex', status: 'sign-in-required', reason: 'renewal-failed' })
    await expect(ctx.credentials.readRecord(CODEX_KEY)).resolves.toEqual(stored)
    expect(run).not.toHaveBeenCalled()
  })
})
