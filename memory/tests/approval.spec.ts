/**
 * Approval-gate suite (DESIGN §4.5, S16, S21): which policy produces an ask,
 * which produces a staged mark, and what the gate refuses to touch.
 * @module @anago-harness/memory/tests/approval
 */
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { afterAll, describe, expect, it } from 'vitest'
import {
  approvalPrompt,
  createMemoryApprovalGate,
  isMemoryWriteCall,
  resolveEffectivePolicy,
  type MemoryApprovalGate,
} from '../src/approval.ts'
import {
  cleanupTempDirs,
  fakeAgent,
  fakeApproval,
  memoryConfig,
  recordingLogger,
} from './support.ts'

afterAll(cleanupTempDirs)

/** One call the gate is asked about, with the defaults a `memory` write has. */
function call(
  args: Record<string, unknown>,
  name = 'memory',
  agent: unknown = fakeAgent({}),
): { name: string; arguments: unknown; agent?: unknown } {
  return { name, arguments: args, agent }
}

/** Run the gate over one call whose downstream chain allows it. */
async function decide(
  gate: MemoryApprovalGate,
  exec: { name: string; arguments: unknown; agent?: unknown },
  downstream: PreToolDecision = { kind: 'allow' },
): Promise<PreToolDecision> {
  return await gate.decide(exec as never, async () => downstream)
}

/** A gate with `writeApproval: ask` and one policy. */
function gateFor(service: ReturnType<typeof fakeApproval> | undefined): MemoryApprovalGate {
  return createMemoryApprovalGate({
    config: memoryConfig({ writeApproval: 'ask' }),
    logger: recordingLogger(),
    approval: () => service,
  })
}

describe('resolveEffectivePolicy (DESIGN S21)', () => {
  it('prefers the session override, then the configured default, then ask', () => {
    expect(resolveEffectivePolicy(fakeApproval({ policy: 'ask', override: 'never' }), {})).toBe('never')
    expect(resolveEffectivePolicy(fakeApproval({ policy: 'never' }), {})).toBe('never')
    expect(resolveEffectivePolicy(fakeApproval({}), {})).toBe('ask')
  })

  it('treats a deployment without the service as never (DESIGN §4.5)', () => {
    expect(resolveEffectivePolicy(undefined, {})).toBe('never')
  })

  it('treats an unreadable policy as never rather than writing unapproved', () => {
    expect(resolveEffectivePolicy(fakeApproval({ throws: true }), {})).toBe('never')
  })
})

describe('isMemoryWriteCall', () => {
  it('is true only for a memory call with at least one operation', () => {
    expect(isMemoryWriteCall(call({ target: 'memory', operations: [{ op: 'add', text: 'x' }] }))).toBe(true)
    expect(isMemoryWriteCall(call({ target: 'memory', operations: [] }))).toBe(false)
    expect(isMemoryWriteCall(call({ target: 'memory' }))).toBe(false)
    expect(isMemoryWriteCall(call({ operations: [{ op: 'add', text: 'x' }] }, 'bash'))).toBe(false)
    expect(isMemoryWriteCall(call({ operations: 'add' }))).toBe(false)
  })
})

describe('the gate with writeApproval: none', () => {
  it('leaves every call untouched and never stages', async () => {
    const gate = createMemoryApprovalGate({
      config: memoryConfig(),
      logger: recordingLogger(),
      approval: () => fakeApproval({ policy: 'never' }),
    })
    const exec = call({ target: 'memory', operations: [{ op: 'add', text: 'x' }] })
    expect(await decide(gate, exec)).toEqual({ kind: 'allow' })
    expect(gate.wasStaged(exec)).toBe(false)
  })
})

describe('the gate with writeApproval: ask', () => {
  it('asks when the session can be prompted, and does not stage', async () => {
    const gate = gateFor(fakeApproval({ policy: 'ask' }))
    const exec = call({ target: 'user', operations: [{ op: 'add', text: 'x' }, { op: 'remove', old_text: 'y' }] })
    const decision = await decide(gate, exec)
    expect(decision.kind).toBe('ask')
    if (decision.kind !== 'ask') throw new Error('expected an ask')
    expect(decision.reason).toMatch(/2 operations/u)
    expect(decision.reason).toMatch(/'user' store/u)
    expect(decision.displayReason?.en).toMatch(/Allow the model to write 2 operations/u)
    expect(decision.displayReason?.ja).toMatch(/メモリ（user）へ 2 件/u)
    expect(gate.wasStaged(exec)).toBe(false)
  })

  it('stages instead of asking when the policy is never', async () => {
    const gate = gateFor(fakeApproval({ policy: 'never' }))
    const exec = call({ target: 'memory', operations: [{ op: 'add', text: 'x' }] })
    expect(await decide(gate, exec)).toEqual({ kind: 'allow' })
    expect(gate.wasStaged(exec)).toBe(true)
    // The mark is per execution object: another call is not staged by it.
    expect(gate.wasStaged(call({ target: 'memory', operations: [{ op: 'add', text: 'x' }] }))).toBe(false)
  })

  it('stages when a session override says never even though the default is ask', async () => {
    const gate = gateFor(fakeApproval({ policy: 'ask', override: 'never' }))
    const exec = call({ target: 'memory', operations: [{ op: 'add', text: 'x' }] })
    await decide(gate, exec)
    expect(gate.wasStaged(exec)).toBe(true)
  })

  it('stages when no approval service is loaded at all', async () => {
    const gate = gateFor(undefined)
    const exec = call({ target: 'memory', operations: [{ op: 'add', text: 'x' }] })
    expect(await decide(gate, exec)).toEqual({ kind: 'allow' })
    expect(gate.wasStaged(exec)).toBe(true)
  })

  it('never asks about a read, under either policy', async () => {
    for (const policy of ['ask', 'never'] as const) {
      const gate = gateFor(fakeApproval({ policy }))
      const exec = call({ target: 'memory', operations: [] })
      expect(await decide(gate, exec)).toEqual({ kind: 'allow' })
      expect(gate.wasStaged(exec)).toBe(false)
    }
  })

  it('does not touch a downstream deny, cancel, or ask', async () => {
    for (const downstream of [
      { kind: 'deny', reason: 'sandbox' },
      { kind: 'cancel' },
      { kind: 'ask', reason: 'another plugin' },
    ] as PreToolDecision[]) {
      const gate = gateFor(fakeApproval({ policy: 'ask' }))
      const exec = call({ target: 'memory', operations: [{ op: 'add', text: 'x' }] })
      expect(await decide(gate, exec, downstream)).toEqual(downstream)
      expect(gate.wasStaged(exec)).toBe(false)
    }
  })

  it('leaves another tool alone', async () => {
    const gate = gateFor(fakeApproval({ policy: 'ask' }))
    const exec = call({ operations: [{ op: 'add', text: 'x' }] }, 'wiki_write')
    expect(await decide(gate, exec)).toEqual({ kind: 'allow' })
    expect(gate.wasStaged(exec)).toBe(false)
  })
})

describe('approvalPrompt', () => {
  it('names the target store and the operation count', () => {
    const prompt = approvalPrompt({ arguments: { target: 'workspace', operations: [{ op: 'add' }, { op: 'add' }] } })
    expect(prompt.reason).toContain("'workspace' store")
    expect(prompt.displayReason.en).toContain('workspace')
    expect(prompt.displayReason.ja).toContain('workspace')
  })

  it('falls back to the memory store and a zero count for odd arguments', () => {
    const prompt = approvalPrompt({ arguments: {} })
    expect(prompt.reason).toContain("'memory' store")
    expect(prompt.reason).toContain('0 operations')
  })
})
