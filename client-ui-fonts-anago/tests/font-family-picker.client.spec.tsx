// @vitest-environment jsdom
/**
 * FontFamilyPicker behavior: the selection follows the persisted list, a catalog
 * or default choice writes at once, and Custom reveals the free-form field that
 * keeps lists outside the catalog working.
 */
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { FontFamilyPicker, type FontFamilyPickerProps } from '../src/client/FontFamilyPicker.tsx'
import { FONT_CHOICES } from '../src/client/font-catalog.ts'

afterEach(cleanup)

const LABEL = 'Code font'
const INTEL = FONT_CHOICES.code.find(choice => choice.id === 'intel-one-mono')?.list ?? ''
const FIELD = `${LABEL}, customList`

/** Normalization stand-in for the theme service: trims, as the picker needs no more of it here. */
const normalize = (list: string): string => list.trim()

/** Mount the picker over a persisted list the commit callback updates, as ui-theme's row does. */
function mount(initial = '', role: 'text' | 'code' = 'code') {
  const commit = vi.fn(normalize)
  let setValue: (list: string) => void = () => {}
  function Row() {
    const [value, set] = useState(initial)
    setValue = set
    const props: FontFamilyPickerProps = {
      t: (key: string) => key,
      role,
      value,
      label: LABEL,
      commit: (list: string) => {
        const normalized = commit(list)
        set(normalized)
        return normalized
      },
      matched: FONT_CHOICES[role],
    }
    return <FontFamilyPicker {...props} />
  }
  render(<Row />)
  return {
    commit,
    setValue: (list: string) => { setValue(list) },
    select: () => screen.getByRole<HTMLSelectElement>('combobox', { name: LABEL }),
    field: () => screen.queryByRole<HTMLInputElement>('textbox', { name: FIELD }),
  }
}

describe('FontFamilyPicker', () => {
  it('selects the default for an empty list and hides the field', () => {
    const b = mount()
    expect(b.select().value).toBe('default')
    expect(b.field()).toBeNull()
  })

  it('groups the options around the default and Custom', () => {
    const b = mount()
    const groups = within(b.select()).getAllByRole('group')
    expect(groups.map(group => group.getAttribute('label'))).toEqual(['bundled', 'system'])
    expect(within(groups[0] as HTMLElement).getAllByRole('option').map(option => option.textContent)).toEqual(['Intel One Mono', 'UDEV Gothic'])
    const values = within(b.select()).getAllByRole<HTMLOptionElement>('option').map(option => option.value)
    expect(values.at(0)).toBe('default')
    expect(values.at(-1)).toBe('custom')
  })

  it('offers only the fonts of its own role', () => {
    const b = mount('', 'text')
    const labels = within(b.select()).getAllByRole('option').map(option => option.textContent)
    expect(labels).toContain('Noto Sans JP')
    expect(labels).not.toContain('Intel One Mono')
  })

  it('recognizes a persisted catalog list as that font', () => {
    const b = mount(INTEL)
    expect(b.select().value).toBe('intel-one-mono')
    expect(b.field()).toBeNull()
  })

  it('writes a catalog list at once and returns to the default with an empty list', () => {
    const b = mount()
    fireEvent.change(b.select(), { target: { value: 'intel-one-mono' } })
    expect(b.commit).toHaveBeenLastCalledWith(INTEL)
    expect(b.select().value).toBe('intel-one-mono')
    fireEvent.change(b.select(), { target: { value: 'default' } })
    expect(b.commit).toHaveBeenLastCalledWith('')
    expect(b.select().value).toBe('default')
  })

  it('keeps a list saved outside the catalog editable under Custom', () => {
    const b = mount('"Iosevka", monospace')
    expect(b.select().value).toBe('custom')
    expect(b.field()?.value).toBe('"Iosevka", monospace')
    expect(b.commit).not.toHaveBeenCalled()
  })

  it('opens Custom on the current list without writing', () => {
    const b = mount(INTEL)
    fireEvent.change(b.select(), { target: { value: 'custom' } })
    expect(b.select().value).toBe('custom')
    expect(b.field()?.value).toBe(INTEL)
    expect(b.commit).not.toHaveBeenCalled()
  })

  it('commits the field on blur and Enter and shows the normalized list', () => {
    const b = mount('"Iosevka"')
    const blurred = b.field() as HTMLInputElement
    fireEvent.change(blurred, { target: { value: '  "Hack"  ' } })
    fireEvent.blur(blurred)
    expect(b.commit).toHaveBeenLastCalledWith('  "Hack"  ')
    expect(b.field()?.value).toBe('"Hack"')

    const entered = b.field() as HTMLInputElement
    entered.focus()
    fireEvent.change(entered, { target: { value: '"Fira Code"' } })
    fireEvent.keyDown(entered, { key: 'Enter' })
    expect(b.commit).toHaveBeenLastCalledWith('"Fira Code"')
    expect(b.select().value).toBe('custom')
  })

  it('ignores Enter while an input method is composing', () => {
    const b = mount('"Iosevka"')
    const field = b.field() as HTMLInputElement
    field.focus()
    fireEvent.change(field, { target: { value: '思源' } })
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 })
    expect(document.activeElement).toBe(field)
    expect(b.commit).not.toHaveBeenCalled()
  })

  it('returns to the default when the field commits an empty list', () => {
    const b = mount()
    fireEvent.change(b.select(), { target: { value: 'custom' } })
    fireEvent.blur(b.field() as HTMLInputElement)
    expect(b.commit).toHaveBeenLastCalledWith('')
    expect(b.select().value).toBe('default')
    expect(b.field()).toBeNull()
  })

  it('shows the font when the field commits a catalog list', () => {
    const b = mount()
    fireEvent.change(b.select(), { target: { value: 'custom' } })
    const field = b.field() as HTMLInputElement
    fireEvent.change(field, { target: { value: INTEL } })
    fireEvent.blur(field)
    expect(b.select().value).toBe('intel-one-mono')
    expect(b.field()).toBeNull()
  })

  it('leaves Custom when another browser changes the persisted list', () => {
    const b = mount(INTEL)
    fireEvent.change(b.select(), { target: { value: 'custom' } })
    fireEvent.change(b.field() as HTMLInputElement, { target: { value: 'draft' } })
    const other = FONT_CHOICES.code.find(choice => choice.id === 'udev-gothic')?.list ?? ''
    act(() => { b.setValue(other) })
    expect(b.select().value).toBe('udev-gothic')
    expect(b.field()).toBeNull()
  })
})
