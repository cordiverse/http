import { Context } from 'cordis'
import { base64ToArrayBuffer, defineProperty, Dict, trimSlash } from 'cosmokit'
import { ClientOptions } from 'ws'
import { loadFile, lookup, WebSocket } from '@cordisjs/plugin-http/adapter'
import { isLocalAddress } from './utils.ts'
import type * as undici from 'undici'
import type * as http from 'http'

declare module 'cordis' {
  interface Context {
    http: HTTP
  }

  interface Intercept {
    http: HTTP.Config
  }

  interface Events {
    'http/dispatcher'(url: URL): undici.Dispatcher | undefined
    'http/http-agent'(url: URL): http.Agent | undefined
  }
}

const kHTTPError = Symbol.for('cordis.http.error')

class HTTPError extends Error {
  [kHTTPError] = true
  response?: HTTP.Response

  static is(error: any): error is HTTPError {
    return !!error?.[kHTTPError]
  }
}

export interface HTTP {
  <T>(url: string | URL, config?: HTTP.RequestConfig): Promise<HTTP.Response<T>>
  <T>(method: HTTP.Method, url: string | URL, config?: HTTP.RequestConfig): Promise<HTTP.Response<T>>
  config: HTTP.Config
  get: HTTP.Request1
  delete: HTTP.Request1
  patch: HTTP.Request2
  post: HTTP.Request2
  put: HTTP.Request2
}

export namespace HTTP {
  export type Method =
    | 'get' | 'GET'
    | 'delete' | 'DELETE'
    | 'head' | 'HEAD'
    | 'options' | 'OPTIONS'
    | 'post' | 'POST'
    | 'put' | 'PUT'
    | 'patch' | 'PATCH'
    | 'purge' | 'PURGE'
    | 'link' | 'LINK'
    | 'unlink' | 'UNLINK'

  export type ResponseType =
    | 'arraybuffer'
    | 'json'
    | 'text'
    | 'stream'

  export interface Request1 {
    (url: string, config?: HTTP.RequestConfig & { responseType: 'arraybuffer' }): Promise<ArrayBuffer>
    (url: string, config?: HTTP.RequestConfig & { responseType: 'stream' }): Promise<ReadableStream<Uint8Array>>
    (url: string, config?: HTTP.RequestConfig & { responseType: 'text' }): Promise<string>
    <T>(url: string, config?: HTTP.RequestConfig): Promise<T>
  }

  export interface Request2 {
    (url: string, data?: any, config?: HTTP.RequestConfig & { responseType: 'arraybuffer' }): Promise<ArrayBuffer>
    (url: string, data?: any, config?: HTTP.RequestConfig & { responseType: 'stream' }): Promise<ReadableStream<Uint8Array>>
    (url: string, data?: any, config?: HTTP.RequestConfig & { responseType: 'text' }): Promise<string>
    <T>(url: string, data?: any, config?: HTTP.RequestConfig): Promise<T>
  }

  export interface Config {
    headers?: Dict
    timeout?: number
    proxyAgent?: string
  }

  export interface RequestConfig extends Config {
    baseURL?: string
    /** @deprecated use `baseURL` instead */
    endpoint?: string
    method?: Method
    params?: Dict
    data?: any
    keepAlive?: boolean
    responseType?: ResponseType
  }

  export interface Response<T = any> {
    url: string
    data: T
    status: number
    statusText: string
    headers: Headers
  }

  export interface FileConfig {
    timeout?: number | string
  }

  export interface FileResponse {
    mime?: string
    name?: string
    data: ArrayBufferLike
  }

  export type Error = HTTPError
}

export class HTTP {
  static Error = HTTPError
  /** @deprecated use `HTTP.Error.is()` instead */
  static isAxiosError = HTTPError.is

  protected [Context.current]: Context

  constructor(ctx: Context, config: HTTP.Config = {}) {
    ctx.provide('http')

    function resolveDispatcher(href?: string) {
      if (!href) return
      const url = new URL(href)
      const agent = ctx.bail('http/dispatcher', url)
      if (agent) return agent
      throw new Error(`Cannot resolve proxy agent ${url}`)
    }

    const http = async function http(this: Context, ...args: any[]) {
      let method: HTTP.Method | undefined
      if (typeof args[1] === 'string' || args[1] instanceof URL) {
        method = args.shift()
      }
      const config = this.http.resolveConfig(args[1])
      const url = this.http.resolveURL(args[0], config)
      const controller = new AbortController()
      this.on('dispose', () => {
        controller.abort('context disposed')
      })
      if (config.timeout) {
        const timer = setTimeout(() => {
          controller.abort('timeout')
        }, config.timeout)
        this.on('dispose', () => clearTimeout(timer))
      }

      const raw = await fetch(url, {
        method,
        body: config.data,
        headers: config.headers,
        keepalive: config.keepAlive,
        signal: controller.signal,
        ['dispatcher' as never]: resolveDispatcher(config?.proxyAgent),
      }).catch((cause) => {
        const error = new HTTP.Error(cause.message)
        error.cause = cause
        throw error
      })

      const response: HTTP.Response = {
        data: null,
        url: raw.url,
        status: raw.status,
        statusText: raw.statusText,
        headers: raw.headers,
      }

      if (!raw.ok) {
        const error = new HTTP.Error(raw.statusText)
        error.response = response
        try {
          response.data = await this.http.decodeResponse(raw)
        } catch {}
        throw error
      }

      if (config.responseType === 'arraybuffer') {
        response.data = await raw.arrayBuffer()
      } else if (config.responseType === 'stream') {
        response.data = raw.body
      } else {
        response.data = await this.http.decodeResponse(raw)
      }
      return response
    } as HTTP

    http.config = config
    defineProperty(http, Context.current, ctx)
    Object.setPrototypeOf(http, Object.getPrototypeOf(this))

    for (const method of ['get', 'delete'] as const) {
      http[method] = async function <T>(this: HTTP, url: string, config?: HTTP.Config) {
        const caller = this[Context.current]
        const response = await caller.http<T>(url, {
          method,
          ...config,
        })
        return response.data
      }
    }

    for (const method of ['patch', 'post', 'put'] as const) {
      http[method] = async function <T>(this: HTTP, url: string, data?: any, config?: HTTP.Config) {
        const caller = this[Context.current]
        const response = await caller.http<T>(url, {
          method,
          data,
          ...config,
        })
        return response.data
      }
    }

    ctx.http = Context.associate(http, 'http')
    ctx.on('dispose', () => {
      ctx.http = null as never
    })

    return http
  }

  resolveConfig(init?: HTTP.RequestConfig): HTTP.RequestConfig {
    let result = { headers: {}, ...this.config }
    const merge = (init?: HTTP.RequestConfig) => {
      result = {
        ...result,
        ...this.config,
        headers: {
          ...result.headers,
          ...init?.headers,
        },
      }
    }

    const caller = this[Context.current]
    let intercept = caller[Context.intercept]
    while (intercept) {
      merge(intercept.http)
      intercept = Object.getPrototypeOf(intercept)
    }
    merge(init)
    return result
  }

  resolveURL(url: string | URL, config: HTTP.RequestConfig) {
    if (config.endpoint) {
      this[Context.current].emit('internal/warning', 'endpoint is deprecated, please use baseURL instead')
      url = trimSlash(config.endpoint) + url
    }
    url = new URL(url, config.baseURL)
    for (const [key, value] of Object.entries(config.params ?? {})) {
      url.searchParams.append(key, value)
    }
    return url
  }

  decodeResponse(response: Response) {
    const type = response.headers.get('Content-Type')
    if (type === 'application/json') {
      return response.json()
    } else if (type?.startsWith('text/')) {
      return response.text()
    } else {
      return response.arrayBuffer()
    }
  }

  async head(url: string, config?: HTTP.Config) {
    const caller = this[Context.current]
    const response = await caller.http(url, {
      method: 'HEAD',
      ...config,
    })
    return response.headers
  }

  /** @deprecated use `ctx.http()` instead */
  async axios<T>(url: string, config?: HTTP.Config) {
    const caller = this[Context.current]
    caller.emit('internal/warning', 'ctx.http.axios() is deprecated, use ctx.http() instead')
    return caller.http<T>(url, config)
  }

  resolveAgent(href?: string) {
    if (!href) return
    const url = new URL(href)
    const agent = this[Context.current].bail('http/http-agent', url)
    if (agent) return agent
    throw new Error(`Cannot resolve proxy agent ${url}`)
  }

  async ws(this: HTTP, url: string | URL, init?: HTTP.Config) {
    const config = this.resolveConfig(init)
    url = this.resolveURL(url, config)
    const socket = new WebSocket(url, 'Server' in WebSocket ? {
      agent: this.resolveAgent(config?.proxyAgent),
      handshakeTimeout: config?.timeout,
      headers: config?.headers,
    } as ClientOptions as never : undefined)
    this[Context.current].on('dispose', () => {
      socket.close(1001, 'context disposed')
    })
    return socket
  }

  async file(url: string, options: HTTP.FileConfig = {}): Promise<HTTP.FileResponse> {
    const result = await loadFile(url)
    if (result) return result
    const caller = this[Context.current]
    const capture = /^data:([\w/-]+);base64,(.*)$/.exec(url)
    if (capture) {
      const [, mime, base64] = capture
      return { mime, data: base64ToArrayBuffer(base64) }
    }
    const { headers, data, url: responseUrl } = await caller.http<ArrayBuffer>(url, {
      method: 'GET',
      responseType: 'arraybuffer',
      timeout: +options.timeout! || undefined,
    })
    const mime = headers.get('Content-Type') ?? undefined
    const [, name] = responseUrl.match(/.+\/([^/?]*)(?=\?)?/)!
    return { mime, name, data }
  }

  async isLocal(url: string) {
    let { hostname, protocol } = new URL(url)
    if (protocol !== 'http:' && protocol !== 'https:') return true
    if (/^\[.+\]$/.test(hostname)) {
      hostname = hostname.slice(1, -1)
    }
    try {
      const address = await lookup(hostname)
      return isLocalAddress(address)
    } catch {
      return false
    }
  }
}

export default HTTP
