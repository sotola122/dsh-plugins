/**
 * The narrow view of an Agent this plugin needs (DESIGN §6.2, §6.4).
 *
 * Everything here is structural, so a fake agent in a unit test satisfies the
 * same interface as the real one. The plugin reads the session header — the
 * working directory the containment rule uses, and the delegation depth that
 * makes a child read-only — and nothing else.
 * @module @anago-harness/llm-wiki/agents
 */

/** The session facts the wiki plugin reads. */
export interface WikiSession {
  /** Durable creation metadata: where the session runs and how it was composed. */
  readonly header: WikiSessionHeader
  /** The session's identity, used in diagnostics. */
  readonly id?: string
  /**
   * The derived model-visible history. Compaction replaces surface ranges, so a
   * message that is absent from this list is no longer visible to the model —
   * which is exactly the notice's "already injected" test (DESIGN §6.6, S11).
   */
  deriveMessages?(): readonly { readonly role: string; readonly source: { readonly kind: string } }[]
}

/** The header fields this plugin reads (DESIGN §6.2, §6.4). */
export interface WikiSessionHeader {
  /**
   * Absolute working directory the session was created in. The wiki is
   * writable only while `<checkoutRoot>/.dsh/wiki` sits inside it (DESIGN
   * §6.2); it is never used to *find* the wiki, which always comes from
   * `git rev-parse --show-toplevel` in this directory.
   */
  readonly cwd?: string
  /** Absent (zero) for a top-level session, parent depth + 1 for a subagent child. */
  readonly delegationDepth?: number
  /** Id of the agent preset this session was composed from. */
  readonly agentPreset?: string
}

/** The structural agent the plugin accepts. The real `Agent` satisfies it. */
export interface WikiAgent {
  /** The live session this agent drives. */
  readonly session: WikiSession
}

/**
 * The session's delegation depth (DESIGN §6.4).
 * @param agent - the calling agent.
 * @returns a non-negative depth; a session without the field is top-level.
 */
export function delegationDepthOf(agent: WikiAgent): number {
  return agent.session.header.delegationDepth ?? 0
}

/**
 * The directory the checkout root is resolved from (DESIGN §6.2).
 * @param agent - the calling agent.
 * @returns the directory, or undefined when the session recorded none.
 */
export function cwdOf(agent: WikiAgent): string | undefined {
  const cwd = agent.session.header.cwd
  return cwd === undefined || cwd === '' ? undefined : cwd
}

/**
 * The session's agent preset id, when the deployment composes per session.
 * @param agent - the calling agent.
 * @returns the preset id, or undefined.
 */
export function presetOf(agent: WikiAgent): string | undefined {
  return agent.session.header.agentPreset
}
