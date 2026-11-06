/**
 * Sign in to xAI (SuperGrok / X Premium) through the OAuth flow the installed
 * `llm-pi-ai` adapter registers for its `xai` catalog provider, and drive that
 * flow from `/xai-*` commands.
 *
 * The plugin never registers a flow of its own: it calls `ctx.authorization.begin`
 * for the `llm-pi-ai/xai` record, so the pi-ai adapter stays the only writer of
 * the credential and pi-ai keeps refreshing it inside the credential store.
 *
 * The xAI flow is a device-code grant: it reports a verification URL and a user
 * code, then polls. A command result cannot be streamed, so `/xai-login` waits
 * for that first device notice, prints it, and lets the polling continue in the
 * background; `/xai-status` re-prints the pending URL and code, and
 * `/xai-cancel` withdraws the attempt.
 * @module @anago-harness/xai-oauth
 */

import type { Context } from '@deepseek-ai/cordis'
import { AuthorizationError } from '@deepseek-ai/dsh-authorization'
import type {
  AuthorizationInteraction, AuthorizationNotice, AuthorizationPrompt,
} from '@deepseek-ai/dsh-authorization'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'

/** Plugin name used by the profile patch row. */
export const name = 'xai-oauth'

/** Host services this plugin drives. */
export const inject = ['authorization', 'commands', 'credentials']

/** The record the pi-ai xAI flow commits. */
const KEY: CredentialKey = credentialKey('llm-pi-ai', 'xai')

/** The method id `llm-pi-ai` registers for the xAI device-code flow. */
const METHOD = 'oauth'

const USAGE_LOGIN = 'Usage: /xai-login (no arguments)'
const USAGE_STATUS = 'Usage: /xai-status (no arguments)'
const USAGE_LOGOUT = 'Usage: /xai-logout (no arguments)'
const USAGE_CANCEL = 'Usage: /xai-cancel (no arguments)'

/** Where one sign-in attempt stands; only `failed` carries text. */
type Phase =
  | { readonly status: 'signing-in' }
  | { readonly status: 'authorized' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly failure: string }

/** One sign-in attempt this plugin started and the notices it produced. */
/* jscpd:ignore-start -- xai-oauth mirrors copilot-oauth's device-code command flow. */
interface Attempt {
  readonly controller: AbortController
  readonly notices: AuthorizationNotice[]
  phase: Phase
}

/** Render the page and code a notice carries as separate lines. */
function noticeLines(notice: AuthorizationNotice): string[] {
  const lines = [notice.message]
  if (notice.url !== undefined) lines.push(`Open: ${notice.url}`)
  if (notice.code !== undefined) lines.push(`Code: ${notice.code}`)
  return lines
}

/**
 * One line naming everything the human must act on.
 *
 * A compact surface shows only the first line of a command result, so the page
 * and code lead instead of following a summary sentence.
 */
function deviceHeadline(notice: AuthorizationNotice): string {
  if (notice.url !== undefined && notice.code !== undefined) {
    return `Sign in to xAI at ${notice.url} and enter code ${notice.code}.`
  }
  if (notice.url !== undefined) return `Sign in to xAI at ${notice.url}.`
  return `Enter code ${String(notice.code)} on the xAI verification page.`
}

/** The latest notice carrying a page or code, which is the device-code grant. */
function deviceNotice(notices: readonly AuthorizationNotice[]): AuthorizationNotice | undefined {
  let found: AuthorizationNotice | undefined
  for (const notice of notices) {
    if (notice.url !== undefined || notice.code !== undefined) found = notice
  }
  return found
}

/** Human text for a failed attempt, without the credential value. */
function failureText(error: unknown): string {
  if (error instanceof AuthorizationError) {
    switch (error.code) {
      case 'ALREADY_IN_FLIGHT':
        return 'Another xAI sign-in is already running. Wait for it, or stop it with /xai-cancel.'
      case 'NO_FLOW':
        return 'This installation registers no xAI OAuth flow (the llm-pi-ai xai provider is absent).'
      case 'UNKNOWN_METHOD':
        return 'The xAI flow no longer offers its OAuth method.'
      case 'NOT_COMMITTED':
        return 'The xAI flow finished without storing a credential; try again.'
      default:
        return `xAI sign-in failed: ${error.message} (${error.code}).`
    }
  }
  return `xAI sign-in failed: ${error instanceof Error ? error.message : String(error)}.`
}

/**
 * Register the `/xai-*` commands.
 * @param ctx - context carrying authorization, commands, and credentials.
 */
export function apply(ctx: Context): void {
  let attempt: Attempt | undefined

  ctx.effect(() => () => {
    attempt?.controller.abort()
    ctx.authorization.cancel(KEY)
  })

  /** Report one attempt's outcome without touching the record's value. */
  const describeAttempt = (): string[] => {
    if (attempt === undefined) return []
    const phase = attempt.phase
    const lines = [`Sign-in: ${phase.status}.`]
    if (phase.status === 'failed') lines.push(phase.failure)
    if (phase.status === 'signing-in') {
      const device = deviceNotice(attempt.notices)
      if (device !== undefined) lines.push(...noticeLines(device))
    }
    return lines
  }

  const login = async (invocation: CommandInvocation): Promise<CommandResult> => {
    if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE_LOGIN }
    if (attempt?.phase.status === 'signing-in') {
      const device = deviceNotice(attempt.notices)
      return {
        kind: 'error',
        text: [
          'An xAI sign-in is already running. Finish it in the browser, or run /xai-cancel first.',
          ...device === undefined ? [] : noticeLines(device),
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
        if (notice.url !== undefined || notice.code !== undefined) first.resolve()
      },
      prompt(_prompt: AuthorizationPrompt): Promise<string> {
        // The xAI device flow asks no questions; a flow that did would need a
        // surface this command cannot provide, so fail rather than hang.
        return Promise.reject(new Error('the xAI flow requested interactive input this command cannot show'))
      },
    }

    void (async () => {
      try {
        const outcome = await ctx.authorization.begin({
          key: KEY, method: METHOD, interaction, signal: controller.signal,
        })
        state.phase = { status: outcome.status }
        if (outcome.status === 'authorized') ctx.logger.info('xai-oauth: signed in to xAI')
        else ctx.logger.info('xai-oauth: xAI sign-in was cancelled')
      } catch (error: unknown) {
        state.phase = controller.signal.aborted
          ? { status: 'cancelled' }
          : { status: 'failed', failure: failureText(error) }
        if (state.phase.status === 'failed') ctx.logger.warn(`xai-oauth: ${state.phase.failure}`)
      } finally {
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
      controller.abort()
      ctx.authorization.cancel(KEY)
      return { kind: 'error', text: 'xAI sign-in cancelled.' }
    }
    if (state.phase.status === 'failed') return { kind: 'error', text: state.phase.failure }
    if (state.phase.status === 'cancelled') return { kind: 'error', text: 'xAI sign-in cancelled.' }
    if (state.phase.status === 'authorized') {
      return { kind: 'success', text: 'Signed in to xAI; the llm-pi-ai/xai credential is stored.' }
    }

    const device = deviceNotice(notices)
    /* v8 ignore next -- unreachable: a signing-in attempt that passed the race always carries a device notice */
    if (device === undefined) return { kind: 'success', text: 'Signing in to xAI. Run /xai-status to follow the flow.' }
    return {
      kind: 'success',
      text: [
        deviceHeadline(device),
        device.message,
        'Approve the request in your browser. The flow keeps polling; run /xai-status to check, or /xai-cancel to stop.',
      ].join('\n'),
    }
  }

  const status = async (invocation: CommandInvocation): Promise<CommandResult> => {
    if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE_STATUS }
    const info = await ctx.credentials.describeRecord(KEY)
    const state = attempt?.phase.status === 'signing-in' ? deviceNotice(attempt.notices) : undefined
    const lines = [
      ...state === undefined ? [] : [deviceHeadline(state)],
      info.configured ? 'Signed in to xAI.' : 'Not signed in to xAI.',
      ...describeAttempt(),
    ]
    return { kind: 'success', text: lines.join('\n') }
  }

  const logout = async (invocation: CommandInvocation): Promise<CommandResult> => {
    if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE_LOGOUT }
    attempt?.controller.abort()
    ctx.authorization.cancel(KEY)
    attempt = undefined
    const info = await ctx.credentials.describeRecord(KEY)
    if (!info.configured) return { kind: 'success', text: 'Not signed in to xAI; nothing to remove.' }
    /* jscpd:ignore-end */
    await ctx.credentials.deleteRecord(KEY)
    return { kind: 'success', text: 'Signed out of xAI (removed the llm-pi-ai/xai credential).' }
  }

  const cancel = (invocation: CommandInvocation): CommandResult => {
    if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE_CANCEL }
    if (attempt?.phase.status !== 'signing-in') return { kind: 'success', text: 'No xAI sign-in is running.' }
    attempt.controller.abort()
    ctx.authorization.cancel(KEY)
    return { kind: 'success', text: 'Cancelling the xAI sign-in.' }
  }

  ctx.effect(() => ctx.commands.register({
    name: 'xai-login',
    description: 'Sign in to xAI (SuperGrok / X Premium) with the stored OAuth credential.',
    handler: login,
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'xai-status',
    description: 'Show the xAI sign-in state and the pending sign-in instructions.',
    handler: status,
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'xai-logout',
    description: 'Remove the stored xAI OAuth credential.',
    handler: logout,
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'xai-cancel',
    description: 'Cancel a running xAI sign-in.',
    handler: cancel,
  }))
}
