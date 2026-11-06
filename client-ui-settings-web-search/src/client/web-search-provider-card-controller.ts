/**
 * The Exa and Brave web-search cards' shared controller: one staged form per
 * provider and one staged form over the `web` service's provider selection.
 *
 * Both cards are views of the same `web.searchProvider` field, so a single
 * controller owns that selection and both cards project their switch from it.
 * A provider card stages its own namespace's numbers and select fields, and
 * stages its key through the credentials domain — the key's literal never
 * rides a response, so the card learns only whether one is configured and
 * whether the active provider accepts a write.
 *
 * A selection equal to the deployment's composed value clears the override
 * instead of storing a copy of it. Switching a card off selects the other
 * provider, which is the same field write the other card's switch would make.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsTextField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions,
  type SettingsFormScope, type SettingsFormScopeSnapshot, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Namespace of the web service's provider selection. */
export const WEB_NS = 'web'
/** Namespace of the Exa provider's settings. */
export const EXA_NS = 'web-search-exa'
/** Namespace of the Brave provider's settings. */
export const BRAVE_NS = 'web-search-brave'
/** Credential reference the Exa provider resolves. */
export const EXA_API_KEY_REF = 'EXA_API_KEY'
/** Credential reference the Brave provider resolves. */
export const BRAVE_API_KEY_REF = 'BRAVE_API_KEY'

/** The provider ids the switch writes into the web service's selection. */
export type WebSearchProviderId = 'exa' | 'brave'

/** Exa's retrieval modes. */
export type ExaSearchType = 'auto' | 'keyword' | 'neural'

/** Brave's content-filter levels. */
export type BraveSafeSearch = 'off' | 'moderate' | 'strict'

/** Every provider id, in card order. */
export const WEB_SEARCH_PROVIDER_IDS: readonly WebSearchProviderId[] = ['exa', 'brave']

/** The web service's provider selection. */
export interface WebProviderSelection {
  /** Search provider id. */
  searchProvider?: string
}

/** The Exa fields these cards edit. */
export interface ExaSearchSettings {
  /** Credential reference naming the environment key; the provider resolves it. */
  apiKeyEnv?: string
  /** Retrieval mode sent to Exa. */
  searchType?: ExaSearchType
}

/** The Brave fields these cards edit. */
export interface BraveSearchSettings {
  /** Credential reference naming the environment key; the provider resolves it. */
  apiKeyEnv?: string
  /** Default result count. */
  maxResults?: number
  /** Content-filter level. */
  safesearch?: BraveSafeSearch
}

/** What the credentials domain last reported, and for which reference. */
interface CredentialState {
  /** Reference this answer describes; a stale answer for another one is dropped. */
  ref: string
  /** Whether any layer supplies a value for it. */
  configured: boolean
  /** Whether `credentials/set` can affect it; false disables the control. */
  writable: boolean
}

/** Form field the credential control stages under. */
const API_KEY_FIELD = 'apiKey'

/** One provider's registration data. */
interface ProviderSpec {
  /** Provider id the selection stores. */
  readonly id: WebSearchProviderId
  /** Settings namespace the provider's Host plugin serves. */
  readonly namespace: string
  /** Credential reference the provider resolves. */
  readonly credentialRef: string
}

/** The provider table; the cards' registrations and credential reads derive from it. */
const PROVIDERS: Record<WebSearchProviderId, ProviderSpec> = {
  exa: { id: 'exa', namespace: EXA_NS, credentialRef: EXA_API_KEY_REF },
  brave: { id: 'brave', namespace: BRAVE_NS, credentialRef: BRAVE_API_KEY_REF },
}

/** The Exa select's stored values. */
export const EXA_SEARCH_TYPES: readonly ExaSearchType[] = ['auto', 'keyword', 'neural']
/** The Brave select's stored values. */
export const BRAVE_SAFESEARCH_VALUES: readonly BraveSafeSearch[] = ['off', 'moderate', 'strict']

/** What both cards share in their rendered state. */
interface ProviderCardCommon extends SettingsFormShell {
  /** Provider this card edits. */
  provider: WebSearchProviderId
  /** Whether the Host serves `web`; false disables the switch but keeps the key control. */
  switchAvailable: boolean
  /** Invalid edits or failed saves that switching providers must keep visible. */
  switchBlocked: boolean
  /** Staged switch position, derived from the shared `web.searchProvider` field. */
  enabled: boolean
  /** The staged credential, which starts blank on every load. */
  apiKey: SettingsFieldState
  /** Whether the Host reports a credential configured for the referenced key. */
  apiKeyConfigured: boolean
  /** Whether the credentials domain accepts a write for it; false disables the control. */
  apiKeyWritable: boolean
}

/** What one web-search card renders. */
export type WebSearchProviderCardState = ProviderCardCommon & (
  | {
    provider: 'exa'
    /** Exa's retrieval mode. */
    searchType: SettingsFieldState
  }
  | {
    provider: 'brave'
    /** Brave's default result count. */
    maxResults: SettingsFieldState
    /** Brave's content-filter level. */
    safesearch: SettingsFieldState
  }
)

/** The registration-side face one web-search card's slot entry injects. */
export interface WebSearchProviderCardFace extends SettingsFormActions {
  hooks: {
    /** Card snapshot bound by the renderer as useWebSearchProviderCard. */
    webSearchProviderCard: SnapshotStore<WebSearchProviderCardState>
  }
  /** Stage the switch: true selects this provider, false selects the other one. */
  setEnabled: (enabled: boolean) => void
}

/** Settings scopes for the namespaces the cards edit. */
export interface WebSearchProviderCardScopes {
  /** The web service's provider selection. */
  web: SettingsFormScope<WebProviderSelection>
  /** The Exa provider's settings. */
  exa: SettingsFormScope<ExaSearchSettings>
  /** The Brave provider's settings. */
  brave: SettingsFormScope<BraveSearchSettings>
}

/** One provider's form and credential facts. */
interface ProviderPane {
  /** Provider id. */
  readonly id: WebSearchProviderId
  /** The provider's registration data. */
  readonly spec: ProviderSpec
  /** The staged form over the provider's namespace. */
  readonly form: SettingsFormModel<ExaSearchSettings | BraveSearchSettings>
  /** Last credential answer, tagged with the reference it describes. */
  credential: CredentialState
  /** Token invalidating answers a newer read superseded. */
  generation: number
  /** Whether a card registration asked for the credential at least once. */
  started: boolean
}

/**
 * A whole-number field bounded below, and above when a maximum is given. An
 * empty draft clears the field; any other draft outside the bounds blocks the
 * save.
 * @param field - field name inside the namespace section.
 * @param min - smallest accepted integer.
 * @param max - largest accepted integer; unbounded when omitted.
 * @returns the field's conversion spec.
 */
function integerField(field: string, min: number, max = Number.POSITIVE_INFINITY): SettingsFieldSpec {
  return {
    field,
    format: value => typeof value === 'number' && Number.isInteger(value) ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const value = Number(trimmed)
      return Number.isInteger(value) && value >= min && value <= max ? { kind: 'set', value } : undefined
    },
  }
}

/**
 * A fixed-choice field. A stored value outside the choices renders the
 * default so the control always shows the value its fallback makes effective.
 * @param field - field name inside the namespace section.
 * @param values - accepted stored values.
 * @param fallback - value shown when the section carries none this field accepts.
 * @returns the field's conversion spec.
 */
function selectField<T extends string>(field: string, values: readonly T[], fallback: T): SettingsFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' && (values as readonly string[]).includes(value) ? value : fallback,
    parse: (text) => {
      const trimmed = text.trim()
      return (values as readonly string[]).includes(trimmed) ? { kind: 'set', value: trimmed } : undefined
    },
  }
}

/**
 * Bridge the two provider namespaces and the web provider selection onto both
 * cards. One controller serves both registrations so the two switches read one
 * staged field and can never report different providers.
 */
export class WebSearchProviderCardController {
  private readonly selection: SettingsFormModel<WebProviderSelection>
  private readonly panes: Record<WebSearchProviderId, ProviderPane>
  private readonly stores: Record<WebSearchProviderId, SnapshotStore<WebSearchProviderCardState>>
  private readonly unsubscribe: (() => void)[]

  /**
   * @param scopes - the bound settings scopes for the namespaces the cards edit.
   * @param ctx - the plugin's context, whose `remote.credentials` namespace
   * answers for each provider's key reference.
   */
  constructor(
    private readonly scopes: WebSearchProviderCardScopes,
    private readonly ctx: ClientContext,
  ) {
    this.selection = new SettingsFormModel(scopes.web, [settingsTextField('searchProvider')])
    this.panes = {
      exa: this.createPane('exa', [
        selectField('searchType', EXA_SEARCH_TYPES, 'auto'),
      ]),
      brave: this.createPane('brave', [
        integerField('maxResults', 1, 20),
        selectField('safesearch', BRAVE_SAFESEARCH_VALUES, 'moderate'),
      ]),
    }
    this.stores = {
      exa: createSnapshotStore(this.projection('exa')),
      brave: createSnapshotStore(this.projection('brave')),
    }
    const publish = () => { this.publish() }
    this.unsubscribe = [
      ...[this.selection, this.panes.exa.form, this.panes.brave.form]
        .map(form => form.bind(() => form.shell()))
        .map(trigger => trigger.subscribe(publish)),
      ...WEB_SEARCH_PROVIDER_IDS.map(id => this.scopes[id].subscribe(() => {
        // Only a registered card reads its key: the other provider's credential
        // is not part of anything the page shows yet.
        if (this.panes[id].started) void this.readCredential(id)
      })),
    ]
  }

  /**
   * Build one provider's staged form over its namespace.
   * @param id - provider id.
   * @param fields - the section fields this provider exposes.
   * @returns the pane the controller keeps for that provider.
   */
  private createPane(id: WebSearchProviderId, fields: SettingsFieldSpec[]): ProviderPane {
    return {
      id,
      spec: PROVIDERS[id],
      form: new SettingsFormModel(this.scopes[id], fields, [
        { field: API_KEY_FIELD, write: text => this.writeKey(id, text) },
      ]),
      credential: { ref: '', configured: false, writable: true },
      generation: 0,
      started: false,
    }
  }

  /**
   * Build the face one card's slot entry injects, and start reading its key.
   * @param id - provider the card edits.
   * @returns the card's snapshot and its form actions.
   */
  inject(id: WebSearchProviderId): WebSearchProviderCardFace {
    const pane = this.panes[id]
    if (!pane.started) {
      pane.started = true
      void this.readCredential(id)
    }
    return {
      hooks: { webSearchProviderCard: this.stores[id] },
      edit: (field, text) => { pane.form.actions().edit(field, text) },
      resetField: (field) => { pane.form.actions().resetField(field) },
      setEnabled: (enabled) => { this.select(id, enabled) },
      save: () => { void this.save(id) },
      discard: () => {
        pane.form.actions().discard()
        this.selection.actions().discard()
      },
    }
  }

  /**
   * Re-read after the Host reports a change to a reference a card watches.
   * @param ref - the reference the Host reports as changed.
   */
  refreshCredential(ref: string): void {
    for (const id of WEB_SEARCH_PROVIDER_IDS) {
      if (this.panes[id].started && this.currentRef(id) === ref) void this.readCredential(id)
    }
  }

  /** Rebuild both cards' snapshots from the shared forms. */
  private publish(): void {
    for (const id of WEB_SEARCH_PROVIDER_IDS) this.stores[id].set(this.projection(id))
  }

  /**
   * Build one card's state from the selection and its provider form.
   * @param id - provider the card edits.
   * @returns the card's current state.
   */
  private projection(id: WebSearchProviderId): WebSearchProviderCardState {
    const pane = this.panes[id]
    const selectionShell = this.selection.shell()
    const providerShell = pane.form.shell()
    const served = [selectionShell, providerShell].filter(item => item.available)
    /* jscpd:ignore-start -- the provider card folds the same SettingsFormShell flags as the upstream search card; the panes differ. */
    const shell: SettingsFormShell = {
      available: providerShell.available,
      writable: served.every(item => item.writable),
      dirty: served.some(item => item.dirty),
      invalid: served.some(item => item.invalid),
      saving: served.some(item => item.saving),
      failed: served.some(item => item.failed),
    }
    /* jscpd:ignore-end */
    const common: ProviderCardCommon = {
      ...shell,
      provider: id,
      switchAvailable: selectionShell.available,
      switchBlocked: shell.invalid || shell.failed,
      enabled: selectionShell.available && this.selection.field('searchProvider').text === id,
      apiKey: pane.form.field(API_KEY_FIELD),
      apiKeyConfigured: pane.credential.configured,
      apiKeyWritable: pane.credential.writable,
    }
    return id === 'exa'
      ? { ...common, provider: 'exa', searchType: pane.form.field('searchType') }
      : { ...common, provider: 'brave', maxResults: pane.form.field('maxResults'), safesearch: pane.form.field('safesearch') }
  }

  /**
   * Stage one switch position. A target equal to the composed value clears the
   * override so the deployment default keeps applying.
   * @param id - provider whose card changed.
   * @param enabled - true selects this provider, false selects the other one.
   */
  private select(id: WebSearchProviderId, enabled: boolean): void {
    const target = enabled ? id : otherProvider(id)
    const base = this.scopes.web.getSnapshot().base as WebProviderSelection | undefined
    const actions = this.selection.actions()
    if (base?.searchProvider === target) actions.resetField('searchProvider')
    else actions.edit('searchProvider', target)
  }

  /**
   * Write this card's namespace, then the selection that starts using it. A
   * refused section stops the selection from saving and keeps every remaining
   * draft for correction.
   * @param id - provider whose card saves.
   * @returns settlement after every attempted write.
   */
  private async save(id: WebSearchProviderId): Promise<void> {
    const pane = this.panes[id]
    const state = this.projection(id)
    if (!state.available || state.invalid || state.saving) return
    if (pane.form.shell().dirty) await pane.form.save()
    if (pane.form.shell().failed) return
    if (this.selection.shell().dirty) await this.selection.save()
  }

  /**
   * Write the staged key, then re-read whether the Host now holds one.
   * @param id - provider whose key is staged.
   * @param value - the staged credential literal.
   * @returns whether the Host reports a configured credential afterwards.
   */
  private async writeKey(id: WebSearchProviderId, value: string): Promise<boolean> {
    await this.ctx.remote.credentials.set(this.currentRef(id), value)
    await this.readCredential(id)
    return this.panes[id].credential.configured
  }

  /**
   * The reference a provider's section names, or the provider's own key.
   * @param id - provider to resolve.
   * @returns the reference to address.
   */
  private currentRef(id: WebSearchProviderId): string {
    const snapshot = this.scopes[id].getSnapshot() as SettingsFormScopeSnapshot<{ apiKeyEnv?: string }>
    const declared = snapshot.value?.apiKeyEnv
    return declared !== undefined && declared.length > 0 ? declared : PROVIDERS[id].credentialRef
  }

  /**
   * Ask the credentials domain about the reference the provider currently names.
   *
   * The answer is tagged with the reference it describes: `apiKeyEnv` can
   * change between the request and its response, and two reads can settle out
   * of order, so an answer is published only while it is still the latest one
   * and still answers for the reference in force.
   * @param id - provider whose key to read.
   * @returns settlement after the answer is applied or dropped.
   */
  private async readCredential(id: WebSearchProviderId): Promise<void> {
    const pane = this.panes[id]
    const ref = this.currentRef(id)
    const generation = ++pane.generation
    if (ref !== pane.credential.ref) {
      // A new reference knows nothing yet; keeping the old answer would claim
      // the key is configured under a name nobody has checked.
      pane.credential = { ref, configured: false, writable: true }
      this.publish()
    }
    const response = await this.ctx.remote.credentials.describe([ref])
    if (generation !== pane.generation || ref !== this.currentRef(id)) return
    if (!response.ok) return
    const info = response.value[ref]
    // An answer that carries no entry for the requested reference describes
    // another one; claiming it would report a state nobody asked for.
    if (info === undefined) return
    if (info.configured === pane.credential.configured && info.writable === pane.credential.writable) return
    pane.credential = { ref, configured: info.configured, writable: info.writable }
    this.publish()
  }

  /** Release every form subscription and staged draft. */
  dispose(): void {
    for (const off of this.unsubscribe) off()
    this.selection.dispose()
    for (const id of WEB_SEARCH_PROVIDER_IDS) this.panes[id].form.dispose()
  }
}

/**
 * The provider a card's switch selects when it is turned off.
 * @param id - provider whose card changed.
 * @returns the other provider id.
 */
function otherProvider(id: WebSearchProviderId): WebSearchProviderId {
  return id === 'exa' ? 'brave' : 'exa'
}
