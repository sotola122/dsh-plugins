/**
 * Sign in to OpenAI Codex (ChatGPT Plus/Pro) through the OAuth flow the
 * installed `llm-pi-ai` adapter registers for its `openai-codex` catalog
 * provider, and drive that flow from `/codex-*` commands.
 *
 * The plugin never registers a flow of its own and never writes the credential:
 * it calls `ctx.authorization.begin` for the `llm-pi-ai/openai-codex` record, so
 * the pi-ai adapter stays the only writer and pi-ai keeps refreshing it inside
 * the credential store.
 *
 * The flow asks which login method to use, then opens a browser callback and a
 * paste prompt. This plugin always answers `browser` (never device code). A
 * command result cannot be streamed and cannot answer a question later, so
 * `/codex-login` returns once the authorization URL is known, and `/codex-code`
 * answers the parked paste. The login result also prints an SSH local forward:
 * the callback listens on this host's loopback, so a browser on another machine
 * reaches it only through that forward. `/codex-status` reprints the forward
 * while signing in.
 * @module @anago-harness/openai-codex-oauth
 */

import type { Context } from '@deepseek-ai/cordis'
import { AuthorizationDeclinedError, AuthorizationError } from '@deepseek-ai/dsh-authorization'
import type {
  AuthorizationInteraction, AuthorizationNotice, AuthorizationPrompt,
} from '@deepseek-ai/dsh-authorization'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { currentSshLocalForwardCommand } from './port-forward.ts'

/** Plugin name used by the profile patch row. */
export const name = 'openai-codex-oauth'

/** Host services this plugin drives. */
export const inject = ['authorization', 'commands', 'credentials']

/** The record the pi-ai OpenAI Codex flow commits. */
const KEY: CredentialKey = credentialKey('llm-pi-ai', 'openai-codex')

/** The method id `llm-pi-ai` registers for the OpenAI Codex OAuth flow. */
const METHOD = 'oauth'

/** The option id pi-ai uses for browser login. Device code is never chosen. */
const BROWSER = 'browser'

const USAGE_LOGIN = 'Usage: /codex-login (no arguments)'
const USAGE_CODE = 'Usage: /codex-code <authorization code or redirect URL>'
const USAGE_STATUS = 'Usage: /codex-status (no arguments)'
const USAGE_LOGOUT = 'Usage: /codex-logout (no arguments)'
const USAGE_CANCEL = 'Usage: /codex-cancel (no arguments)'

const NOT_RUNNING = 'No OpenAI Codex sign-in is running.'
const CANCELLED = 'OpenAI Codex sign-in cancelled.'
const SIGNED_IN = 'Signed in to OpenAI Codex; the llm-pi-ai/openai-codex credential is stored.'

/** Where one sign-in attempt stands; only `failed` carries text. */
type Phase =
  | { readonly status: 'signing-in' }
  | { readonly status: 'authorized' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly failure: string }

/** One authorization page the flow told the human to open. */
interface Page {
  readonly url: string
  readonly message: string
}

/** One sign-in attempt this plugin started and the notices it produced. */
interface Attempt {
  readonly controller: AbortController
  readonly notices: AuthorizationNotice[]
  phase: Phase
}

/** The single paste the flow is waiting on, if it asked. */
interface PendingPaste {
  readonly resolve: (value: string) => void
  readonly reject: (error: Error) => void
  readonly signal: AbortSignal | undefined
  readonly onAbort: () => void
}

/* jscpd:ignore-start -- mirrors the sibling OAuth command lifecycle; the browser paste prompt is the difference. */

/** The latest notice that carries a page. */
function latestPage(notices: readonly AuthorizationNotice[]): Page | undefined {
  let found: Page | undefined
  for (const notice of notices) {
    if (notice.url !== undefined) found = { url: notice.url, message: notice.message }
  }
  return found
}

/** One line a compact surface can show on its own. */
function headline(url: string): string {
  return `Sign in to OpenAI Codex at ${url}.`
}

/** The page and the instruction that pointed at it, as separate lines. */
function pageLines(page: Page): string[] {
  return [page.message, `Open: ${page.url}`]
}

/**
 * The remote-browser forward, lead then command.
 *
 * A signing-in `/codex-status` prints these two lines alone. `/codex-login`
 * prefixes the lead with the in-browser instruction.
 * @returns the lead and the copy-pasteable `ssh -N -L` command.
 */
function forwardLines(): readonly [string, string] {
  return ['From another machine, forward the callback port first:', currentSshLocalForwardCommand()]
}

/** What `/codex-login` prints once the flow has a page for the human. */
function loginText(page: Page): string {
  const [lead, command] = forwardLines()
  return [
    headline(page.url),
    ...pageLines(page),
    `Finish in this browser to sign in automatically. ${lead}`,
    command,
    'If the browser cannot reach the callback (port 1455 is already taken by the Codex CLI), paste what the browser shows with /codex-code <value>.',
  ].join('\n')
}

/** Human text for a failed attempt, without the credential value. */
function failureText(error: unknown): string {
  if (error instanceof AuthorizationError) {
    switch (error.code) {
      case 'ALREADY_IN_FLIGHT':
        return 'Another OpenAI Codex sign-in is already running. Wait for it, or stop it with /codex-cancel.'
      case 'NO_FLOW':
        return 'This installation registers no OpenAI Codex OAuth flow (the llm-pi-ai openai-codex provider is absent).'
      case 'UNKNOWN_METHOD':
        return 'The OpenAI Codex flow no longer offers its OAuth method.'
      case 'NOT_COMMITTED':
        return 'The OpenAI Codex flow finished without storing a credential; try again.'
      default:
        return `OpenAI Codex sign-in failed: ${error.message} (${error.code}).`
    }
  }
  const detail = error instanceof Error ? error.message : String(error)
  return `OpenAI Codex sign-in failed: ${detail}.`
}

/**
 * Register the `/codex-*` commands.
 *
 * `/codex-login` answers the flow's method question with `browser` and returns
 * when the authorization URL is known. `/codex-code` resolves the single parked
 * paste. A paste withdrawn by its own signal — the browser callback won — is
 * rejected with a plain error, not {@link AuthorizationDeclinedError}, so the
 * seam does not record a human decline.
 * @param ctx - context carrying authorization, commands, and credentials.
 */
export function apply(ctx: Context): void {
  let attempt: Attempt | undefined
  let pending: PendingPaste | undefined

  /** Take the parked paste, if any, and stop listening for its signal. */
  const takePaste = (): PendingPaste | undefined => {
    const current = pending
    if (current === undefined) return undefined
    pending = undefined
    if (current.signal !== undefined) current.signal.removeEventListener('abort', current.onAbort)
    return current
  }

  /**
   * Reject a paste the flow asked for.
   *
   * The attached handler keeps a caller that has already moved on from turning
   * the rejection into an unhandled rejection. The returned promise still rejects.
   * @param reason - why this paste will not be answered.
   * @returns a rejection the flow observes.
   */
  const rejectPaste = (reason: string): Promise<string> => {
    const rejected = Promise.reject<string>(new Error(reason))
    void rejected.catch(() => undefined)
    return rejected
  }

  /** Reject and drop the parked paste. A missing paste is not an error. */
  const dropPaste = (reason: string): void => {
    const current = takePaste()
    if (current === undefined) return
    current.reject(new Error(reason))
  }

  /** Abort the attempt, release the key, and settle a parked paste. */
  const withdraw = (): void => {
    attempt?.controller.abort()
    dropPaste('the OpenAI Codex sign-in was withdrawn')
    ctx.authorization.cancel(KEY)
  }

  ctx.effect(() => withdraw)

  /**
   * Park the flow's one paste prompt.
   *
   * A second prompt is rejected so the first answer still has somewhere to go.
   * An already-aborted signal, or one that fires later, rejects with a plain
   * error: that abort is the browser callback winning the race, not the human
   * declining.
   * @param prompt - the text or secret question the flow asked.
   * @returns the trimmed value `/codex-code` submits.
   */
  const parkPaste = (prompt: AuthorizationPrompt): Promise<string> => {
    if (pending !== undefined) return rejectPaste('another OpenAI Codex paste prompt is already waiting')
    if (prompt.signal?.aborted === true) return rejectPaste('the OpenAI Codex paste prompt was withdrawn')
    const promise = new Promise<string>((resolve, reject) => {
      const onAbort = (): void => { dropPaste('the OpenAI Codex paste prompt was withdrawn') }
      pending = { resolve, reject, signal: prompt.signal, onAbort }
      if (prompt.signal !== undefined) prompt.signal.addEventListener('abort', onAbort, { once: true })
    })
    // The flow awaits this. The extra handler only covers a paste dropped after
    // the attempt ended, which would otherwise be an unhandled rejection.
    void promise.catch(() => undefined)
    return promise
  }

  /** Answer the method question with browser, and park every other question. */
  const answerPrompt = (prompt: AuthorizationPrompt): Promise<string> => {
    if (prompt.kind === 'select') {
      const browser = prompt.options.find(option => option.id === BROWSER)
      if (browser === undefined) {
        return Promise.reject(new AuthorizationDeclinedError(
          'The OpenAI Codex flow offers no browser login. This command does not use device-code login.',
        ))
      }
      return Promise.resolve(browser.id)
    }
    return parkPaste(prompt)
  }

  /** Report one attempt's outcome without touching the record's value. */
  const describeAttempt = (): string[] => {
    if (attempt === undefined) return []
    const phase = attempt.phase
    const lines = [`Sign-in: ${phase.status}.`]
    if (phase.status === 'failed') lines.push(phase.failure)
    if (phase.status === 'signing-in') {
      const page = latestPage(attempt.notices)
      if (page !== undefined) lines.push(...pageLines(page))
    }
    return lines
  }

  /** Whether `/codex-code` currently has a prompt to fill. */
  const pasteLine = (): string => pending === undefined
    ? 'Paste: not expected.'
    : 'Paste: expected. Submit it with /codex-code <value>.'

  const login = async (invocation: CommandInvocation): Promise<CommandResult> => {
    if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE_LOGIN }
    if (attempt?.phase.status === 'signing-in') {
      const page = latestPage(attempt.notices)
      return {
        kind: 'error',
        text: [
          'An OpenAI Codex sign-in is already running. Finish it in the browser, or run /codex-cancel first.',
          ...page === undefined ? [] : pageLines(page),
        ].join('\n'),
      }
    }

    const controller = new AbortController()
    const notices: AuthorizationNotice[] = []
    const first = Promise.withResolvers<void>()
    const state: Attempt = { controller, notices, phase: { status: 'signing-in' } }
    attempt = state

    const interaction: AuthorizationInteraction = {
      notify(notice) {
        notices.push(notice)
        if (notice.url !== undefined) first.resolve()
      },
      prompt: answerPrompt,
    }

    void (async () => {
      try {
        const outcome = await ctx.authorization.begin({
          key: KEY, method: METHOD, interaction, signal: controller.signal,
        })
        state.phase = { status: outcome.status }
        if (outcome.status === 'authorized') ctx.logger.info('openai-codex-oauth: signed in to OpenAI Codex')
        else ctx.logger.info('openai-codex-oauth: OpenAI Codex sign-in was cancelled')
      } catch (error: unknown) {
        state.phase = controller.signal.aborted
          ? { status: 'cancelled' }
          : { status: 'failed', failure: failureText(error) }
        if (state.phase.status === 'failed') ctx.logger.warn(`openai-codex-oauth: ${state.phase.failure}`)
      } finally {
        // The flow is done with the question. Drop a paste it never consumed
        // so a later /codex-code cannot answer an attempt that already ended.
        dropPaste('the OpenAI Codex sign-in was withdrawn')
        first.resolve()
      }
    })()

    const withdrawn = Promise.withResolvers<void>()
    const onAbort = (): void => { withdrawn.resolve() }
    if (invocation.signal.aborted) onAbort()
    else invocation.signal.addEventListener('abort', onAbort, { once: true })
    await Promise.race([first.promise, withdrawn.promise])
    invocation.signal.removeEventListener('abort', onAbort)

    if (invocation.signal.aborted) {
      withdraw()
      return { kind: 'error', text: CANCELLED }
    }
    if (state.phase.status === 'failed') return { kind: 'error', text: state.phase.failure }
    if (state.phase.status === 'cancelled') return { kind: 'error', text: CANCELLED }
    if (state.phase.status === 'authorized') return { kind: 'success', text: SIGNED_IN }

    const page = latestPage(notices)
    /* v8 ignore next -- unreachable: the race resolves on a URL notice or a terminal phase, so a signing-in return always has a page */
    if (page === undefined) return { kind: 'success', text: 'Signing in to OpenAI Codex. Run /codex-status to follow the flow.' }
    return { kind: 'success', text: loginText(page) }
  }

  const code = (invocation: CommandInvocation): CommandResult => {
    const value = invocation.rawInput.trim()
    if (value.length === 0) return { kind: 'error', text: USAGE_CODE }
    if (attempt?.phase.status !== 'signing-in') return { kind: 'error', text: NOT_RUNNING }
    const current = takePaste()
    if (current === undefined) {
      return {
        kind: 'error',
        text: 'No OpenAI Codex paste is expected. Finish in the browser, or start again with /codex-login.',
      }
    }
    current.resolve(value)
    return { kind: 'success', text: 'Submitted the value to the OpenAI Codex sign-in. Run /codex-status to check.' }
  }

  const status = async (invocation: CommandInvocation): Promise<CommandResult> => {
    if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE_STATUS }
    const info = await ctx.credentials.describeRecord(KEY)
    const page = attempt?.phase.status === 'signing-in' ? latestPage(attempt.notices) : undefined
    const lines = [
      ...page === undefined ? [] : [headline(page.url)],
      info.configured ? 'Signed in to OpenAI Codex.' : 'Not signed in to OpenAI Codex.',
      ...describeAttempt(),
      pasteLine(),
      ...attempt?.phase.status === 'signing-in' ? forwardLines() : [],
    ]
    return { kind: 'success', text: lines.join('\n') }
  }

  const logout = async (invocation: CommandInvocation): Promise<CommandResult> => {
    if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE_LOGOUT }
    withdraw()
    attempt = undefined
    const info = await ctx.credentials.describeRecord(KEY)
    if (!info.configured) return { kind: 'success', text: 'Not signed in to OpenAI Codex; nothing to remove.' }
    await ctx.credentials.deleteRecord(KEY)
    return { kind: 'success', text: 'Signed out of OpenAI Codex (removed the llm-pi-ai/openai-codex credential).' }
  }

  const cancel = (invocation: CommandInvocation): CommandResult => {
    if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE_CANCEL }
    if (attempt?.phase.status !== 'signing-in') return { kind: 'success', text: NOT_RUNNING }
    withdraw()
    return { kind: 'success', text: 'Cancelling the OpenAI Codex sign-in.' }
  }

  ctx.effect(() => ctx.commands.register({
    name: 'codex-login',
    description: 'Sign in to OpenAI Codex (ChatGPT Plus/Pro) with the stored OAuth credential.',
    handler: login,
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'codex-code',
    description: 'Submit an authorization code or redirect URL for a pending OpenAI Codex sign-in.',
    handler: code,
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'codex-status',
    description: 'Show the OpenAI Codex sign-in state, the pending authorization URL, and whether a paste is expected.',
    handler: status,
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'codex-logout',
    description: 'Remove the stored OpenAI Codex OAuth credential.',
    handler: logout,
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'codex-cancel',
    description: 'Cancel a running OpenAI Codex sign-in.',
    handler: cancel,
  }))
}
/* jscpd:ignore-end */
