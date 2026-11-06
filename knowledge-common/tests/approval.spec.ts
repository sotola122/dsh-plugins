/**
 * The shared approval gate: which downstream decisions it may change, and the
 * two outcomes a plugin can choose under the `never` policy (DESIGN S16, S21).
 *
 * The wiki refuses the write because it has nowhere to stage; the memory plugin
 * stages it and keeps the downstream `allow`. Both are expressed by the value
 * `onNever` returns, so the suite pins the allow-preserving default and the
 * decision-replacing refusal.
 * @module @anago-harness/knowledge-common/tests/approval.spec
 */
import { describe, expect, it } from 'vitest'
import {
  createApprovalGate,
  resolveEffectivePolicy,
  type ApprovalDecisionLike,
  type ApprovalPrompt,
  type ApprovalServiceLike,
} from '../src/approval.ts'

/** A decision wide enough for every branch the gate distinguishes. */
interface TestDecision extends ApprovalDecisionLike {
  readonly kind: string
  readonly reason?: string
}

const ALLOW: TestDecision = { kind: 'allow' }

const PROMPT: ApprovalPrompt = {
  reason: 'the tool wants to write',
  displayReason: { en: 'Allow the write?', ja: '書き込んでよいですか？' },
}

/** A fake approval service with the policy the case needs. */
function service(policy: 'ask' | 'never' | undefined, override?: 'ask' | 'never'): ApprovalServiceLike {
  return {
    config: policy === undefined ? {} : { policy },
    overrideOf: () => override,
  }
}

/** The call shape the gate reads. */
function call(argumentsValue: unknown = { path: 'x' }, tool = 'write'): {
  name: string
  arguments: unknown
  agent?: unknown
} {
  return { name: tool, arguments: argumentsValue, agent: { session: { id: 's' } } }
}

/** Build a gate whose writes are every governed call. */
function gate(options: {
  policy?: ApprovalServiceLike | undefined
  onNever?: (call: { readonly name: string }) => TestDecision | undefined
  refuse?: (call: { readonly name: string }) => TestDecision | undefined
}) {
  return createApprovalGate<TestDecision>({
    toolName: 'write',
    isWrite: () => true,
    asks: () => true,
    prompt: () => PROMPT,
    onNever: options.onNever ?? (() => undefined),
    ...(options.refuse === undefined ? {} : { refuse: options.refuse }),
    approval: () => options.policy,
  })
}

describe('resolveEffectivePolicy (DESIGN S21)', () => {
  it('reads the session override, then the deployment default', () => {
    expect(resolveEffectivePolicy(service('never'), {})).toBe('never')
    expect(resolveEffectivePolicy(service('never', 'ask'), {})).toBe('ask')
  })

  it('treats a missing or unreadable policy as never', () => {
    expect(resolveEffectivePolicy(undefined, {})).toBe('never')
    const unreadable: ApprovalServiceLike = {
      config: { policy: 'ask' },
      overrideOf() {
        throw new Error('unreadable')
      },
    }
    expect(resolveEffectivePolicy(unreadable, {})).toBe('never')
  })
})

describe('createApprovalGate (DESIGN S16)', () => {
  it('asks when the effective policy is ask', async () => {
    const decision = await gate({ policy: service('ask') }).decide(call(), async () => ALLOW)
    expect(decision).toEqual({ kind: 'ask', ...PROMPT })
  })

  it('keeps the downstream allow when onNever stages the write', async () => {
    const staged: string[] = []
    const decision = await gate({
      policy: service('never'),
      onNever: (current) => {
        staged.push(current.name)
        return undefined
      },
    }).decide(call(), async () => ALLOW)
    expect(decision).toEqual(ALLOW)
    expect(staged).toEqual(['write'])
  })

  it('replaces the downstream allow with the decision onNever returns', async () => {
    const deny: TestDecision = { kind: 'deny', reason: 'the session cannot be prompted' }
    const decision = await gate({
      policy: service('never'),
      onNever: () => deny,
    }).decide(call(), async () => ALLOW)
    expect(decision).toEqual(deny)
  })

  it('never swallows a downstream deny, cancel, or ask', async () => {
    const policy = service('never')
    const onNever = (): TestDecision => ({ kind: 'deny', reason: 'refused below' })
    for (const downstream of [
      { kind: 'deny', reason: 'kept' },
      { kind: 'cancel' },
      { kind: 'ask', reason: 'another policy' },
    ] satisfies readonly TestDecision[]) {
      expect(await gate({ policy, onNever }).decide(call(), async () => downstream)).toEqual(downstream)
    }
  })

  it('applies the plugin refusal before the policy read', async () => {
    const refusal: TestDecision = { kind: 'deny', reason: 'read-only child' }
    const decision = await gate({
      policy: service('ask'),
      refuse: () => refusal,
    }).decide(call(), async () => ALLOW)
    expect(decision).toEqual(refusal)
  })

  it('ignores another tool and a non-writing call', async () => {
    const withHook = gate({
      policy: service('never'),
      onNever: () => ({ kind: 'deny', reason: 'must not run' }),
    })
    expect(await withHook.decide(call({}, 'read'), async () => ALLOW)).toEqual(ALLOW)
    const notAWrite = createApprovalGate<TestDecision>({
      toolName: 'write',
      isWrite: () => false,
      asks: () => true,
      prompt: () => PROMPT,
      onNever: () => ({ kind: 'deny', reason: 'must not run' }),
      approval: () => service('never'),
    })
    expect(await notAWrite.decide(call(), async () => ALLOW)).toEqual(ALLOW)
  })

  it('does nothing when writeApproval is none', async () => {
    const notAsking = createApprovalGate<TestDecision>({
      toolName: 'write',
      isWrite: () => true,
      asks: () => false,
      prompt: () => PROMPT,
      onNever: () => ({ kind: 'deny', reason: 'must not run' }),
      approval: () => service('never'),
    })
    expect(await notAsking.decide(call(), async () => ALLOW)).toEqual(ALLOW)
  })
})
