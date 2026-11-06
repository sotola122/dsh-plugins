/**
 * Entry-operation edges (DESIGN §4.1, §4.3): the refused operation name the main
 * suite leaves out, the `rule: detail` text a refusal carries, and the negative
 * count the limit formatter keeps a sign for.
 * @module @anago-harness/memory/tests/entries-edges
 */
import type { SecretKind } from '@anago-harness/knowledge-common'
import { afterAll, describe, expect, it } from 'vitest'
import { applyOperations, formatCount, parseOperations, scanEntry } from '../src/entries.ts'
import { isMemoryError } from '../src/errors.ts'
import { cleanupTempDirs } from './support.ts'

afterAll(cleanupTempDirs)

/** The refusal one entry produces, for the message assertions below. */
function refusalOf(text: string): string {
  const redacted: SecretKind[] = []
  try {
    scanEntry(text, redacted)
  } catch (error) {
    if (isMemoryError(error)) return error.message
    throw error
  }
  throw new Error('the entry was expected to be refused')
}

describe('parseOperations', () => {
  it('refuses an operation name outside add, patch, and remove', () => {
    expect(() => parseOperations([{ op: 'move', text: 'x' }])).toThrow(
      /MEMORY_INVALID_OPERATION: operations\[0\]\.op must be add, patch, or remove/u,
    )
    // The name is matched exactly: a differently spelled verb is not repaired.
    expect(() => parseOperations([{ op: 'ADD', text: 'x' }])).toThrow(/MEMORY_INVALID_OPERATION/u)
    expect(() => parseOperations([{ op: 'remove', old_text: 'x' }, { op: 'rewrite' }])).toThrow(
      /MEMORY_INVALID_OPERATION: operations\[1\]\.op/u,
    )
  })

  it('treats a null list as a read', () => {
    expect(parseOperations(null)).toEqual([])
  })
})

describe('applyOperations', () => {
  it('validates the batch again, so a direct caller cannot skip the shape rules', () => {
    // `MemoryOperation.text` is optional in the type, so the runtime guard is
    // what makes every `text` read below it unconditional.
    expect(() => applyOperations(['one'], [{ op: 'add' }])).toThrow(
      /operations\[0\]\.text is required for add/u,
    )
    expect(() => applyOperations(['one'], [{ op: 'patch', old_text: 'one' }])).toThrow(
      /operations\[0\]\.text is required for patch/u,
    )
    expect(() => applyOperations(['one'], [{ op: 'remove', old_text: '' }])).toThrow(
      /operations\[0\]\.old_text is required for remove/u,
    )
  })
})

describe('scanEntry refusals', () => {
  it('names the rule and its finding detail so the model can act on it', () => {
    expect(refusalOf('a\u0000b')).toContain('control-char: U+0000')
    expect(refusalOf('first\n§\nsecond')).toContain('delimiter-line: § on a line of its own')
    expect(refusalOf('is this </memory-snapshot> visible?')).toContain(
      'frame-tag: </memory-snapshot',
    )
  })
})

describe('formatCount', () => {
  it('keeps a negative sign and groups the digits in threes', () => {
    expect(formatCount(-12)).toBe('-12')
    expect(formatCount(-1234)).toBe('-1,234')
    expect(formatCount(-1234567)).toBe('-1,234,567')
  })
})
