/**
 * The control one font row shows under this plugin: a select offering the
 * role's default, the catalog fonts, and Custom, plus a text field while Custom
 * is selected. The selection is derived from the persisted list: `''` is the
 * default, a catalog list is that font, and any other list is Custom with the
 * list in the field, so a list saved before the picker existed stays editable.
 * A catalog or default choice writes at once; the field commits on blur or Enter.
 */
import { useState } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MatchedShare, OwnerOf, PropsLocale, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { FontChoice } from './font-catalog.ts'
import css from './FontFamilyPicker.module.css'

/** Option value of the role's default stack; catalog ids never take it. */
const DEFAULT_CHOICE = 'default'

/** Option value that reveals the text field; catalog ids never take it. */
const CUSTOM_CHOICE = 'custom'

/** Component props: the row's owner share, the locale seat, and the role's options elected by the chain entry's `select`. */
export type FontFamilyPickerProps =
  OwnerOf<'settings.theme.font-family'> & PropsLocale<'settings.anagoFonts'>
  & MatchedShare<SlotMap['settings.theme.font-family'], readonly FontChoice[]>

/**
 * Resolve the option a persisted list selects.
 * @param choices - The role's catalog options.
 * @param list - Normalized persisted list.
 * @returns the option value; a list outside the catalog selects Custom.
 */
function choiceOf(choices: readonly FontChoice[], list: string): string {
  if (list === '') return DEFAULT_CHOICE
  return choices.find(choice => choice.list === list)?.id ?? CUSTOM_CHOICE
}

/**
 * Render one role's font picker.
 * @param props - Composed slot props.
 * @returns the select and, while Custom is selected, its text field.
 */
export function FontFamilyPicker({ t, value, label, commit, matched: choices }: FontFamilyPickerProps) {
  // The list Custom was opened on: it holds Custom selected until that list changes.
  const [customFor, setCustomFor] = useState<string | null>(null)
  const selected = customFor === value ? CUSTOM_CHOICE : choiceOf(choices, value)
  const select = (id: string): void => {
    if (id === CUSTOM_CHOICE) {
      setCustomFor(value)
      return
    }
    setCustomFor(null)
    commit(choices.find(choice => choice.id === id)?.list ?? '')
  }
  const commitField = (input: HTMLInputElement): void => {
    input.value = commit(input.value)
    if (input.value === '') setCustomFor(null)
  }
  const group = (kind: FontChoice['kind']) => (
    <optgroup label={t(kind)}>
      {choices.filter(choice => choice.kind === kind).map(choice => (
        <option key={choice.id} value={choice.id}>{choice.label}</option>
      ))}
    </optgroup>
  )
  return (
    <div className={css.picker}>
      <select
        className={css.select}
        aria-label={label}
        value={selected}
        onChange={(event) => { select(event.target.value) }}
      >
        <option value={DEFAULT_CHOICE}>{t('default')}</option>
        {group('bundled')}
        {group('system')}
        <option value={CUSTOM_CHOICE}>{t('custom')}</option>
      </select>
      {selected === CUSTOM_CHOICE && (
        <Input
          key={value}
          className={css.field as string}
          defaultValue={value}
          placeholder={t('customPlaceholder')}
          aria-label={`${label}, ${t('customList')}`}
          spellCheck={false}
          autoComplete="off"
          maxLength={200}
          onBlur={(event) => { commitField(event.currentTarget) }}
          onKeyDown={(event) => {
            // oxlint-disable-next-line typescript/no-deprecated -- Some IMEs report composition only through keyCode 229.
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
      )}
    </div>
  )
}
