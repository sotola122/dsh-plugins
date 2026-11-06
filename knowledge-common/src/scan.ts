/**
 * §9 scanning: the one verdict every consumer applies to text it accepts from
 * a model or reads from a file it does not own (memory write, approval,
 * injection, `wiki_write`, review output, `wiki_search` fields).
 *
 * The pipeline is fixed: `Cf` removal → NFKC → whitespace collapse → lower
 * case, and the pattern rules run on that normalized form, so a payload split
 * by a zero-width mark or spelled with compatibility characters still matches.
 * The character rules run on the *raw* text, because removing those characters
 * is what hides them in the first place (DESIGN §9).
 *
 * Two verdicts come out of one call:
 *
 * - **refusal** — a rule matched, so the consumer must not store, inject, or
 *   return the text (`MEMORY_REJECTED` and friends);
 * - **redaction** — a secret shape matched, so the consumer stores the text
 *   with `[REDACTED:<kind>]` in place of the secret and reports the kinds.
 *
 * A high non-ASCII ratio is neither: it is the advisory that produces
 * `MEMORY_REVIEW_SUGGESTED` (DESIGN §4.1, N6).
 * @module knowledge-common/scan
 */

import {
  isDelimiterLine,
  isFormatCharacter,
  isRejectedControlCharacter,
  normalizeForMatch,
  splitLines,
  stripFormatCharacters,
} from './text.ts'

/** A rule that refuses text outright (DESIGN §9). */
export type ScanRule =
  | 'control-char'
  | 'format-char'
  | 'bidi-char'
  | 'tag-char'
  | 'delimiter-line'
  | 'frame-tag'
  | 'template-token'
  | 'instruction-override'
  | 'response-language'

/** The kind of secret that was replaced by `[REDACTED:<kind>]`. */
export type SecretKind =
  | 'private-key'
  | 'url-credential'
  | 'api-key'
  | 'aws-key'
  | 'github-token'
  | 'slack-token'
  | 'google-key'
  | 'jwt'
  | 'env-secret'

/** A non-ASCII ratio strictly above this asks for a review; it never refuses (N6). */
export const NON_ASCII_WARN_RATIO = 0.1

/** The prefix of every redaction placeholder. */
export const REDACTION_PREFIX = '[REDACTED:'

/**
 * The placeholder that replaces a secret.
 * @param kind - the secret kind.
 * @returns `[REDACTED:<kind>]`.
 */
export function redactionPlaceholder(kind: SecretKind): string {
  return `${REDACTION_PREFIX}${kind}]`
}

/** One refusal, with a short excerpt of what matched. */
export interface ScanFinding {
  /** The rule that refused the text. */
  readonly rule: ScanRule
  /** A bounded, human-readable detail: the offending character or token. */
  readonly detail: string
}

/** The scan's verdict for one piece of text. */
export interface ScanResult {
  /** False when at least one rule refused the text. */
  readonly ok: boolean
  /** One finding per matched rule, in the fixed rule order. */
  readonly findings: readonly ScanFinding[]
  /** The matched rules, in the fixed rule order. */
  readonly rules: readonly ScanRule[]
  /** The input with every secret replaced by its redaction placeholder. */
  readonly text: string
  /** The kinds of secret that were replaced, in first-seen order. */
  readonly redacted: readonly SecretKind[]
  /** Non-ASCII code points divided by non-whitespace code points, code spans excluded. */
  readonly nonAsciiRatio: number
  /** True when {@link nonAsciiRatio} is above {@link NON_ASCII_WARN_RATIO}. */
  readonly reviewSuggested: boolean
}

/** Bidi controls: named separately from the generic `Cf` rule for the report. */
const BIDI_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u
/** Unicode tag characters, used to smuggle invisible instructions. */
const TAG_CHARACTER = /[\u{E0000}-\u{E007F}]/u

/** The frame tags this harness itself uses; both spellings are refused inside content. */
const FRAME_TAG_NAMES = ['memory-snapshot', 'system-reminder'] as const

/** A frame tag after normalization: case and inner whitespace do not matter. */
const FRAME_TAG = /<\s*\/?\s*(?:memory-snapshot|system-reminder)\b/u

/** A frame tag escaped for injection: closing and opening, case-insensitively. */
const FRAME_TAG_ANY = /<\s*\/?\s*(memory-snapshot|system-reminder)\s*>/giu

/**
 * Chat-template tokens, matched on the normalized text. The first pattern
 * covers every `<|…|>` special token, including the full-width form
 * (`<｜im_start｜>`) that NFKC folds onto the ASCII bars.
 */
const TEMPLATE_TOKENS: readonly RegExp[] = [
  /<\|[^|<>]{1,80}\|>/u,
  /\[\/?inst\]/u,
  /<<\/?sys>>/u,
  /<\/?(?:start_of_turn|end_of_turn|im_start|im_end|s)>/u,
  /###\s*(?:instruction|response|system)\s*:/u,
]

/** Instruction-override phrasings (DESIGN §9). */
const INSTRUCTION_OVERRIDES: readonly RegExp[] = [
  new RegExp(
    String.raw`\b(?:ignore|disregard|forget|discard|skip)\s+(?:all\s+|any\s+)?(?:of\s+)?`
    + String.raw`(?:the\s+|your\s+|these\s+|those\s+)?`
    + String.raw`(?:previous|prior|earlier|above|preceding|foregoing|system|initial|original)\s+`
    + String.raw`(?:instruction|prompt|rule|direction|guideline|constraint)s?\b`,
    'u',
  ),
  new RegExp(
    String.raw`\boverride\s+(?:the\s+|your\s+|all\s+)?(?:previous|prior|above|system|safety)\s*`
    + String.raw`(?:instruction|prompt|rule|direction|guideline|constraint|guardrail|filter)s?\b`,
    'u',
  ),
  /\b(?:new|updated|revised)\s+(?:system\s+)?(?:instruction|prompt)s?\s*:/u,
  /\byou\s+are\s+now\s+(?:a|an|the|no\s+longer)\b/u,
  /\bfrom\s+now\s+on\s*,?\s*(?:you|always|ignore|disregard|forget)\b/u,
  new RegExp(
    String.raw`\b(?:reveal|print|show|repeat|output|disclose|dump|leak)\s+(?:me\s+)?`
    + String.raw`(?:your\s+(?:system\s+)?|the\s+system\s+)`
    + String.raw`(?:prompt|instructions|rules|configuration)\b`,
    'u',
  ),
  /\b(?:do\s+not|don't|never)\s+(?:follow|obey|respect)\s+(?:the\s+|your\s+|any\s+)?(?:system|previous|prior|above|safety)\b/u,
  /\b(?:jailbreak|developer\s+mode|dan\s+mode|god\s+mode)\b/u,
  /(?:以前|前|上記|これまで)の(?:指示|命令|プロンプト|ルール|制約)(?:を|は)(?:無視|忘れ|破棄|解除)/u,
  /システムプロンプト(?:を)?(?:表示|公開|教え|出力|見せ)/u,
  /(?:制約|安全|ガードレール)(?:を)?(?:無視|解除|回避)/u,
  /(?:あなた|きみ|君)は(?:今から|これから)/u,
]

/** Language names that make a sentence a response-language directive (DESIGN §9, R4). */
const LANGUAGE_NAMES =
  '(?<![a-z])(?:japanese|english|spanish|french|german|chinese|korean|portuguese|italian|russian|arabic|hindi|dutch|polish|turkish|vietnamese|thai|indonesian|swedish|ukrainian|hebrew|greek|czech|romanian|hungarian|finnish|danish|norwegian|persian|filipino|tagalog|日本語|英語|中文|한국어|にほんご)(?![a-z])'

/**
 * Response-language directives. Memory must not decide the answer language
 * (that is R4's single fixed sentence), so these are refused rather than
 * stored (DESIGN §4.1, §9).
 */
const RESPONSE_LANGUAGE_DIRECTIVES: readonly RegExp[] = [
  new RegExp(
    `\\b(?:respond|reply|answer|write|speak|communicate|talk|output)\\b[^.\\n]{0,40}?\\b(?:in|using)\\s+(?:the\\s+)?${LANGUAGE_NAMES}`,
    'u',
  ),
  new RegExp(
    `\\b(?:response|reply|answer|output|communication)\\s+language\\s*(?:is|:|=)\\s*${LANGUAGE_NAMES}`,
    'u',
  ),
  new RegExp(`\\b(?:always|only|exclusively)\\s+(?:in\\s+)?${LANGUAGE_NAMES}`, 'u'),
  new RegExp(
    `\\b(?:use|prefer)\\s+(?:only\\s+)?${LANGUAGE_NAMES}(?=[^.\\n]{0,40}\\b(?:repl|answer|respons|output|message|communicat|words?))`,
    'u',
  ),
  new RegExp(
    `${LANGUAGE_NAMES}\\s*(?:で|にて)\\s*(?:回答|応答|返信|答え|書い|話し|出力|説明|お願い)`,
    'u',
  ),
  new RegExp(`(?:回答|応答|返信|出力|会話)(?:の言語)?\\s*(?:は|を)\\s*${LANGUAGE_NAMES}`, 'u'),
]

/** A whole PEM private-key block, replaced as one unit. */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu
/** A private-key header with no footer: still a secret. */
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gu
/** Userinfo inside a URL (`scheme://user:password@host`). */
const URL_CREDENTIAL = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/?#@]+)@/giu
/** OpenAI-style `sk-…` keys. */
const API_KEY = /\bsk-[A-Za-z0-9_-]{16,}/gu
/** AWS access key ids, long-lived (`AKIA`) and temporary (`ASIA`). */
const AWS_KEY = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu
/** GitHub personal, OAuth, user, server, refresh tokens, and fine-grained PATs. */
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu
/** Slack bot, user, app, refresh, and workspace tokens. */
const SLACK_TOKEN = /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/gu
/** Google API keys. */
const GOOGLE_KEY = /\bAIza[0-9A-Za-z_-]{10,}\b/gu
/** JSON Web Tokens (three base64url segments, header starting `eyJ`). */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/gu
/** `NAME_KEY=value`, `NAME_TOKEN: value`, `…_PASSWORD=…` and friends. */
const ENV_SECRET =
  /\b([A-Z][A-Z0-9_]{0,63}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PWD))\s*([:=])\s*("[^"]*"|'[^']*'|[^\s,;]{6,})/gu

/** A fenced code block, removed before the non-ASCII ratio is counted. */
const FENCED_CODE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gmu
/** An inline code span, removed before the non-ASCII ratio is counted. */
const INLINE_CODE = /`[^`\n]*`/gu

/** The rule order used by {@link ScanResult.findings} and {@link ScanResult.rules}. */
const RULE_ORDER: readonly ScanRule[] = [
  'control-char',
  'format-char',
  'bidi-char',
  'tag-char',
  'delimiter-line',
  'frame-tag',
  'template-token',
  'instruction-override',
  'response-language',
]

/**
 * Escape the frame tags this harness uses, closing and opening, so text that
 * reaches a snapshot cannot forge the surrounding frame (DESIGN §4.2). Content
 * that contains one is refused anyway; this is the second line of defense for
 * text assembled from several sources.
 * @param text - text to escape.
 * @returns the text with every frame tag written as entities.
 */
export function escapeFrameTagClosers(text: string): string {
  return text.replace(FRAME_TAG_ANY, (match: string, name: string) => {
    const closing = /^<\s*\//u.test(match)
    return `&lt;${closing ? '/' : ''}${name.toLowerCase()}&gt;`
  })
}

/**
 * Remove fenced code blocks and inline code spans. A code span is where
 * identifiers, paths, and quoted foreign text legitimately live, so it does not
 * count toward the non-ASCII ratio (DESIGN §4.1).
 * @param text - text to strip.
 * @returns the text with code spans replaced by spaces.
 */
export function stripCodeSpans(text: string): string {
  return text.replace(FENCED_CODE, ' ').replace(INLINE_CODE, ' ')
}

/**
 * Count non-ASCII code points against non-whitespace code points, ignoring code
 * spans (DESIGN §4.1, N6).
 * @param text - text to measure.
 * @returns a ratio in `[0, 1]`; `0` when there is nothing to count.
 */
export function nonAsciiRatio(text: string): number {
  let total = 0
  let nonAscii = 0
  for (const character of stripCodeSpans(text)) {
    if (/\s/u.test(character)) continue
    total += 1
    if ((character.codePointAt(0) as number) > 0x7f) nonAscii += 1
  }
  return total === 0 ? 0 : nonAscii / total
}

/** Describe one code point for a finding. */
function describeCharacter(character: string): string {
  const code = character.codePointAt(0) as number
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
}

/** The first code point in `text` that `pattern` matches, or undefined. */
function firstCharacter(text: string, pattern: RegExp): string | undefined {
  for (const character of text) {
    if (pattern.test(character)) return character
  }
  return undefined
}

/** The first match of `pattern` in `text`, or undefined. */
function firstMatch(text: string, pattern: RegExp): string | undefined {
  return pattern.exec(text)?.[0]
}

/** Collect character-level refusals from the raw text. */
function characterFindings(text: string, add: (rule: ScanRule, detail: string) => void): void {
  const control = firstCharacter(text, /[\u0000-\u001F\u007F-\u009F]/u)
  if (control !== undefined && isRejectedControlCharacter(control)) {
    add('control-char', describeCharacter(control))
  }
  const bidi = firstCharacter(text, BIDI_CONTROL)
  if (bidi !== undefined) add('bidi-char', describeCharacter(bidi))
  const tag = firstCharacter(text, TAG_CHARACTER)
  if (tag !== undefined) add('tag-char', describeCharacter(tag))
  const format = firstCharacter(text, /\p{Cf}/u)
  if (format !== undefined && isFormatCharacter(format)) {
    add('format-char', describeCharacter(format))
  }
}

/** Collect pattern-level refusals: line structure first, then the collapsed form. */
function patternFindings(text: string, add: (rule: ScanRule, detail: string) => void): void {
  // Whitespace collapse removes the newlines, so the delimiter test runs on the
  // Cf-stripped, NFKC form while the lines still exist.
  const stripped = stripFormatCharacters(text).normalize('NFKC')
  if (splitLines(stripped).some(line => isDelimiterLine(line))) {
    add('delimiter-line', '§ on a line of its own')
  }
  const normalized = normalizeForMatch(text)
  const frame = firstMatch(normalized, FRAME_TAG)
  if (frame !== undefined) add('frame-tag', frame)
  for (const token of TEMPLATE_TOKENS) {
    const match = firstMatch(normalized, token)
    if (match !== undefined) {
      add('template-token', match)
      break
    }
  }
  for (const override of INSTRUCTION_OVERRIDES) {
    const match = firstMatch(normalized, override)
    if (match !== undefined) {
      add('instruction-override', match)
      break
    }
  }
  for (const directive of RESPONSE_LANGUAGE_DIRECTIVES) {
    const match = firstMatch(normalized, directive)
    if (match !== undefined) {
      add('response-language', match)
      break
    }
  }
}

/** Apply one secret rule, recording the kind once when it matched. */
function applySecretRule(
  text: string,
  kinds: SecretKind[],
  kind: SecretKind,
  pattern: RegExp,
  // Every pattern below is matched with all of its capture groups participating.
  rewrite: (match: string, ...groups: string[]) => string,
): string {
  const next = text.replace(pattern, (match: string, ...groups: string[]) => rewrite(match, ...groups))
  if (next !== text && !kinds.includes(kind)) kinds.push(kind)
  return next
}

/** Whether a value already holds a redaction placeholder (do not nest them). */
function isAlreadyRedacted(value: string): boolean {
  const unquoted = value.replace(/^["']|["']$/gu, '')
  return unquoted.startsWith(REDACTION_PREFIX)
}

/**
 * Replace every recognized secret with `[REDACTED:<kind>]` (DESIGN §9).
 * @param text - raw text.
 * @returns the redacted text and the kinds that were replaced, in first-seen order.
 */
export function redactSecrets(text: string): { text: string; redacted: SecretKind[] } {
  const kinds: SecretKind[] = []
  let out = text
  out = applySecretRule(out, kinds, 'private-key', PRIVATE_KEY_BLOCK, () =>
    redactionPlaceholder('private-key'),
  )
  out = applySecretRule(out, kinds, 'private-key', PRIVATE_KEY_HEADER, () =>
    redactionPlaceholder('private-key'),
  )
  out = applySecretRule(
    out,
    kinds,
    'url-credential',
    URL_CREDENTIAL,
    (_match, scheme) => `${scheme}${redactionPlaceholder('url-credential')}@`,
  )
  out = applySecretRule(out, kinds, 'api-key', API_KEY, () => redactionPlaceholder('api-key'))
  out = applySecretRule(out, kinds, 'aws-key', AWS_KEY, () => redactionPlaceholder('aws-key'))
  out = applySecretRule(out, kinds, 'github-token', GITHUB_TOKEN, () =>
    redactionPlaceholder('github-token'),
  )
  out = applySecretRule(out, kinds, 'slack-token', SLACK_TOKEN, () =>
    redactionPlaceholder('slack-token'),
  )
  out = applySecretRule(out, kinds, 'google-key', GOOGLE_KEY, () =>
    redactionPlaceholder('google-key'),
  )
  out = applySecretRule(out, kinds, 'jwt', JWT, () => redactionPlaceholder('jwt'))
  out = applySecretRule(out, kinds, 'env-secret', ENV_SECRET, (match, name, separator, value) =>
    isAlreadyRedacted(value) ? match : `${name}${separator}${redactionPlaceholder('env-secret')}`,
  )
  return { text: out, redacted: kinds }
}

/**
 * Scan one piece of text (DESIGN §9). Secrets are replaced, never refused; the
 * non-ASCII ratio is advisory; everything else in the rule set refuses.
 * @param text - raw text, as written or as read from disk.
 * @returns the verdict, the redacted text, and the advisory ratio.
 */
export function scanText(text: string): ScanResult {
  const found = new Map<ScanRule, string>()
  const add = (rule: ScanRule, detail: string): void => {
    found.set(rule, detail)
  }
  characterFindings(text, add)
  patternFindings(text, add)
  const findings = RULE_ORDER.flatMap((rule) => {
    const detail = found.get(rule)
    return detail === undefined ? [] : [{ rule, detail }]
  })
  const { text: redactedText, redacted } = redactSecrets(text)
  const ratio = nonAsciiRatio(text)
  return {
    ok: findings.length === 0,
    findings,
    rules: findings.map(finding => finding.rule),
    text: redactedText,
    redacted,
    nonAsciiRatio: ratio,
    reviewSuggested: ratio > NON_ASCII_WARN_RATIO,
  }
}

/**
 * The frame tag names this module refuses and escapes, for consumers that build
 * their own report.
 * @returns the tag names.
 */
export function frameTagNames(): readonly string[] {
  return FRAME_TAG_NAMES
}
