/**
 * SSH local forward for the OpenAI Codex browser callback.
 *
 * The callback listens on the harness host's loopback. A browser on another
 * machine reaches it only when that machine forwards the same port here.
 * @module
 */

import { hostname, userInfo } from 'node:os'

/** The port pi-ai's `openai-codex` browser flow listens on. The value is fixed by that flow rather than configurable here. */
export const CODEX_CALLBACK_PORT = 1455

/**
 * Render the SSH local forward a browser machine runs to reach the Codex callback.
 *
 * Both ends use `port`. The remote side is the harness host's loopback.
 * @param user - login name on the harness host.
 * @param host - harness host the browser machine can reach.
 * @param port - callback port on the browser machine and on the harness loopback.
 * @returns `ssh -N -L <port>:127.0.0.1:<port> <user>@<host>`, with no surrounding text.
 */
export function sshLocalForwardCommand(user: string, host: string, port: number): string {
  return `ssh -N -L ${port}:127.0.0.1:${port} ${user}@${host}`
}

/**
 * SSH local forward for this process, on the Codex callback port.
 *
 * Uses `userInfo().username` when that call succeeds. When it throws (no passwd
 * entry for this uid), uses `USER`, then `LOGNAME`, then `user`, so a missing
 * login name cannot fail the command that prints the hint. Always uses `hostname()`.
 * Does not open a connection.
 * @returns the command {@link sshLocalForwardCommand} renders for those values and {@link CODEX_CALLBACK_PORT}.
 */
export function currentSshLocalForwardCommand(): string {
  const host = hostname()
  try {
    return sshLocalForwardCommand(userInfo().username, host, CODEX_CALLBACK_PORT)
  } catch (error: unknown) {
    void error // userInfo() throws when this uid has no passwd entry; the hint must still render.
    return sshLocalForwardCommand(process.env.USER ?? process.env.LOGNAME ?? 'user', host, CODEX_CALLBACK_PORT)
  }
}
