/**
 * The narrow view of an Agent this plugin needs (DESIGN §4.2, §4.4, §5.1).
 *
 * The plugin never reaches into the driver: it reads the session header (cwd,
 * delegation depth, preset) and the derived surface, and it hands the agent
 * back to Cordis when it restricts the tool. Everything here is structural, so
 * a fake agent in a unit test satisfies the same interface as the real one.
 * @module @anago-harness/memory/agents
 */

import type { Message } from '@deepseek-ai/dsh-llm'

/** The session facts the memory plugin reads. */
export interface MemorySession {
  /**
   * The session's identity. It is recorded in a staged operation so a person
   * can tell which session asked for it; ids are not unique across machines
   * (DESIGN §4.7 makes the same point about the review sidecar).
   */
  readonly id?: string
  /** Durable creation metadata: where the session runs and how it was composed. */
  readonly header: MemorySessionHeader
  /**
   * The derived model-visible history. Compaction replaces surface ranges, so a
   * message that is absent from this list is no longer visible to the model —
   * which is exactly the snapshot's "already injected" test (DESIGN §4.2, S11).
   */
  deriveMessages(): readonly Message[]
}

/** The header fields this plugin reads (DESIGN §5.1, S12, S13, §4.4). */
export interface MemorySessionHeader {
  /** Absolute working directory the session was created in. */
  readonly cwd?: string
  /** Absent (zero) for a top-level session, parent depth + 1 for a subagent child. */
  readonly delegationDepth?: number
  /** Id of the agent preset this session was composed from. */
  readonly agentPreset?: string
}

/** The structural agent the plugin accepts. The real `Agent` satisfies it. */
export interface MemoryAgent {
  /** The live session this agent drives. */
  readonly session: MemorySession
}

/**
 * The session's delegation depth (DESIGN §4.4, S13).
 * @param agent - the calling agent.
 * @returns a non-negative depth; a session without the field is top-level.
 */
export function delegationDepthOf(agent: MemoryAgent): number {
  return agent.session.header.delegationDepth ?? 0
}

/**
 * The session's agent preset id, when the deployment composes per session.
 * @param agent - the calling agent.
 * @returns the preset id, or undefined.
 */
export function presetOf(agent: MemoryAgent): string | undefined {
  return agent.session.header.agentPreset
}

/**
 * The directory the workspace store is resolved from (DESIGN §5.1).
 *
 * `SessionHeader.cwd` is the same value the filesystem sandbox treats as the
 * write boundary (S18), and a subagent's header carries the parent's current
 * working directory at creation (S12), so this is the one directory that keeps
 * a session, its sandbox, and its children on the same repository.
 * @param agent - the calling agent.
 * @returns the directory, or undefined when the session recorded none.
 */
export function cwdOf(agent: MemoryAgent): string | undefined {
  const cwd = agent.session.header.cwd
  return cwd === undefined || cwd === '' ? undefined : cwd
}
