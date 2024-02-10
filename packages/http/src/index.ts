import { Context } from 'cordis'
import { base64ToArrayBuffer, Dict, trimSlash } from 'cosmokit'
import { WebSocket } from 'unws'
import { ClientOptions } from 'ws'
import { loadFile, lookup } from './adapter/index.js'
import { isLocalAddress } from './utils.js'

declare module 'cordis' {
  interface Context {
    http: HTTP
  }

  interface Intercept {
    http: HTTP.Config
  }
}

const _Error = Error

export interface HTTP {
  [Context.current]: Context
  <T>(url: string | URL, config?: HTTP.RequestConfig): Promise<HTTP.Response<T>>
  <T>(method: HTTP.Method, url: string | URL, config?: HTTP.RequestConfig): Promise<HTTP.Response<T>>
  /** @deprecated use `ctx.http()` instead */
  axios<T>(url: string, config?: HTTP.RequestConfig): Promise<HTTP.Response<T>>

  get: HTTP.Request1
  delete: HTTP.Request1
  patch: HTTP.Request2
  post: HTTP.Request2
  put: HTTP.Request2
  head(url: string, config?: HTTP.RequestConfig): Promise<Dict>
  ws(url: string, config?: HTTP.RequestConfig): Promise<WebSocket>

  isLocal(url: string): Promise<boolean>
  file(url: string, config?: HTTP.FileConfig): Promise<HTTP.FileResponse>
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

  export class Error extends _Error {
    response?: Response
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
}

export function apply(ctx: Context, config?: HTTP.Config) {
  ctx.provide('http')

  function mergeConfig(caller: Context, init?: HTTP.RequestConfig): HTTP.RequestConfig {
    let result = { headers: {}, ...config }
    function merge(init?: HTTP.RequestConfig) {
      result = {
        ...result,
        ...config,
        headers: {
          ...result.headers,
          ...init?.headers,
        },
      }
    }

    let intercept = caller[Context.intercept]
    while (intercept) {
      merge(intercept.http)
      intercept = Object.getPrototypeOf(intercept)
    }
    merge(init)
    return result
  }

  function resolveURL(url: string | URL, config: HTTP.RequestConfig) {
    try {
      return new URL(url, config.baseURL).href
    } catch {
      return trimSlash(config.endpoint || '') + url
    }
  }

  function decode(response: Response) {
    const type = response.headers.get('Content-Type')
    if (type === 'application/json') {
      return response.json()
    } else if (type?.startsWith('text/')) {
      return response.text()
    } else {
      return response.arrayBuffer()
    }
  }

  const http = async function http(this: Context, ...args: any[]) {
    let method: HTTP.Method | undefined
    if (typeof args[1] === 'string' || args[1] instanceof URL) {
      method = args.shift()
    }
    const config = mergeConfig(this, args[1])
    const url = resolveURL(args[0], config)
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
      signal: controller.signal,
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
        response.data = await decode(raw)
      } catch {}
      throw error
    }

    if (config.responseType === 'arraybuffer') {
      response.data = await raw.arrayBuffer()
    } else if (config.responseType === 'stream') {
      response.data = raw.body
    } else {
      response.data = await decode(raw)
    }
    return response
  } as HTTP

  http.axios = async function (this: HTTP, url: string, config?: HTTP.Config) {
    const caller = this[Context.current]
    caller.emit('internal/warning', 'ctx.http.axios() is deprecated, use ctx.http() instead')
    return caller.http(url, config)
  }

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

  http.head = async function (this: HTTP, url: string, config?: HTTP.Config) {
    const caller = this[Context.current]
    const response = await caller.http(url, {
      method: 'HEAD',
      ...config,
    })
    return response.headers
  }

  http.ws = async function (this: HTTP, url: string, init?: HTTP.Config) {
    const caller = this[Context.current]
    const config = mergeConfig(caller, init)
    const socket = new WebSocket(url, 'Server' in WebSocket ? {
      // agent: caller.agent(config?.proxyAgent),
      handshakeTimeout: config?.timeout,
      headers: config?.headers,
    } as ClientOptions as never : undefined)
    caller.on('dispose', () => {
      socket.close(1001, 'context disposed')
    })
    return socket
  }

  http.file = async function file(this: HTTP, url: string, options: HTTP.FileConfig = {}): Promise<HTTP.FileResponse> {
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
    const mime = headers['content-type']
    const [, name] = responseUrl.match(/.+\/([^/?]*)(?=\?)?/)!
    return { mime, name, data }
  }

  http.isLocal = async function isLocal(url: string) {
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

  ctx.http = Context.associate(http, 'http')
  ctx.on('dispose', () => {
    ctx.http = null as never
  })
}
