import { describe, expect, it } from 'vitest'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import {
  apply, Config, name, RESPONSE_LANGUAGE_CONTEXT, RESPONSE_LANGUAGE_ORDER_OFFSET, RESPONSE_LANGUAGE_REMINDER,
  RESPONSE_LANGUAGE_SECTION, RESPONSE_LANGUAGE_TEXT, responseLanguageReminder, responseLanguageText,
} from '../src/index.ts'

interface PromptSection {
  name: string
  order: number
  interpolate: boolean
  required?: boolean
  text: (context: AssembleContext) => string
}

function fakeContext(sections: PromptSection[], contexts: PromptSection[] = []): Context {
  return {
    systemPrompt: {
      section: (section: PromptSection) => { sections.push(section); return () => {} },
      context: (context: PromptSection) => { contexts.push(context); return () => {} },
      getSectionOrder: (order: string) => order === 'DEPLOYMENT_PERSONA_SUFFIX' ? 10_200 : 0,
      getContextOrder: (order: string) => order === 'WEB_SURFACE' ? 10_100 : 0,
    },
  } as Context
}

/** A switch object a test can move; the loader supplies the writable form in production. */
function switchFor(initial: boolean): Volatile<boolean> & { set(value: boolean): void } {
  let value = initial
  return { get: () => value, set: (next: boolean) => { value = next } }
}

/**
 * Type one hand-built assembly as the value the prompt registry passes.
 *
 * The section reads only `agent.session.header.delegationDepth`, so a test
 * supplies just that chain rather than a whole live `Session`.
 * @param value - the assembly double.
 * @returns the same value, typed as the assembly context.
 */
function assemblyWith(value: object): AssembleContext {
  return value
}

const mainAgent = assemblyWith({ agent: { session: { header: undefined } } })
const shallowAgent = assemblyWith({ agent: { session: {} } })
const childAgent = assemblyWith({ agent: { session: { header: { delegationDepth: 1 } } } })

describe('response-language', () => {
  it('declares a stable row name and prompt position', () => {
    expect(name).toBe('response-language')
    expect(RESPONSE_LANGUAGE_SECTION).toBe('response-language')
    expect(RESPONSE_LANGUAGE_ORDER_OFFSET).toBe(1)
  })

  it('contributes the instruction to main agents only', () => {
    expect(responseLanguageText(mainAgent)).toBe(RESPONSE_LANGUAGE_TEXT)
    expect(responseLanguageText(shallowAgent)).toBe(RESPONSE_LANGUAGE_TEXT)
    expect(responseLanguageText(childAgent)).toBe('')
    expect(responseLanguageText({})).toBe('')
  })

  it('registers a non-interpolated section that follows the live switch', () => {
    const sections: PromptSection[] = []
    const enabled = switchFor(true)
    apply(fakeContext(sections), Config({}))
    apply(fakeContext(sections), { enabled })
    const section = sections[1] as PromptSection
    expect(section.name).toBe(RESPONSE_LANGUAGE_SECTION)
    expect(section.order).toBe(10_201)
    expect(section.interpolate).toBe(false)
    expect(section.text(mainAgent)).toBe(RESPONSE_LANGUAGE_TEXT)
    enabled.set(false)
    expect(section.text(mainAgent)).toBe('')
    enabled.set(true)
    expect(section.text(mainAgent)).toBe(RESPONSE_LANGUAGE_TEXT)
  })
})

describe('response-language runtime reminder', () => {
  it('registers a required context at the last runtime position', () => {
    const sections: PromptSection[] = []
    const contexts: PromptSection[] = []
    apply(fakeContext(sections, contexts), Config({}))
    expect(contexts).toHaveLength(1)
    const context = contexts[0] as PromptSection
    expect(context.name).toBe(RESPONSE_LANGUAGE_CONTEXT)
    expect(context.order).toBe(10_101)
    expect(context.required).toBe(true)
    expect(context.interpolate).toBe(false)
  })

  it('repeats the reminder for main agents only and follows the switch', () => {
    expect(responseLanguageReminder(mainAgent)).toBe(RESPONSE_LANGUAGE_REMINDER)
    expect(responseLanguageReminder(childAgent)).toBe('')
    expect(responseLanguageReminder({})).toBe('')
    const sections: PromptSection[] = []
    const contexts: PromptSection[] = []
    const enabled = switchFor(true)
    apply(fakeContext(sections, contexts), { enabled })
    const context = contexts[0] as PromptSection
    expect(context.text(mainAgent)).toBe(RESPONSE_LANGUAGE_REMINDER)
    enabled.set(false)
    expect(context.text(mainAgent)).toBe('')
  })
})
