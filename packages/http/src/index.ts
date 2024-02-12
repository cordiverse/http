import { Context, FunctionalService } from 'cordis'
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

export interface HTTP {
  [Context.current]: Context
  <T>(url: string | URL, config?: HTTP.RequestConfig): Promise<HTTP.Response<T>>
  <T>(method: HTTP.Method, url: string | URL, config?: HTTP.RequestConfig): Promise<HTTP.Response<T>>
  config: HTTP.Config
  get: HTTP.Request1
  delete: HTTP.Request1
  patch: HTTP.Request2
  post: HTTP.Request2
  put: HTTP.Request2
}

export class HTTP extends FunctionalService {
  static Error = HTTPError
  /** @deprecated use `HTTP.Error.is()` instead */
  static isAxiosError = HTTPError.is

  static {
    for (const method of ['get', 'delete'] as const) {
      defineProperty(HTTP.prototype, method, async function (this: HTTP, url: string, config?: HTTP.Config) {
        const caller = this[Context.current]
        const response = await this.call(caller, method, url, config)
        return response.data
      })
    }

    for (const method of ['patch', 'post', 'put'] as const) {
      defineProperty(HTTP.prototype, method, async function (this: HTTP, url: string, data?: any, config?: HTTP.Config) {
        const caller = this[Context.current]
        const response = await this.call(caller, method, url, { data, ...config })
        return response.data
      })
    }
  }

  constructor(ctx: Context, public config: HTTP.Config = {}, standalone?: boolean) {
    super(ctx, 'http', { immediate: true, standalone })
  }

  static mergeConfig = (target: HTTP.Config, source?: HTTP.Config) => ({
    ...target,
    ...source,
    headers: {
      ...target.headers,
      ...source?.headers,
    },
  })

  extend(config: HTTP.Config = {}) {
    return new HTTP(this[Context.current], HTTP.mergeConfig(this.config, config), true)
  }

  resolveDispatcher(href?: string) {
    if (!href) return
    const url = new URL(href)
    const agent = this[Context.current].bail('http/dispatcher', url)
    if (agent) return agent
    throw new Error(`Cannot resolve proxy agent ${url}`)
  }

  resolveConfig(ctx: Context, init?: HTTP.RequestConfig): HTTP.RequestConfig {
    let result = { headers: {}, ...this.config }
    let intercept = ctx[Context.intercept]
    while (intercept) {
      result = HTTP.mergeConfig(result, intercept.http)
      intercept = Object.getPrototypeOf(intercept)
    }
    result = HTTP.mergeConfig(result, init)
    return result
  }

  static resolveURL(caller: Context, url: string | URL, config: HTTP.RequestConfig) {
    if (config.endpoint) {
      // caller.emit('internal/warning', 'endpoint is deprecated, please use baseURL instead')
      try {
        new URL(url)
      } catch {
        url = trimSlash(config.endpoint) + url
      }
    }
    try {
      url = new URL(url, config.baseURL)
    } catch (error) {
      // prettify the error message
      throw new TypeError(`Invalid URL: ${url}`)
    }
    for (const [key, value] of Object.entries(config.params ?? {})) {
      url.searchParams.append(key, value)
    }
    return url
  }

  decodeResponse(response: Response) {
    const type = response.headers.get('content-type')
    if (type?.startsWith('application/json')) {
      return response.json()
    } else if (type?.startsWith('text/')) {
      return response.text()
    } else {
      return response.arrayBuffer()
    }
  }

  async call(caller: Context, ...args: any[]) {
    let method: HTTP.Method | undefined
    if (typeof args[1] === 'string' || args[1] instanceof URL) {
      method = args.shift()
    }
    const config = this.resolveConfig(caller, args[1])
    const url = HTTP.resolveURL(caller, args[0], config)

    const controller = new AbortController()
    let timer: NodeJS.Timeout | number | undefined
    const dispose = caller.on('dispose', () => {
      clearTimeout(timer)
      controller.abort('context disposed')
    })
    if (config.timeout) {
      timer = setTimeout(() => {
        controller.abort('timeout')
      }, config.timeout)
    }

    try {
      const raw = await fetch(url, {
        method,
        body: config.data,
        headers: config.headers,
        keepalive: config.keepAlive,
        signal: controller.signal,
        ['dispatcher' as never]: this.resolveDispatcher(config?.proxyAgent),
      }).catch((cause) => {
        const error = new HTTP.Error(`fetch ${url} failed`)
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
          response.data = await this.decodeResponse(raw)
        } catch {}
        throw error
      }

      if (config.responseType === 'arraybuffer') {
        response.data = await raw.arrayBuffer()
      } else if (config.responseType === 'stream') {
        response.data = raw.body
      } else {
        response.data = await this.decodeResponse(raw)
      }
      return response
    } finally {
      dispose()
    }
  }

  async head(url: string, config?: HTTP.Config) {
    const caller = this[Context.current]
    const response = await this.call(caller, 'HEAD', url, config)
    return response.headers
  }

  /** @deprecated use `ctx.http()` instead */
  axios<T>(url: string, config?: HTTP.Config): Promise<HTTP.Response<T>> {
    const caller = this[Context.current]
    caller.emit('internal/warning', 'ctx.http.axios() is deprecated, use ctx.http() instead')
    return this.call(caller, url, config)
  }

  resolveAgent(href?: string) {
    if (!href) return
    const url = new URL(href)
    const agent = this[Context.current].bail('http/http-agent', url)
    if (agent) return agent
    throw new Error(`Cannot resolve proxy agent ${url}`)
  }

  async ws(this: HTTP, url: string | URL, init?: HTTP.Config) {
    const caller = this[Context.current]
    const config = this.resolveConfig(caller, init)
    url = HTTP.resolveURL(caller, url, config)
    const socket = new WebSocket(url, 'Server' in WebSocket ? {
      agent: this.resolveAgent(config?.proxyAgent),
      handshakeTimeout: config?.timeout,
      headers: config?.headers,
    } as ClientOptions as never : undefined)
    caller.on('dispose', () => {
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
    const { headers, data, url: responseUrl } = await this.call(caller, url, {
      method: 'GET',
      responseType: 'arraybuffer',
      timeout: +options.timeout! || undefined,
    })
    const mime = headers.get('content-type') ?? undefined
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
