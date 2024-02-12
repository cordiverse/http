// modified from https://github.com/Kaciras/fetch-socks/blob/41cec5a02c36687279ad2628f7c46327f7ff3e2d/index.ts
// modified from https://github.com/TooTallNate/proxy-agents/blob/c881a1804197b89580320b87082971c3c6a61746/packages/socks-proxy-agent/src/index.ts

import {} from 'undios'
import { lookup } from 'node:dns/promises'
import { Context, z } from 'cordis'
import { SocksClient, SocksProxy } from 'socks'
import type { Agent, buildConnector, Client } from 'undici'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { defineProperty } from 'cosmokit'

// @ts-ignore
// ensure the global dispatcher is initialized
fetch().catch(() => {})

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

function createConnect({ proxy, shouldLookup }: ParseResult, tlsOpts: buildConnector.BuildOptions = {}): buildConnector.connector {
  const { timeout = 10e3 } = tlsOpts
  const connect = build(tlsOpts)

  return async (options, callback) => {
    let { protocol, hostname, port, httpSocket } = options

    try {
      if (shouldLookup) {
        hostname = (await lookup(hostname)).address
      }
      const event = await SocksClient.createConnection({
        command: 'connect',
        proxy,
        timeout,
        destination: {
          host: hostname,
          port: resolvePort(protocol, port),
        },
        existing_socket: httpSocket,
      })
      httpSocket = event.socket
    } catch (error: any) {
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

function socksAgent(result: ParseResult, options: SocksDispatcherOptions = {}) {
  const { connect, ...rest } = options
  return new AgentConstructor({ ...rest, connect: createConnect(result, connect) })
}

export const name = 'http-socks'

export interface Config {}

export const Config: z<Config> = z.object({})

export function apply(ctx: Context, config: Config) {
  ctx.on('http/dispatcher', (url) => {
    const result = parseSocksURL(url)
    if (!result) return
    return socksAgent(result)
  })

  ctx.on('http/legacy-agent', (url) => {
    const result = parseSocksURL(url)
    if (!result) return
    return new SocksProxyAgent(url)
  })
}

interface ParseResult {
  shouldLookup: boolean
  proxy: SocksProxy & { host: string }
}

function parseSocksURL(url: URL): ParseResult | undefined {
  let shouldLookup = false
  let type: SocksProxy['type']

  // From RFC 1928, Section 3: https://tools.ietf.org/html/rfc1928#section-3
  // "The SOCKS service is conventionally located on TCP port 1080"
  const port = parseInt(url.port, 10) || 1080
  const host = url.hostname

  // figure out if we want socks v4 or v5, based on the "protocol" used.
  // Defaults to 5.
  switch (url.protocol.replace(':', '')) {
    case 'socks4':
      shouldLookup = true
    // eslint-disable-next-line no-fallthrough
    case 'socks4a':
      type = 4
      break
    case 'socks5':
      shouldLookup = true
    // eslint-disable-next-line no-fallthrough
    case 'socks':
    case 'socks5h':
      type = 5
      break
    default: return
  }

  const proxy: SocksProxy = { host, port, type }
  if (url.username) defineProperty(proxy, 'userId', decodeURIComponent(url.username))
  if (url.password) defineProperty(proxy, 'password', decodeURIComponent(url.password))

  return { shouldLookup, proxy }
}
