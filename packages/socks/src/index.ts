// modified from https://github.com/Kaciras/fetch-socks/blob/41cec5a02c36687279ad2628f7c46327f7ff3e2d/index.ts
// modified from https://github.com/TooTallNate/proxy-agents/blob/c881a1804197b89580320b87082971c3c6a61746/packages/socks-proxy-agent/src/index.ts

import {} from '@cordisjs/plugin-http'
import { Context, z } from 'cordis'
import { SocksClient, SocksProxy } from 'socks'
import type { Agent, buildConnector, Client } from 'undici'
import { SocksProxyAgent } from 'socks-proxy-agent'

function getUniqueSymbol(object: object, name: string) {
  const symbol = Object.getOwnPropertySymbols(object).find(s => s.toString() === `Symbol(${name})`)
  return object[symbol!]
}

const kGlobalDispatcher = Symbol.for('undici.globalDispatcher.1')
const globalAgent = globalThis[kGlobalDispatcher] as Agent
const AgentConstructor = globalAgent.constructor as typeof Agent
const factory = getUniqueSymbol(globalAgent, 'factory') as NonNullable<Agent.Options['factory']>

function build(options: buildConnector.BuildOptions) {
  const client = factory('http://0.0.0.0', { connections: 1, connect: options }) as Client
  return getUniqueSymbol(client, 'connector') as buildConnector.connector
}

function resolvePort(protocol: string, port: string) {
  return port ? Number.parseInt(port) : protocol === 'http:' ? 80 : 443
}

function socksConnector(proxy: SocksProxy, tlsOpts: buildConnector.BuildOptions = {}): buildConnector.connector {
  const { timeout = 10e3 } = tlsOpts
  const connect = build(tlsOpts)

  return async (options, callback) => {
    let { protocol, hostname, port, httpSocket } = options

    const destination = {
      host: hostname,
      port: resolvePort(protocol, port),
    }

    const socksOpts = {
      command: 'connect' as const,
      proxy,
      timeout,
      destination,
      existing_socket: httpSocket,
    }

    try {
      const r = await SocksClient.createConnection(socksOpts)
      httpSocket = r.socket
    } catch (error) {
      // @ts-ignore
      return callback(error, null)
    }

    if (httpSocket && protocol !== 'https:') {
      return callback(null, httpSocket.setNoDelay())
    }

    return connect({ ...options, httpSocket }, callback)
  }
}

interface SocksDispatcherOptions extends Agent.Options {
  connect?: buildConnector.BuildOptions
}

function socksDispatcher(proxies: SocksProxy, options: SocksDispatcherOptions = {}) {
  const { connect, ...rest } = options
  return new AgentConstructor({ ...rest, connect: socksConnector(proxies, connect) })
}

export const name = 'http-socks'

export interface Config {}

export const Config: z<Config> = z.object({})

export function apply(ctx: Context, config: Config) {
  ctx.on('http/dispatcher', (href) => {
    const url = new URL(href)
    try {
      const { proxy } = parseSocksURL(url)
      return socksDispatcher(proxy)
    } catch {}
  })

  ctx.on('http/http-agent', (href) => {
    try {
      return new SocksProxyAgent(href)
    } catch {}
  })
}

function parseSocksURL(url: URL): { lookup: boolean; proxy: SocksProxy } {
  let lookup = false
  let type: SocksProxy['type'] = 5
  const host = url.hostname

  // From RFC 1928, Section 3: https://tools.ietf.org/html/rfc1928#section-3
  // "The SOCKS service is conventionally located on TCP port 1080"
  const port = parseInt(url.port, 10) || 1080

  // figure out if we want socks v4 or v5, based on the "protocol" used.
  // Defaults to 5.
  switch (url.protocol.replace(':', '')) {
    case 'socks4':
      lookup = true
      type = 4
      break
      // pass through
    case 'socks4a':
      type = 4
      break
    case 'socks5':
      lookup = true
      type = 5
      break
      // pass through
    case 'socks': // no version specified, default to 5h
      type = 5
      break
    case 'socks5h':
      type = 5
      break
    default:
      throw new TypeError(
        `A "socks" protocol must be specified! Got: ${String(
          url.protocol,
        )}`,
      )
  }

  const proxy: SocksProxy = {
    host,
    port,
    type,
  }

  if (url.username) {
    Object.defineProperty(proxy, 'userId', {
      value: decodeURIComponent(url.username),
      enumerable: false,
    })
  }

  if (url.password != null) {
    Object.defineProperty(proxy, 'password', {
      value: decodeURIComponent(url.password),
      enumerable: false,
    })
  }

  return { lookup, proxy }
}
