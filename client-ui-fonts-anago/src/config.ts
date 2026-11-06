/**
 * Font-family lists an operator configures for the Anago Web UI. The Host
 * schema validates them and embeds them in every page; the browser half writes
 * them as each interface's default tokens. Every value is a CSS font-family
 * list; `''` keeps ui-theme's built-in stack for that interface.
 */
import z from '@deepseek-ai/schemastery'

/** Page global carrying the font lists; the Host embeds it and the browser half reads it. */
export const FONT_CONFIG_GLOBAL = '__DSH_ANAGO_FONT_CONFIG__'

/** Stacks applied when the profile configures none: today's Japanese-first stacks. */
const DEFAULT_FONT_FAMILIES = {
  text: "'UDEV Gothic', 'Noto Sans JP', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  code: "'Intel One Mono', 'UDEV Gothic', 'Noto Sans JP', 'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', Menlo, Courier, 'PingFang SC', 'Microsoft YaHei'",
  terminal: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const

/** Configurable font lists by interface. */
export interface Config {
  /** Interface and body text list; `''` keeps the built-in stack. */
  text: string
  /** Code-block, editor, and diff list; `''` keeps the built-in stack. */
  code: string
  /** Sidebar terminal list; `''` keeps the built-in stack. */
  terminal: string
}

/** Validated font lists; an omitted field keeps today's stack. */
export const Config: z<Partial<Config>, Config> = z.object({
  text: z.string().default(DEFAULT_FONT_FAMILIES.text),
  code: z.string().default(DEFAULT_FONT_FAMILIES.code),
  terminal: z.string().default(DEFAULT_FONT_FAMILIES.terminal),
})
