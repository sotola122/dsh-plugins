// @vitest-environment jsdom
/** The section as the Settings page renders it: every row state, only reported numbers, and read lifecycle. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { UsageMeter } from '../src/types.ts'
import { de, en, es, fr, ja, pt, ru, zh, type UsageLocaleKey } from '../src/client/locales.ts'
import type { UsageRow } from '../src/client/usage-controller.ts'
import { UsageSection, type UsageSectionProps } from '../src/client/UsageSection.tsx'

afterEach(cleanup)

const t = (key: UsageLocaleKey, params?: Record<string, string | number>) =>
  en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name]))

function renderSection(rows: readonly UsageRow[]) {
  const refresh = vi.fn()
  const cancel = vi.fn()
  const props = {
    t, refresh, cancel, close: vi.fn(), useUsageRows: bindSnapshotSelector(createSnapshotStore(rows)),
  } as unknown as UsageSectionProps
  const view = render(<UsageSection {...props} />)
  return { refresh, cancel, view }
}

const meterRow = (meter: UsageMeter): UsageRow => ({ provider: 'github-copilot', status: 'ok', meters: [meter] })

describe('UsageSection', () => {
  it('reads when it opens, abandons the read when it closes, and re-reads on request', () => {
    const { refresh, cancel, view } = renderSection([{ provider: 'xai', status: 'unsupported', reason: 'no-usage-endpoint' }])
    expect(refresh).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(cancel).not.toHaveBeenCalled()
    view.unmount()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('shows every loading row and blocks another read until they settle', () => {
    renderSection([{ provider: 'github-copilot', status: 'loading' }, { provider: 'xai', status: 'loading' }])
    expect(screen.getByText(en['provider.github-copilot'])).toBeTruthy()
    expect(screen.getAllByText(en['status.loading'])).toHaveLength(2)
    expect(screen.getByRole('button', { name: en.refresh }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('list').getAttribute('aria-busy')).toBe('true')
  })

  it('shows the plan, quota, and reset time a provider reported', () => {
    const resetAt = Date.parse('2026-12-01T00:00:00.000Z')
    renderSection([{
      provider: 'github-copilot',
      status: 'ok',
      plan: 'individual_pro',
      resetAt,
      meters: [{ id: 'premium_interactions', unlimited: false, entitlement: 300, remaining: 120.5, percentRemaining: 40.2 }],
    }])
    expect(screen.getByText(en['status.ok'])).toBeTruthy()
    expect(screen.getByText('Plan: individual_pro')).toBeTruthy()
    expect(screen.getByText('Premium requests: 120.5 of 300 left')).toBeTruthy()
    expect(screen.getByText(`Resets: ${new Date(resetAt).toLocaleString()}`)).toBeTruthy()
  })

  it.each<[string, UsageMeter, string]>([
    ['an unlimited quota', { id: 'chat', unlimited: true }, 'Chat: unlimited'],
    ['a remaining count alone', { id: 'completions', unlimited: false, remaining: 7 }, 'Completions: 7 left'],
    ['a percentage alone', { id: 'chat', unlimited: false, percentRemaining: 40.6 }, 'Chat: 41% left'],
    ['a quota with an unknown name', { id: 'new_quota', unlimited: false, remaining: 1 }, 'new_quota: 1 left'],
  ])('renders %s', (_name, meter, text) => {
    renderSection([meterRow(meter)])
    expect(screen.getByText(text)).toBeTruthy()
  })

  it('omits a quota the provider reported no value for', () => {
    renderSection([meterRow({ id: 'chat', unlimited: false })])
    expect(screen.queryByText(/Chat/)).toBeNull()
  })

  it.each(['openai-codex', 'xai', 'opencode-go'] as const)('explains why %s is not supported', (provider) => {
    renderSection([{ provider, status: 'unsupported', reason: 'no-usage-endpoint' }])
    expect(screen.getByText(en['status.unsupported'])).toBeTruthy()
    expect(screen.getByText(en[`unsupported.${provider}`])).toBeTruthy()
  })

  it('names the profile when reading is turned off', () => {
    renderSection([{ provider: 'github-copilot', status: 'unsupported', reason: 'disabled' }])
    expect(screen.getByText(en['unsupported.disabled'])).toBeTruthy()
  })

  it.each([
    'not-signed-in', 'credential-unusable', 'unauthorized', 'rate-limited', 'timeout', 'network', 'invalid-response', 'host-unavailable',
  ] as const)('shows the %s failure', (reason) => {
    renderSection([{ provider: 'github-copilot', status: 'failed', reason }])
    expect(screen.getByText(en['status.failed'])).toBeTruthy()
    expect(screen.getByText(en[`failure.${reason}`])).toBeTruthy()
  })

  it('names the status of an HTTP failure', () => {
    renderSection([{ provider: 'github-copilot', status: 'failed', reason: 'http-error', httpStatus: 503 }])
    expect(screen.getByText('The provider answered with HTTP 503.')).toBeTruthy()
  })
})

describe('dictionaries', () => {
  it.each(Object.entries({ zh, ja, es, fr, de, ru, pt }))('%s fills every key with the English placeholders', (_locale, dictionary) => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
    for (const key of Object.keys(en) as UsageLocaleKey[]) {
      expect(dictionary[key].length, key).toBeGreaterThan(0)
      expect(placeholders(dictionary[key]), key).toEqual(placeholders(en[key]))
    }
  })
})
