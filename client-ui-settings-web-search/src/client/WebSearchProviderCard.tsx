/**
 * One web-search provider's card: the switch that selects this provider, its
 * write-only API key, and the provider's own result and filtering fields. The
 * key is written through the credentials domain, never into the settings
 * section, so its literal never rides a response.
 */

import type { CSSProperties, ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm, SettingsSecretField, SettingsValueField, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  BRAVE_SAFESEARCH_LABELS, EXA_SEARCH_TYPE_LABELS, formLabels,
  type WebSearchProvidersLocaleKey,
} from './locales.ts'
import {
  BRAVE_SAFESEARCH_VALUES, EXA_SEARCH_TYPES,
  type WebSearchProviderCardFace, type WebSearchProviderCardState,
} from './web-search-provider-card-controller.ts'

/** Props the renderer binds for one web-search provider card. */
export type WebSearchProviderCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.webSearchProviders'>
  & InjectFace<WebSearchProviderCardFace>

/** Label and hint of one field, resolved from the card's dictionary. */
interface CardCopy {
  /** Visible field label. */
  label: string
  /** One-line explanation rendered under the control. */
  hint: string
  /** Copy shown in place of the hint while the draft is invalid. */
  invalid: string
}

/** The three provider-specific panels, each with its own copy and control. */
const PANEL_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0' }
const HEAD_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }
const FIELD_NAME_STYLE: CSSProperties = {
  flex: '1 1 auto', minWidth: 0, fontSize: 13, fontWeight: 500, lineHeight: 1.5,
  color: 'var(--dsw-alias-label-primary)',
}
const BADGES_STYLE: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 8 }
const RESET_STYLE: CSSProperties = {
  border: 'none', background: 'none', padding: 0, font: 'inherit', fontSize: 12, lineHeight: 1.5,
  color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
}
const SELECT_STYLE: CSSProperties = {
  height: 34, padding: '0 12px', border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-bg-layer-3)',
  font: 'inherit', fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)',
}
const HINT_STYLE: CSSProperties = { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' }
const INVALID_STYLE: CSSProperties = { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-state-error-primary)' }
const SWITCH_ROW_STYLE: CSSProperties = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }
const SWITCH_LABEL_STYLE: CSSProperties = { fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' }
const SWITCH_BLOCK_STYLE: CSSProperties = { display: 'grid', gap: 6 }

/** One choice of a staged select control. */
interface SelectChoice {
  /** Value the section stores. */
  value: string
  /** Localized option text. */
  label: string
}

/**
 * A staged fixed-choice field: the label, the override badge and its reset, the
 * select, and the hint or validation message.
 * @param props - the field's copy, its staged value, and its edit actions.
 * @returns the labelled select.
 */
function SelectField(props: {
  id: string
  copy: CardCopy
  value: string
  choices: readonly SelectChoice[]
  overridden: boolean
  invalid: boolean
  overriddenLabel: string
  resetLabel: string
  disabled: boolean
  onEdit: (value: string) => void
  onReset: () => void
}) {
  const messageId = `${props.id}-message`
  return (
    <div style={PANEL_STYLE}>
      <div style={HEAD_STYLE}>
        <label style={FIELD_NAME_STYLE} htmlFor={props.id}>{props.copy.label}</label>
        {props.overridden
          ? (
            <span style={BADGES_STYLE}>
              <Tag tone="neutral">{props.overriddenLabel}</Tag>
              <button type="button" style={RESET_STYLE} disabled={props.disabled} onClick={props.onReset}>
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <select
        id={props.id}
        style={SELECT_STYLE}
        {...props.invalid ? { 'aria-invalid': true } : {}}
        aria-describedby={messageId}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      >
        {props.choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
      </select>
      <p id={messageId} style={props.invalid ? INVALID_STYLE : HINT_STYLE}>
        {props.invalid ? props.copy.invalid : props.copy.hint}
      </p>
    </div>
  )
}

/** Resolve the localized option list of a staged select. */
function choicesOf<T extends string>(
  values: readonly T[],
  labels: Record<T, WebSearchProvidersLocaleKey>,
  t: (key: WebSearchProvidersLocaleKey) => string,
): SelectChoice[] {
  return values.map(value => ({ value, label: t(labels[value]) }))
}

/**
 * Render one provider's one-liner or its settings form, as the Plugins page asks.
 * @param props - the view asked for, locale copy, the card snapshot, and its actions.
 * @returns the one-liner, or the form.
 */
export function WebSearchProviderCard(props: WebSearchProviderCardProps) {
  const { t } = props
  const state = props.useWebSearchProviderCard(snapshot => snapshot)
  if (props.view === 'summary') return t(state.provider === 'exa' ? 'descriptionExa' : 'descriptionBrave')
  const disabled = !state.writable || state.saving
  const switchDisabled = disabled || !state.switchAvailable || state.switchBlocked
  const switchKey: WebSearchProvidersLocaleKey = state.provider === 'exa' ? 'enabledExa' : 'enabledBrave'
  const panel = panelFields(state, props, t)
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <div style={SWITCH_BLOCK_STYLE}>
        <div style={SWITCH_ROW_STYLE}>
          <span style={SWITCH_LABEL_STYLE}>{t(switchKey)}</span>
          <Switch
            checked={state.enabled}
            label={t(switchKey)}
            disabled={switchDisabled}
            title={state.switchAvailable ? undefined : t('switchUnavailable')}
            onChange={(next) => { props.setEnabled(next) }}
          />
        </div>
        <p style={HINT_STYLE}>{t('switchHint')}</p>
        {state.switchAvailable ? null : <p style={HINT_STYLE}>{t('switchUnavailable')}</p>}
      </div>
      {/* jscpd:ignore-start -- anago reuses the upstream secret-field row for a different settings document. */}
      <SettingsSecretField
        id="plugin-config-web-search-api-key"
        label={t('apiKey')}
        hint={t(state.provider === 'exa' ? 'apiKeyHintExa' : 'apiKeyHintBrave')}
        // The credentials domain accepts a key even when the settings document
        // itself is read-only; they are separate stores with separate refusals.
        disabled={!state.apiKeyWritable}
        text={state.apiKey.text}
        configured={state.apiKeyConfigured}
        stateLabel={state.apiKeyConfigured ? t('apiKeySet') : t('apiKeyUnset')}
        onEdit={(text) => { props.edit('apiKey', text) }}
      />
      {/* jscpd:ignore-end */}
      {panel}
    </SettingsForm>
  )
}

/**
 * Render one provider's own fields: Exa's retrieval mode, or Brave's result
 * bound and content filter.
 * @param state - the provider-narrowed card state.
 * @param props - the card's injected actions.
 * @param t - the card's locale reader.
 * @returns the provider's controls.
 */
function panelFields(
  state: WebSearchProviderCardState,
  props: WebSearchProviderCardProps,
  t: (key: WebSearchProvidersLocaleKey) => string,
): ReactNode {
  const disabled = !state.writable || state.saving
  const shared = { overriddenLabel: t('overridden'), resetLabel: t('reset'), disabled }
  if (state.provider === 'exa') {
    return (
      <SelectField
        id="plugin-config-web-search-exa-type"
        copy={{ label: t('searchType'), hint: t('searchTypeHint'), invalid: t('invalidSearchType') }}
        value={state.searchType.text}
        choices={choicesOf(EXA_SEARCH_TYPES, EXA_SEARCH_TYPE_LABELS, t)}
        overridden={state.searchType.overridden}
        invalid={state.searchType.invalid}
        {...shared}
        onEdit={(value) => { props.edit('searchType', value) }}
        onReset={() => { props.resetField('searchType') }}
      />
    )
  }
  return (
    <>
      <SettingsValueField
        id="plugin-config-web-search-brave-max-results"
        label={t('maxResults')}
        hint={t('maxResultsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidMaxResults')}
        numeric
        disabled={disabled}
        {...state.maxResults}
        onEdit={(text) => { props.edit('maxResults', text) }}
        onReset={() => { props.resetField('maxResults') }}
      />
      <SelectField
        id="plugin-config-web-search-brave-safesearch"
        copy={{ label: t('safesearch'), hint: t('safesearchHint'), invalid: t('invalidSafesearch') }}
        value={state.safesearch.text}
        choices={choicesOf(BRAVE_SAFESEARCH_VALUES, BRAVE_SAFESEARCH_LABELS, t)}
        overridden={state.safesearch.overridden}
        invalid={state.safesearch.invalid}
        {...shared}
        onEdit={(value) => { props.edit('safesearch', value) }}
        onReset={() => { props.resetField('safesearch') }}
      />
    </>
  )
}
