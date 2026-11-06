'use strict'

// Installs once in the host process. Blocks TCP connects, DNS lookups, and proxy
// request targets whose hostname matches denylist.json. No environment variable
// disables that denylist.

function requireWorkerOptional(specifier) {
  try {
    return require(specifier)
  } catch (error) {
    // The preview worker's builtin table has no DNS resolver and no
    // single-file executable API. The host process has both.
    if (error instanceof Error && error.message.includes('no static module is registered')) return undefined
    throw error
  }
}

const net = require('node:net')
const dns = requireWorkerOptional('node:dns')
const { syncBuiltinESMExports } = require('node:module')
const { domainToASCII, pathToFileURL } = require('node:url')
const { readFileSync, appendFileSync, writeSync, mkdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const sea = requireWorkerOptional('node:sea')
const isSea = sea === undefined ? () => false : sea.isSea

const GUARD = Symbol.for('dsh-fork.egress-guard')
if (!globalThis[GUARD]) install()

function install() {
  const rules = JSON.parse(readFileSync(join(__dirname, 'denylist.json'), 'utf8'))
  const suffixes = Object.values(rules.suffixes).flat()
  const hosts = new Set(rules.hosts)
  const logFile = process.env.DSH_FORK_EGRESS_LOG

  function normalize(host) {
    let normalized = String(host ?? '').trim().toLowerCase()
    if (normalized.startsWith('[') && normalized.endsWith(']')) normalized = normalized.slice(1, -1)
    while (normalized.endsWith('.')) normalized = normalized.slice(0, -1)
    if (net.isIP(normalized)) return normalized
    return domainToASCII(normalized) || normalized
  }

  function isLoopbackOrLocal(host) {
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./u.test(host) || host === '0.0.0.0'
  }

  function verdict(rawHost) {
    const host = normalize(rawHost)
    if (host === '' || isLoopbackOrLocal(host)) return undefined
    if (net.isIP(host)) return undefined
    if (hosts.has(host)) return `host ${host}`
    for (const suffix of suffixes) if (host === suffix || host.endsWith(`.${suffix}`)) return `suffix ${suffix}`
    return undefined
  }

  function emit(label, fields) {
    const line = JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...fields })
    try {
      writeSync(2, `dsh-fork egress-guard: ${label} ${line}\n`)
    } catch (error) {
      // stderr may already be closed; the refusal does not depend on this line.
      void error
    }
    if (logFile) {
      try {
        appendFileSync(logFile, `${line}\n`)
      } catch (error) {
        // A log-file failure must not replace the refusal.
        void error
      }
    }
  }

  function report(kind, host, reason) {
    emit('BLOCKED', { kind, host: normalize(host), reason })
  }

  function reportStartup(kind, error) {
    emit('STARTUP', { kind, detail: error instanceof Error ? error.message : String(error) })
  }

  function forbiddenError(host, reason) {
    const error = new Error(`dsh-fork egress guard blocked ${normalize(host)} (${reason})`)
    error.code = 'EDSHFORKFORBIDDEN'
    return error
  }

  // Proxy endpoints this process may tunnel through. Read on each connect because
  // the resolved proxy policy is published into process.env after startup.
  function proxyHosts() {
    const proxies = new Set()
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
      const value = process.env[name]
      if (!value) continue
      try {
        proxies.add(normalize(new URL(value).hostname))
      } catch (error) {
        // An unparsable proxy value is not a tunnel this process can use.
        void error
      }
    }
    return proxies
  }

  // The host a proxy request line names, when the denylist refuses it.
  function proxyTarget(line) {
    const match = /^CONNECT\s+(\[[^\]]+\]|[^\s:]+)/u.exec(line)
      ?? /^[A-Z]+\s+[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\]|[^\s/:?#]+)/iu.exec(line)
    if (match === null) return undefined
    const host = match[1]
    const reason = verdict(host)
    return reason === undefined ? undefined : { host, reason }
  }

  const proxySocket = Symbol('dsh-fork.proxy-socket')
  const proxyHead = Symbol('dsh-fork.proxy-head')
  const originalConnect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function connect(...args) {
    const options = connectOptions(args)
    // A socket may reconnect to a different target; start every connection with clean
    // proxy state so a previous tunnel is not reused.
    this[proxySocket] = false
    this[proxyHead] = null
    if (options.path === undefined) {
      const host = options.host ?? 'localhost'
      const reason = verdict(host)
      if (reason !== undefined) {
        report('connect', host, reason)
        const error = forbiddenError(host, reason)
        process.nextTick(() => this.destroy(error))
        return this
      }
      if (proxyHosts().has(normalize(host))) {
        this[proxySocket] = true
        this[proxyHead] = ''
      }
    }
    return originalConnect.apply(this, args)
  }

  function refuseTarget(socket, target) {
    report('proxy-target', target.host, target.reason)
    socket.destroy(forbiddenError(target.host, target.reason))
    return false
  }

  // A proxy reads request lines from one socket. Reassemble the first line across
  // writes because a client may split it, then inspect the start of every later write
  // because a keep-alive proxy connection carries one request line per write.
  const proxyHeadLimit = 8 * 1024
  const originalWrite = net.Socket.prototype.write
  net.Socket.prototype.write = function write(chunk, ...rest) {
    if (this[proxySocket] === true) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('latin1') : String(chunk)
      if (this[proxyHead] === null) {
        const target = proxyTarget(text.slice(0, 512))
        if (target !== undefined) return refuseTarget(this, target)
      } else {
        const pending = `${this[proxyHead]}${text}`
        const end = pending.search(/\r?\n/u)
        if (end === -1 && pending.length <= proxyHeadLimit) {
          this[proxyHead] = pending
        } else {
          this[proxyHead] = null
          const target = proxyTarget(end === -1 ? pending : pending.slice(0, end))
          if (target !== undefined) return refuseTarget(this, target)
        }
      }
    }
    return originalWrite.call(this, chunk, ...rest)
  }

  const wrapCallback = (name, original) => function wrapped(hostname, ...rest) {
    const reason = verdict(hostname)
    if (reason !== undefined) {
      report(`dns.${name}`, hostname, reason)
      const callback = rest.at(-1)
      if (typeof callback === 'function') {
        process.nextTick(callback, Object.assign(forbiddenError(hostname, reason), { code: 'ENOTFOUND' }))
        return {}
      }
      throw forbiddenError(hostname, reason)
    }
    return original.call(this, hostname, ...rest)
  }

  const wrapPromise = (name, original) => async function wrapped(hostname, ...rest) {
    const reason = verdict(hostname)
    if (reason !== undefined) {
      report(`dns.promises.${name}`, hostname, reason)
      throw Object.assign(forbiddenError(hostname, reason), { code: 'ENOTFOUND' })
    }
    return original.call(this, hostname, ...rest)
  }

  const callbackNames = ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveTxt', 'resolveSrv', 'resolveCaa', 'resolveNaptr', 'resolvePtr', 'resolveSoa']
  if (dns !== undefined) {
    for (const name of callbackNames) {
      if (typeof dns[name] === 'function') dns[name] = wrapCallback(name, dns[name])
      if (typeof dns.Resolver.prototype[name] === 'function') dns.Resolver.prototype[name] = wrapCallback(name, dns.Resolver.prototype[name])
      if (typeof dns.promises[name] === 'function') dns.promises[name] = wrapPromise(name, dns.promises[name])
      if (typeof dns.promises.Resolver.prototype[name] === 'function') dns.promises.Resolver.prototype[name] = wrapPromise(name, dns.promises.Resolver.prototype[name])
    }
  }
  syncBuiltinESMExports()

  // Node children inherit the guard through NODE_OPTIONS. The preload is a file URL
  // because NODE_OPTIONS splits options on spaces and does not honor quoting, so a
  // guard under a path with spaces would otherwise break every child at startup. The
  // test runner sets VITEST; leaving its child options unchanged does not disable the
  // denylist in the process that loaded this file. A single-file executable stores
  // this file in a snapshot path a separate Node process cannot load, so it
  // materializes a real copy first and reports a failure to copy.
  const preload = childPreload()
  if (preload.error !== undefined) reportStartup('child-preload', preload.error)
  const preloadOption = preload.path === undefined ? '' : `--import=${pathToFileURL(preload.path).href}`
  const nodeOptions = process.env.NODE_OPTIONS ?? ''
  if (process.env.VITEST === undefined && preloadOption !== '' && !nodeOptions.includes(preloadOption)) {
    process.env.NODE_OPTIONS = `${nodeOptions} ${preloadOption}`.trim()
  }

  Object.defineProperty(globalThis, GUARD, { value: Object.freeze({ verdict, normalize }), enumerable: false })
}

/**
 * Read the target a `connect` call names.
 * Uses Node's private argument normalizer while it exists and the documented positional forms otherwise;
 * a form this parser cannot read reports no host, and a hostname connect still reaches the DNS guard.
 * @param args - Arguments passed to `net.Socket.prototype.connect`.
 * @returns The connect options object.
 */
function connectOptions(args) {
  const normalizeArgs = net._normalizeArgs
  const normalized = typeof normalizeArgs === 'function' ? normalizeArgs(args) : args
  const first = normalized[0]
  if (Array.isArray(first)) return first[0] ?? {}
  if (first !== null && typeof first === 'object') return first
  if (typeof first === 'string' && !/^[0-9]+$/u.test(first)) return { path: first }
  const options = { port: first }
  const second = normalized[1]
  if (typeof second === 'string') options.host = second
  else if (second !== null && typeof second === 'object') Object.assign(options, second, { port: first })
  return options
}

/**
 * Resolve the file a Node child process loads before its own entry.
 * @returns The preload path, or the failure that prevented copying it out of a single-file executable.
 */
function childPreload() {
  if (!isSea()) return { path: __filename }
  try {
    return { path: materializeGuard() }
  } catch (error) {
    return { error }
  }
}

/**
 * Copy the guard and its denylist where a separate Node process can load them.
 * The directory name carries a digest of the copied content, so repeat launches reuse one directory
 * instead of accumulating them, and an existing file is never overwritten while a child reads it.
 * @returns The copied guard path.
 */
function materializeGuard() {
  const source = readFileSync(__filename)
  const denylist = readFileSync(join(__dirname, 'denylist.json'))
  const directory = join(tmpdir(), `dsh-fork-guard-${digestOf(source, denylist)}`)
  mkdirSync(directory, { recursive: true })
  writeOnce(join(directory, 'denylist.json'), denylist)
  const guardFile = join(directory, 'egress-guard.cjs')
  writeOnce(guardFile, source)
  return guardFile
}

/**
 * Stable short digest of the materialized content.
 * A 32-bit FNV-1a avoids depending on `node:crypto`, which the preview worker does not provide.
 * @param parts - File contents that identify one guard version.
 * @returns Eight hexadecimal digits.
 */
function digestOf(...parts) {
  let hash = 0x811c9dc5
  for (const part of parts) {
    for (const byte of part) {
      hash ^= byte
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Write a materialized guard file unless another process already wrote the same content.
 * @param file - Destination path.
 * @param content - File bytes.
 */
function writeOnce(file, content) {
  try {
    writeFileSync(file, content, { flag: 'wx' })
  } catch (error) {
    // A concurrent launch materialized the same digest; its copy is identical.
    if (error.code !== 'EEXIST') throw error
  }
}

module.exports = { guard: globalThis[GUARD] }
