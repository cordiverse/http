// modified from https://github.com/Kaciras/fetch-socks/blob/41cec5a02c36687279ad2628f7c46327f7ff3e2d/index.ts
// modified from https://github.com/TooTallNate/proxy-agents/blob/c881a1804197b89580320b87082971c3c6a61746/packages/socks-proxy-agent/src/index.ts

import {} from '@cordisjs/plugin-http'
import * as http from 'node:http'
import { lookup } from 'node:dns/promises'
import { Context, Schema, z } from 'cordis'
import { SocksClient, SocksProxy } from 'socks'
import { Agent, buildConnector, Dispatcher, ProxyAgent } from 'undici'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

declare module 'cordis' {
  interface Events {
    'http/dispatcher'(proxyURL: URL, requestURL: URL): Dispatcher | undefined
    'http/legacy-agent'(proxyURL: URL, requestURL: URL): http.Agent | undefined
  }
}

declare module '@cordisjs/plugin-http' {
  namespace HTTP {
    interface Intercept extends ProxyAgentConfig {}
  }
}

function resolvePort(protocol: string, port: string) {
  return port ? Number.parseInt(port) : protocol === 'http:' ? 80 : 443
}

function createConnect({ proxy, shouldLookup }: ParseResult, tlsOpts: buildConnector.BuildOptions = {}): buildConnector.connector {
  const { timeout = 10e3 } = tlsOpts
  const connect = buildConnector(tlsOpts)

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
  return new Agent({ ...rest, connect: createConnect(result, connect) })
}

export const name = 'proxy-agent'
export const inject = ['http']

type ProxyAgentConfig = Config

export interface Config {
  proxyAgent: string
}

export const Config: z<Config> = z.object({
  proxyAgent: Schema.string().description('代理服务器地址。'),
})

export function apply(ctx: Context, _config: Config) {
  ctx.http.schema?.extend(Config)

  ctx.on('http/fetch-init', (url, init, config) => {
    const proxy = config?.proxyAgent ?? _config.proxyAgent
    if (!proxy) return
    const agent = ctx.bail('http/dispatcher', new URL(proxy), url)
    if (!agent) throw new Error(`Cannot resolve proxy agent ${url}`)
    init['dispatcher'] = agent
  })

  ctx.on('http/dispatcher', (url) => {
    if (['http:', 'https:'].includes(url.protocol)) {
      return new ProxyAgent(url.href)
    }
    const result = parseSocksURL(url)
    if (!result) return
    return socksAgent(result)
  })

  ctx.on('http/websocket-init', (url, init, config) => {
    const proxy = config?.proxyAgent ?? _config.proxyAgent
    if (!proxy) return
    const agent = ctx.bail('http/legacy-agent', new URL(proxy), url)
    if (!agent) throw new Error(`Cannot resolve proxy agent ${url}`)
    init.agent = agent
  })

  ctx.on('http/legacy-agent', (proxy, url) => {
    if (['http:', 'https:'].includes(proxy.protocol)) {
      if (['http:', 'ws:'].includes(url.protocol)) {
        return new HttpProxyAgent(proxy)
      } else {
        return new HttpsProxyAgent(proxy)
      }
    }
    const result = parseSocksURL(proxy)
    if (!result) return
    return new SocksProxyAgent(proxy)
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

  const proxy: ParseResult['proxy'] = { host, port, type }
  if (url.username) proxy.userId = decodeURIComponent(url.username)
  if (url.password) proxy.password = decodeURIComponent(url.password)

  return { shouldLookup, proxy }
}
