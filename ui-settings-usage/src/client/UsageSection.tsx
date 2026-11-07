/** The Settings page's Usage section: one row per provider, read when the page opens. */

import { useEffect, type CSSProperties } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UsageMeter } from '../types.ts'
import type { UsageLocaleKey } from './locales.ts'
import type { UsageRow } from './usage-controller.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Provider usage section copy. */
    'settings.usage': UsageLocaleKey
  }
}

/** Registration-side business face for the section. */
export interface UsageSectionInjected {
  hooks: {
    /** The provider rows, bound by the renderer as `useUsageRows`. */
    usageRows: SnapshotStore<readonly UsageRow[]>
    /** When the shown rows were read, bound by the renderer as `useUsageReadAt`. */
    usageReadAt: SnapshotStore<number | undefined>
  }
  /** Start a read; called on open and from the refresh button. */
  refresh: () => void
  /** Abandon the read in flight when the section closes. */
  cancel: () => void
}

/** Props the renderer binds for the section. */
export type UsageSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.usage'>
  & InjectFace<UsageSectionInjected>

type Translate = UsageSectionProps['t']

const SECTION_STYLE: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 760, color: 'var(--dsw-alias-label-primary)',
}
const HEADER_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }
const HEADING_STYLE: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 500 }
const INTRO_STYLE: CSSProperties = { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' }
const LIST_STYLE: CSSProperties = {
  margin: 0, padding: 0, listStyle: 'none', borderRadius: 'var(--dsw-radius-md)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
}
const ROW_STYLE: CSSProperties = { display: 'grid', gap: 6, padding: '12px 16px', minWidth: 0 }
const DIVIDED_ROW_STYLE: CSSProperties = { ...ROW_STYLE, borderTop: '0.5px solid var(--dsw-alias-border-l2)' }
const ROW_HEAD_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }
const PROVIDER_STYLE: CSSProperties = { fontSize: 13, fontWeight: 500, lineHeight: 1.5 }
const DETAIL_STYLE: CSSProperties = {
  margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere',
}

const STATUS_TONES: Record<UsageRow['status'], TagTone> = {
  loading: 'neutral',
  ok: 'success',
  unsupported: 'outline',
  'sign-in-required': 'warning',
  failed: 'danger',
}

const METER_NAMES: Readonly<Record<string, UsageLocaleKey>> = {
  premium_interactions: 'meter.premium_interactions',
  chat: 'meter.chat',
  completions: 'meter.completions',
  spend_limit: 'meter.spend_limit',
  primary_window: 'meter.primary_window',
  secondary_window: 'meter.secondary_window',
  code_review: 'meter.code_review',
  credits: 'meter.credits',
  rolling: 'meter.rolling',
  weekly: 'meter.weekly',
  monthly: 'meter.monthly',
  included_credits: 'meter.included_credits',
  on_demand: 'meter.on_demand',
  prepaid_credits: 'meter.prepaid_credits',
}

const NUMBER_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

/** Separates the facts about one quota on its line. */
const DETAIL_SEPARATOR = ' · '

/**
 * The usage rate and allowance facts one quota reported, each as a phrase.
 * @param meter - the quota.
 * @param t - the section's locale reader.
 * @returns the phrases; only numbers the provider reported produce one.
 */
function meterDetails(meter: UsageMeter, t: Translate): string[] {
  const money = (value: number): string => {
    const formatted = NUMBER_FORMAT.format(value)
    return meter.unit === undefined ? formatted : `${formatted} ${meter.unit}`
  }
  const { used, remaining, entitlement, percentUsed, percentRemaining, resetAt } = meter
  const details: string[] = []
  if (used !== undefined) {
    details.push(entitlement === undefined
      ? t('detail.used', { used: money(used) })
      : t('detail.usedOf', { used: money(used), entitlement: money(entitlement) }))
  }
  if (remaining !== undefined) {
    details.push(entitlement === undefined || used !== undefined
      ? t('detail.remaining', { remaining: money(remaining) })
      : t('detail.remainingOf', { remaining: money(remaining), entitlement: money(entitlement) }))
  }
  const percent = percentUsed ?? (percentRemaining === undefined ? undefined : 100 - percentRemaining)
  if (percent !== undefined) details.push(t('detail.percentUsed', { percent: Math.round(percent) }))
  if (details.length > 0 && resetAt !== undefined) details.push(t('detail.resets', { time: new Date(resetAt).toLocaleString() }))
  return details
}

/**
 * One quota as text, using only the numbers the provider reported.
 * @param meter - the quota.
 * @param t - the section's locale reader.
 * @returns the line, or undefined when the provider reported no value for it.
 */
function meterLine(meter: UsageMeter, t: Translate): string | undefined {
  const known = METER_NAMES[meter.id]
  const name = known === undefined ? meter.id : t(known)
  if (meter.unlimited) return t('detail.unlimited', { name })
  const details = meterDetails(meter, t)
  return details.length === 0 ? undefined : t('detail.meter', { name, details: details.join(DETAIL_SEPARATOR) })
}

/**
 * The text lines under one provider's name.
 * @param row - the provider's row.
 * @param t - the section's locale reader.
 * @returns the lines; a loading row has none.
 */
function rowDetails(row: UsageRow, t: Translate): string[] {
  switch (row.status) {
    case 'loading':
      return []
    case 'ok':
      return [
        ...row.plan === undefined ? [] : [t('detail.plan', { plan: row.plan })],
        ...row.meters.flatMap(meter => meterLine(meter, t) ?? []),
        ...row.resetAt === undefined ? [] : [t('detail.resetAt', { time: new Date(row.resetAt).toLocaleString() })],
      ]
    case 'unsupported':
      return [t(`unsupported.${row.reason}`)]
    case 'sign-in-required':
      return [t(`signIn.${row.reason}`), t(`signIn.action.${row.provider}`)]
    case 'failed':
      return [row.reason === 'http-error'
        ? t('failure.http-error', { status: row.httpStatus })
        : t(`failure.${row.reason}`)]
    /* v8 ignore next -- unreachable: the switch names every member of the closed status union */
    default:
      return assertNever(row)
  }
}

/** Compile-time proof that a closed union's switch names every member. */
/* v8 ignore next -- unreachable: the only call is the switch default above */
function assertNever(_value: never): never {
  throw new Error('ui-settings-usage: unknown row status')
}

/**
 * Render every provider's status and whatever usage it reported. Opening the
 * section starts the read and closing it abandons the read. A sign-in row says
 * what to do; the section never starts a sign-in.
 * @param props - composed Settings slot props.
 * @returns the section.
 */
export function UsageSection({ t, useUsageRows, useUsageReadAt, refresh, cancel }: UsageSectionProps) {
  const rows = useUsageRows(value => value)
  const readAt = useUsageReadAt(value => value)
  const loading = rows.some(row => row.status === 'loading')
  useEffect(() => {
    refresh()
    return cancel
  }, [refresh, cancel])
  return (
    <div style={SECTION_STYLE}>
      <div style={HEADER_STYLE}>
        <h2 style={HEADING_STYLE}>{t('title')}</h2>
        <Button variant="outline" size="sm" disabled={loading} onClick={refresh}>{t('refresh')}</Button>
      </div>
      <p style={INTRO_STYLE}>{t('intro')}</p>
      {readAt === undefined ? null : <p style={INTRO_STYLE}>{t('detail.updatedAt', { time: new Date(readAt).toLocaleString() })}</p>}
      <ul style={LIST_STYLE} aria-busy={loading}>
        {rows.map((row, index) => (
          <li key={row.provider} style={index === 0 ? ROW_STYLE : DIVIDED_ROW_STYLE}>
            <div style={ROW_HEAD_STYLE}>
              <span style={PROVIDER_STYLE}>{t(`provider.${row.provider}`)}</span>
              <Tag tone={STATUS_TONES[row.status]}>{t(`status.${row.status}`)}</Tag>
            </div>
            {rowDetails(row, t).map(line => <p key={line} style={DETAIL_STYLE}>{line}</p>)}
          </li>
        ))}
      </ul>
    </div>
  )
}
