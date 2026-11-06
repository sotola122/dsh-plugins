/**
 * Egress guard behavior: denylisted harness hosts are refused, and user-chosen
 * endpoints such as api.deepseek.com stay reachable.
 */

import { execFileSync } from 'node:child_process'
import { lookup } from 'node:dns'
import dnsPromises from 'node:dns/promises'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { forkDefaultPatches, forkLockPatches, guard } from '@anago-harness/fork-policy'

const guardFile = fileURLToPath(new URL('../egress-guard.cjs', import.meta.url))
const denylistFile = fileURLToPath(new URL('../denylist.json', import.meta.url))

/** Spawned children must not inherit a guard preload from the surrounding
 * harness: this repository's own web process sets NODE_OPTIONS, and the test
 * installs the guard explicitly so the startup state is deterministic. */
const spawnEnv: NodeJS.ProcessEnv = { ...process.env }
delete spawnEnv.NODE_OPTIONS

function errorText(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error)
  const message = 'message' in error && typeof error.message === 'string' ? error.message : ''
  const cause = 'cause' in error ? errorText(error.cause) : ''
  return `${message} ${cause}`
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function refused(error: unknown): boolean {
  return errorCode(error) === 'EDSHFORKFORBIDDEN'
    || errorCode(error) === 'ENOTFOUND' && errorText(error).includes('egress guard')
    || errorText(error).includes('egress guard')
}

async function expectBlocked(run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  } catch (error) {
    expect(refused(error), errorText(error)).toBe(true)
    return
  }
  throw new Error('expected the egress guard to refuse the connection')
}

function openSocket(port: number, host: string, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (error === undefined) resolve()
      else reject(error)
    }
    const socket = net.connect(port, host, () => { socket.write(payload) })
    socket.resume()
    socket.on('error', (error) => { finish(error) })
    socket.on('close', () => { finish() })
  })
}

function listen(): Promise<{ port: number; close: () => Promise<void>; received: string[] }> {
  const received: string[] = []
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      received.push(chunk.toString('latin1'))
      socket.end('HTTP/1.1 200 Connection Established\r\n\r\n')
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('test server did not bind a TCP port'))
        return
      }
      resolve({
        port: address.port,
        received,
        close: () => new Promise((done) => { server.close(() => { done() }) }),
      })
    })
  })
}

function listenSilently(): Promise<{ port: number; close: () => Promise<void>; received: string[] }> {
  const received: string[] = []
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => { received.push(chunk.toString('latin1')) })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('test server did not bind a TCP port'))
        return
      }
      resolve({
        port: address.port,
        received,
        close: () => new Promise((done) => { server.close(() => { done() }) }),
      })
    })
  })
}

describe('fork profile layers', () => {
  it('returns no patches', () => {
    expect(forkDefaultPatches([{ id: 'bundle' }])).toEqual([])
    expect(forkLockPatches([{ id: 'composed' }])).toEqual([])
  })
})

describe('egress guard', () => {
  let savedHttpsProxy: string | undefined
  let restoreHttpsProxy = false

  afterEach(() => {
    if (!restoreHttpsProxy) return
    if (savedHttpsProxy === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = savedHttpsProxy
    restoreHttpsProxy = false
  })

  function setHttpsProxy(value: string): void {
    if (!restoreHttpsProxy) {
      restoreHttpsProxy = true
      savedHttpsProxy = process.env.HTTPS_PROXY
    }
    process.env.HTTPS_PROXY = value
  }

  it('denies denylisted hosts and allows user-chosen endpoints', () => {
    expect(guard.verdict('platform.deepseek.com')).toMatch(/host /)
    expect(guard.verdict('DOWNLOAD.DEEPSEEK.COM.')).toMatch(/host /)
    expect(guard.verdict('dsh-otel-collector.deepseeksvc.com')).toMatch(/suffix /)
    expect(guard.verdict('registry.npm.harnessment.com')).toMatch(/suffix /)
    expect(guard.verdict('registry.npmmirror.com')).toMatch(/suffix /)
    expect(guard.verdict('hf-mirror.com')).toMatch(/suffix /)
    expect(guard.verdict('trtgsjkv6r.feishu.cn')).toMatch(/host /)
    for (const host of ['api.deepseek.com', 'API.DEEPSEEK.COM.', 'api.exa.ai', 'api.openai.com', 'registry.npmjs.org']) {
      expect(guard.verdict(host), host).toBeUndefined()
    }
    expect(guard.verdict('deepseek.com.example.org')).toBeUndefined()
    expect(guard.verdict('notdeepseeksvc.com')).toBeUndefined()
    expect(guard.verdict('127.0.0.1')).toBeUndefined()
    expect(guard.verdict('[::1]')).toBeUndefined()
    expect(guard.normalize(' API.DEEPSEEK.COM. ')).toBe('api.deepseek.com')
  })

  it('refuses connect, tls, https, and dns for denylisted hosts', async () => {
    await expectBlocked(() => fetch('https://platform.deepseek.com/'))
    await expectBlocked(() => fetch('https://dsh-otel-collector.deepseeksvc.com/v1/logs', { method: 'POST' }))
    await expectBlocked(() => fetch('https://registry.npmmirror.com/-/ping'))
    await expectBlocked(() => fetch('https://DOWNLOAD.DEEPSEEK.COM./dsh-desk/'))
    await expectBlocked(() => fetch('https://registry.npm.harnessment.com/'))
    await expectBlocked(() => new Promise((resolve, reject) => {
      const request = https.request('https://download.deepseek.com/', resolve)
      request.on('error', reject)
      request.end()
    }))
    await expectBlocked(() => new Promise((resolve, reject) => {
      const socket = net.connect(443, 'download-test.deepseek.com', () => { resolve(undefined) })
      socket.on('error', reject)
    }))
    await expectBlocked(() => new Promise((resolve, reject) => {
      const socket = tls.connect({ host: 'trtgsjkv6r.feishu.cn', port: 443, servername: 'trtgsjkv6r.feishu.cn' }, () => { resolve(undefined) })
      socket.on('error', reject)
    }))
    await expectBlocked(() => dnsPromises.lookup('hf-mirror.com'))
    await expectBlocked(() => new Promise((resolve, reject) => {
      lookup('download-test.deepseek.com', (error, address) => {
        if (error) reject(error)
        else resolve(address)
      })
    }))
    await expectBlocked(() => new Promise((resolve, reject) => {
      const socket = net.connect({
        host: 'platform.deepseek.com',
        port: 443,
        lookup: (host, options, callback) => {
          void host
          void options
          callback(null, '127.0.0.1', 4)
        },
      }, () => { resolve(undefined) })
      socket.on('error', reject)
    }))
  })

  it('reaches a local socket through an allowed hostname', async () => {
    // The allow path is proven without a live connection: resolution is replaced by a
    // local listen port, so the test does not depend on external network access.
    const server = await listen()
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const socket = net.connect({
          host: 'api.deepseek.com',
          port: server.port,
          lookup: (host, options, callback) => {
            void host
            if (options.all === true) callback(null, [{ address: '127.0.0.1', family: 4 }])
            else callback(null, '127.0.0.1', 4)
          },
        }, () => {
          socket.end('GET / HTTP/1.1\r\nHost: api.deepseek.com\r\n\r\n')
        })
        socket.resume()
        socket.on('error', (error) => {
          if (settled) return
          settled = true
          reject(error)
        })
        socket.on('close', () => {
          if (settled) return
          settled = true
          resolve()
        })
      })
      expect(server.received.join('')).toContain('api.deepseek.com')
    } finally {
      await server.close()
    }
  })

  it('inspects CONNECT and absolute-form targets sent to a proxy', async () => {
    const server = await listen()
    setHttpsProxy(`http://127.0.0.1:${String(server.port)}`)
    try {
      await expectBlocked(() => openSocket(
        server.port,
        '127.0.0.1',
        'CONNECT platform.deepseek.com:443 HTTP/1.1\r\nHost: platform.deepseek.com:443\r\n\r\n',
      ))
      await openSocket(
        server.port,
        '127.0.0.1',
        'CONNECT api.deepseek.com:443 HTTP/1.1\r\nHost: api.deepseek.com:443\r\n\r\n',
      )
      await expectBlocked(() => openSocket(
        server.port,
        '127.0.0.1',
        'GET https://download.deepseek.com/dsh-desk/ HTTP/1.1\r\nHost: download.deepseek.com\r\n\r\n',
      ))
      expect(server.received.some(chunk => chunk.includes('api.deepseek.com'))).toBe(true)
      expect(server.received.some(chunk => chunk.includes('platform.deepseek.com'))).toBe(false)
    } finally {
      await server.close()
    }
  })

  it('inspects a CONNECT request line split across writes', async () => {
    const server = await listenSilently()
    setHttpsProxy(`http://127.0.0.1:${String(server.port)}`)
    try {
      await expectBlocked(() => new Promise((resolve, reject) => {
        const socket = net.connect(server.port, '127.0.0.1', () => {
          socket.write('CONNECT platform.deepsee')
          setTimeout(() => {
            if (!socket.destroyed) socket.write('k.com:443 HTTP/1.1\r\nHost: platform.deepseek.com:443\r\n\r\n')
          }, 20)
        })
        socket.resume()
        socket.on('error', reject)
        socket.on('close', () => { resolve(undefined) })
      }))
      expect(server.received.join('')).not.toContain('platform.deepseek.com')
    } finally {
      await server.close()
    }
  })

  it('inspects a later request on a reused proxy connection', async () => {
    const server = await listenSilently()
    setHttpsProxy(`http://127.0.0.1:${String(server.port)}`)
    try {
      await expectBlocked(() => new Promise((resolve, reject) => {
        const socket = net.connect(server.port, '127.0.0.1', () => {
          socket.write('GET http://api.deepseek.com/ HTTP/1.1\r\nHost: api.deepseek.com\r\n\r\n')
          setTimeout(() => {
            if (!socket.destroyed) socket.write('GET http://platform.deepseek.com/ HTTP/1.1\r\nHost: platform.deepseek.com\r\n\r\n')
          }, 20)
        })
        socket.resume()
        socket.on('error', reject)
        socket.on('close', () => { resolve(undefined) })
      }))
      expect(server.received.join('')).toContain('api.deepseek.com')
      expect(server.received.join('')).not.toContain('platform.deepseek.com')
    } finally {
      await server.close()
    }
  })

  it('ignores an unparsable proxy value', async () => {
    const server = await listen()
    setHttpsProxy('not a url')
    try {
      await openSocket(server.port, '127.0.0.1', 'ping')
      expect(server.received.join('')).toContain('ping')
    } finally {
      await server.close()
    }
  })

  it('blocks a child through NODE_OPTIONS and records a refusal', () => {
    const directory = mkdtempSync(join(tmpdir(), 'egress-guard-'))
    const logFile = join(directory, 'blocked.log')
    try {
      const child = execFileSync(process.execPath, ['-e', `
        delete process.env.VITEST
        delete process.env.NODE_OPTIONS
        process.env.DSH_FORK_EGRESS_LOG = ${JSON.stringify(logFile)}
        require(${JSON.stringify(guardFile)})
        const { execFileSync } = require('node:child_process')
        const out = execFileSync(process.execPath, ['-e', "fetch('https://platform.deepseek.com').then(() => console.log('CHILD NOT BLOCKED'), error => console.log('child:' + ((error.cause && error.cause.code) || error.code)))"], { encoding: 'utf8' })
        process.stdout.write(out)
        if (!(process.env.NODE_OPTIONS ?? '').includes('--import=file://')) process.stdout.write('\\nNODE_OPTIONS missing\\n')
      `], { encoding: 'utf8', env: spawnEnv })
      expect(child).toContain('EDSHFORKFORBIDDEN')
      expect(child).not.toContain('NODE_OPTIONS missing')
      expect(readFileSync(logFile, 'utf8')).toContain('platform.deepseek.com')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('preloads children when the guard path contains spaces', () => {
    const directory = mkdtempSync(join(tmpdir(), 'egress guard-'))
    try {
      const copiedGuard = join(directory, 'egress-guard.cjs')
      copyFileSync(guardFile, copiedGuard)
      copyFileSync(denylistFile, join(directory, 'denylist.json'))
      const child = execFileSync(process.execPath, ['-e', `
        delete process.env.VITEST
        delete process.env.NODE_OPTIONS
        require(${JSON.stringify(copiedGuard)})
        const { execFileSync } = require('node:child_process')
        const out = execFileSync(process.execPath, ['-e', "fetch('https://platform.deepseek.com').then(() => console.log('CHILD NOT BLOCKED'), error => console.log('child:' + ((error.cause && error.cause.code) || error.code)))"], { encoding: 'utf8' })
        process.stdout.write(out)
      `], { encoding: 'utf8', env: spawnEnv })
      expect(child).toContain('EDSHFORKFORBIDDEN')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('guards the positional connect form without the private normalizer', () => {
    const output = execFileSync(process.execPath, ['-e', `
      delete process.env.VITEST
      delete process.env.NODE_OPTIONS
      const net = require('node:net')
      require(${JSON.stringify(guardFile)})
      delete net._normalizeArgs
      const socket = net.connect(443, 'platform.deepseek.com')
      socket.on('error', error => {
        if (error.code === 'EDSHFORKFORBIDDEN') process.exit(0)
        process.stderr.write(String(error.code))
        process.exit(3)
      })
      socket.on('connect', () => process.exit(2))
    `], { encoding: 'utf8', env: spawnEnv })
    expect(output).toBe('')
  })

  it('does not change NODE_OPTIONS when the test runner variable is set', () => {
    const output = execFileSync(process.execPath, ['-e', `
      process.env.VITEST = '1'
      delete process.env.NODE_OPTIONS
      require(${JSON.stringify(guardFile)})
      require(${JSON.stringify(guardFile)})
      if (process.env.NODE_OPTIONS !== undefined) process.exit(2)
      const net = require('node:net')
      const socket = net.connect(443, 'platform.deepseek.com')
      socket.on('error', error => {
        if (error.code === 'EDSHFORKFORBIDDEN') process.exit(0)
        process.stderr.write(String(error.code))
        process.exit(3)
      })
    `], { encoding: 'utf8', env: spawnEnv })
    expect(output).toBe('')
  })
})
