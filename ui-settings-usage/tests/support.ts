/** Loopback fake provider APIs and a guard that fails a spec reaching any other host. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, expect, vi } from 'vitest'

const servers: Server[] = []

/** Close every fake API this file's spec started. */
export async function closeFakeApis(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => { resolve() })
  })))
}

/**
 * Start a fake API on an ephemeral loopback port; {@link closeFakeApis} closes it.
 * @param handler - answers each request.
 * @returns the requests it received and its URL.
 */
export async function fakeApi(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const requests: IncomingMessage[] = []
  const server = createServer((request, response) => {
    requests.push(request)
    handler(request, response)
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { requests, endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/usage` }
}

/**
 * A handler answering every request with one JSON body.
 * @param status - the HTTP status.
 * @param body - the JSON body.
 * @returns the handler.
 */
export function respondJson(status: number, body: unknown) {
  return (_request: IncomingMessage, response: ServerResponse): void => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
}

/** Fail the calling spec when code under test requests anything but a loopback fake API. */
export function forbidExternalNetwork(): void {
  const external: string[] = []
  const realFetch = globalThis.fetch
  beforeEach(() => {
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
      const url = new URL(input)
      if (url.hostname === '127.0.0.1') return realFetch(input, init)
      external.push(url.hostname)
      return Promise.reject(new Error('external network is forbidden in this spec'))
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    expect(external.splice(0)).toEqual([])
  })
}
