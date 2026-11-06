/** `settings.anagoFonts` namespace dictionaries (the font picker's copy). */

/** Locale keys the picker renders. */
export type FontPickerKey = 'default' | 'bundled' | 'system' | 'custom' | 'customList' | 'customPlaceholder'

/** Simplified Chinese copy. */
export const zh: Record<FontPickerKey, string> = {
  default: '默认',
  bundled: '内置字体',
  system: '系统字体',
  custom: '自定义…',
  customList: '自定义字体列表',
  customPlaceholder: '多个字体用逗号分隔',
}

/** English copy. */
export const en: Record<FontPickerKey, string> = {
  default: 'Default',
  bundled: 'Bundled fonts',
  system: 'System fonts',
  custom: 'Custom…',
  customList: 'custom font list',
  customPlaceholder: 'Fonts separated by commas',
}

/** Japanese copy. */
export const ja: Record<FontPickerKey, string> = {
  default: '既定',
  bundled: '同梱フォント',
  system: 'システムフォント',
  custom: 'カスタム…',
  customList: 'カスタムフォントリスト',
  customPlaceholder: 'フォントをカンマで区切って入力',
}

/** Spanish copy. */
export const es: Record<FontPickerKey, string> = {
  default: 'Predeterminada',
  bundled: 'Fuentes incluidas',
  system: 'Fuentes del sistema',
  custom: 'Personalizada…',
  customList: 'lista de fuentes personalizada',
  customPlaceholder: 'Fuentes separadas por comas',
}

/** French copy. */
export const fr: Record<FontPickerKey, string> = {
  default: 'Par défaut',
  bundled: 'Polices intégrées',
  system: 'Polices système',
  custom: 'Personnalisée…',
  customList: 'liste de polices personnalisée',
  customPlaceholder: 'Polices séparées par des virgules',
}

/** German copy. */
export const de: Record<FontPickerKey, string> = {
  default: 'Standard',
  bundled: 'Mitgelieferte Schriftarten',
  system: 'Systemschriftarten',
  custom: 'Benutzerdefiniert…',
  customList: 'benutzerdefinierte Schriftartenliste',
  customPlaceholder: 'Schriftarten durch Kommas getrennt',
}

/** Russian copy. */
export const ru: Record<FontPickerKey, string> = {
  default: 'По умолчанию',
  bundled: 'Встроенные шрифты',
  system: 'Системные шрифты',
  custom: 'Другой…',
  customList: 'свой список шрифтов',
  customPlaceholder: 'Шрифты через запятую',
}

/** Brazilian Portuguese copy. */
export const pt: Record<FontPickerKey, string> = {
  default: 'Padrão',
  bundled: 'Fontes incluídas',
  system: 'Fontes do sistema',
  custom: 'Personalizada…',
  customList: 'lista de fontes personalizada',
  customPlaceholder: 'Fontes separadas por vírgulas',
}
