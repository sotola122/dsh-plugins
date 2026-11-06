/**
 * The wiki skill (DESIGN §6.1, §11 order 3).
 *
 * The body is shipped as `SKILL.md` next to the package's `lib/`, and read here
 * once at plugin load: a person can read and edit the convention in place, and
 * there is exactly one copy of the text. The frontmatter is stripped before
 * registration — `SkillRegistration` carries `name` and `description` as
 * fields, and leaving a second copy of them in the body would show up in every
 * session that loads the skill.
 *
 * The skill is model- and user-invocable (the registry defaults), so it appears
 * in the skill catalog as one line and is loaded on demand. It is **not**
 * injected: the only thing a session gets unasked is the existence notice.
 * @module @anago-harness/llm-wiki/skill
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

/** Skill name, matching `SKILL.md`'s frontmatter (kebab-case). */
export const SKILL_NAME = 'llm-wiki'

/** One-line routing description for the skill catalog. */
export const SKILL_DESCRIPTION =
  'Search and maintain the LLM wikis: wiki_search finds what they already say, .dsh/wiki holds the project wiki, and wiki_lint checks the result.'

/** Extra routing guidance shown with the catalog entry. */
export const SKILL_WHEN_TO_USE =
  'The user asks to ingest, look up, summarise, or correct something in the project wiki, or a page has to be written back after a session produced durable knowledge.'

/** Where the body lives, relative to this module. */
const SKILL_FILE = 'SKILL.md'

/**
 * Read the skill body from disk.
 *
 * `lib/index.js` and `src/skill.ts` both sit one directory below the package
 * root, so one relative path serves the built plugin and the test run. The
 * lookup is not silent: a missing file means the package was installed without
 * `SKILL.md`, and a skill with no body is worse than a startup error.
 * @param url - `import.meta.url` of the module asking.
 * @returns the body with its frontmatter removed.
 * @throws when `SKILL.md` cannot be read.
 */
export function loadSkillBody(url: string): string {
  const path = fileURLToPath(new URL(`../${SKILL_FILE}`, url))
  const text = readFileSync(path, 'utf8')
  return stripFrontmatter(text)
}

/**
 * Remove a leading YAML frontmatter block, leaving the Markdown body.
 * @param text - the file content.
 * @returns the body, without leading blank lines.
 */
export function stripFrontmatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u.exec(text)
  return (match === null ? text : text.slice(match[0].length)).replace(/^\s*\n/u, '')
}

/**
 * Build the registration `ctx.skills.register` accepts (DESIGN §6.1).
 *
 * The body is read lazily and memoized, so a plugin that is loaded but never
 * asked for the skill does one `readFileSync` at load time and nothing after.
 * @param url - `import.meta.url` used to locate `SKILL.md`; injectable for tests.
 * @returns the registration.
 */
export function createSkillRegistration(url: string): SkillRegistration {
  return {
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    source: 'runtime',
    content: loadSkillBody(url),
  }
}
