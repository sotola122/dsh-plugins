/**
 * Sign in to GitHub Copilot through the OAuth flow the installed `llm-pi-ai`
 * adapter registers for its `github-copilot` catalog provider, and drive that
 * flow from `/copilot-*` commands.
 *
 * The plugin never registers a flow of its own: it calls `ctx.authorization.begin`
 * for the `llm-pi-ai/github-copilot` record, so the pi-ai adapter stays the only
 * writer of the credential and pi-ai keeps refreshing it inside the credential store.
 *
 * The Copilot grant asks one enterprise-domain question, reports a verification
 * URL and a user code, then polls. A command result cannot be streamed, so
 * `/copilot-login` answers that question from its argument, waits for the first
 * device notice, prints it, and lets the polling continue in the background.
 * @module @anago-harness/copilot-oauth
 */

import type { Context } from '@deepseek-ai/cordis'
import { AuthorizationError } from '@deepseek-ai/dsh-authorization'
import type {
  AuthorizationInteraction, AuthorizationNotice, AuthorizationPrompt,
} from '@deepseek-ai/dsh-authorization'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'

/** Plugin name used by the profile patch row. */
export const name = 'copilot-oauth'

/** Host services this plugin drives. */
export const inject = ['authorization', 'commands', 'credentials']

/** The record the pi-ai GitHub Copilot flow commits. */
const KEY: CredentialKey = credentialKey('llm-pi-ai', 'github-copilot')

/** The method id `llm-pi-ai` registers for the Copilot device-code flow. */
const METHOD = 'oauth'

const USAGE_STATUS = 'Usage: /copilot-status (no arguments)'
const USAGE_LOGOUT = 'Usage: /copilot-logout (no arguments)'
const USAGE_CANCEL = 'Usage: /copilot-cancel (no arguments)'

const MISSING_FLOW = 'This installation registers no GitHub Copilot OAuth flow '
  + '(llm-pi-ai offers none for github-copilot). This plugin registers no flow of its own.'

/** Where one sign-in attempt stands; only `failed` carries text. */
type Phase =
  | { readonly status: 'signing-in' }
  | { readonly status: 'authorized' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly failure: string }

/** One sign-in attempt this plugin started and the notices it produced. */
interface Attempt {
  readonly controller: AbortController
  readonly notices: AuthorizationNotice[]
  phase: Phase
  /** Epoch milliseconds when `/copilot-login` started this attempt. */
  readonly started: number
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
    return `Sign in to GitHub Copilot at ${notice.url} and enter code ${notice.code}.`
  }
  if (notice.url !== undefined) return `Sign in to GitHub Copilot at ${notice.url}.`
  return `Enter code ${String(notice.code)} on the GitHub Copilot verification page.`
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
        return 'Another GitHub Copilot sign-in is already running. Wait for it, or stop it with /copilot-cancel.'
      case 'NO_FLOW':
        return 'This installation registers no GitHub Copilot OAuth flow '
          + '(the llm-pi-ai github-copilot provider is absent).'
      case 'UNKNOWN_METHOD':
        return 'The GitHub Copilot flow no longer offers its OAuth method.'
      case 'NOT_COMMITTED':
        return 'The GitHub Copilot flow finished without storing a credential; try again.'
      default:
        return `GitHub Copilot sign-in failed: ${error.message} (${error.code}).`
    }
  }
  const detail = error instanceof Error ? error.message : String(error)
  return `GitHub Copilot sign-in failed: ${detail}.`
}

/**
 * Answer the flow's one question from the login argument.
 *
 * The answer is the trimmed enterprise URL, or `''` for github.com. It is
 * returned to the flow and never written to the logger. A `select` whose
 * options do not name that argument is rejected: this command has no chooser.
 * @param prompt - the question the flow asked.
 * @param enterprise - the trimmed `/copilot-login` argument.
 * @returns the answer the flow continues with.
 */
function answerPrompt(prompt: AuthorizationPrompt, enterprise: string): Promise<string> {
  if (prompt.kind === 'text' || prompt.kind === 'secret') return Promise.resolve(enterprise)
  const match = prompt.options.find(option => option.id === enterprise || option.label === enterprise)
  if (match !== undefined) return Promise.resolve(match.id)
  const listed = prompt.options.map(option => `${option.id} (${option.label})`).join(', ')
  return Promise.reject(new Error(
    `This command cannot show an interactive chooser for "${prompt.message}". Options: ${listed}.`,
  ))
}

/**
 * Register the `/copilot-*` commands.
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

  /** Hold the Agent for one command, so an idle release cannot dispose it mid-command. */
  const heldCommand = (
    handler: (invocation: CommandInvocation) => Promise<CommandResult> | CommandResult,
  ): ((invocation: CommandInvocation) => Promise<CommandResult>) => {
    return async (invocation) => {
      const hold = ctx.get('agents')?.hold(invocation.agent)
      try { return await handler(invocation) } finally { hold?.[Symbol.dispose]() }
    }
  }

  const login = async (invocation: CommandInvocation): Promise<CommandResult> => {
    if (ctx.authorization.describe(KEY) === undefined) return { kind: 'error', text: MISSING_FLOW }
    if (attempt?.phase.status === 'signing-in') {
      const device = deviceNotice(attempt.notices)
      return {
        kind: 'error',
        text: [
          'A GitHub Copilot sign-in is already running. Finish it in the browser, or run /copilot-cancel first.',
          ...device === undefined ? [] : noticeLines(device),
        ].join('\n'),
      }
    }

    const enterprise = invocation.rawInput.trim()
    const controller = new AbortController()
    const notices: AuthorizationNotice[] = []
    const first = Promise.withResolvers<void>()
    const state: Attempt = {
      controller, notices, phase: { status: 'signing-in' }, started: Date.now(),
    }
    attempt = state

    const interaction: AuthorizationInteraction = {
      notify(notice) {
        notices.push(notice)
        if (notice.url !== undefined || notice.code !== undefined) first.resolve()
      },
      prompt(prompt: AuthorizationPrompt): Promise<string> {
        return answerPrompt(prompt, enterprise)
      },
    }

    void (async () => {
      try {
        const outcome = await ctx.authorization.begin({
          key: KEY, method: METHOD, interaction, signal: controller.signal,
        })
        state.phase = { status: outcome.status }
        if (outcome.status === 'authorized') ctx.logger.info('copilot-oauth: signed in to GitHub Copilot')
        else ctx.logger.info('copilot-oauth: GitHub Copilot sign-in was cancelled')
      } catch (error: unknown) {
        state.phase = controller.signal.aborted
          ? { status: 'cancelled' }
          : { status: 'failed', failure: failureText(error) }
        if (state.phase.status === 'failed') ctx.logger.warn(`copilot-oauth: ${state.phase.failure}`)
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
      return { kind: 'error', text: 'GitHub Copilot sign-in cancelled.' }
    }
    if (state.phase.status === 'failed') return { kind: 'error', text: state.phase.failure }
    if (state.phase.status === 'cancelled') return { kind: 'error', text: 'GitHub Copilot sign-in cancelled.' }
    if (state.phase.status === 'authorized') {
      return { kind: 'success', text: 'Signed in to GitHub Copilot; the llm-pi-ai/github-copilot credential is stored.' }
    }

    const device = deviceNotice(notices)
    /* v8 ignore next -- unreachable: a signing-in attempt that passed the race always carries a device notice */
    if (device === undefined) {
      return { kind: 'success', text: 'Signing in to GitHub Copilot. Run /copilot-status to follow the flow.' }
    }
    return {
      kind: 'success',
      text: [
        deviceHeadline(device),
        device.message,
        'Approve the request in your browser. The flow keeps polling; run /copilot-status to check, or /copilot-cancel to stop.',
      ].join('\n'),
    }
  }

  const status = async (invocation: CommandInvocation): Promise<CommandResult> => {
    if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE_STATUS }
    const info = await ctx.credentials.describeRecord(KEY)
    const pending = attempt?.phase.status === 'signing-in' ? deviceNotice(attempt.notices) : undefined
    const lines = [
      ...pending === undefined ? [] : [deviceHeadline(pending)],
      info.configured ? 'Signed in to GitHub Copilot.' : 'Not signed in to GitHub Copilot.',
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
    if (!info.configured) return { kind: 'success', text: 'Not signed in to GitHub Copilot; nothing to remove.' }
    await ctx.credentials.deleteRecord(KEY)
    return { kind: 'success', text: 'Signed out of GitHub Copilot (removed the llm-pi-ai/github-copilot credential).' }
  }

  const cancel = (invocation: CommandInvocation): CommandResult => {
    if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE_CANCEL }
    if (attempt?.phase.status !== 'signing-in') return { kind: 'success', text: 'No GitHub Copilot sign-in is running.' }
    attempt.controller.abort()
    ctx.authorization.cancel(KEY)
    return { kind: 'success', text: 'Cancelling the GitHub Copilot sign-in.' }
  }

  ctx.effect(() => ctx.commands.register({
    name: 'copilot-login',
    description: 'Sign in to GitHub Copilot with the stored OAuth credential.',
    handler: heldCommand(login),
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'copilot-status',
    description: 'Show the GitHub Copilot sign-in state and the pending sign-in instructions.',
    handler: heldCommand(status),
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'copilot-logout',
    description: 'Remove the stored GitHub Copilot OAuth credential.',
    handler: heldCommand(logout),
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'copilot-cancel',
    description: 'Cancel a running GitHub Copilot sign-in.',
    handler: heldCommand(cancel),
  }))
}
