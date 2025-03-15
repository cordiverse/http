import { Context, Service, z } from 'cordis'
import { Awaitable, Binary, defineProperty, Dict, isNullable } from 'cosmokit'
import { fetchFile, lookup } from '@cordisjs/plugin-http/adapter'
import { createRequire } from 'node:module'
import type { Dispatcher, RequestInit, WebSocketInit } from 'undici'
import { isLocalAddress } from './utils'

declare module 'cordis' {
  interface Context {
    http: HTTP
  }

  interface Intercept {
    http: HTTP.Intercept
  }

  interface Events {
    'http/fetch'(this: HTTP, url: URL, init: RequestInit, config: HTTP.Config, next: () => Promise<Response>): Promise<Response>
    'http/config'(this: HTTP, config: HTTP.Config): void
    'http/websocket-init'(this: HTTP, url: URL, init: WebSocketInit, config: HTTP.Config): void
  }
}

const kHTTPError = Symbol.for('cordis.http.error')

class HTTPError extends Error {
  [kHTTPError] = true
  response?: HTTP.Response

  static is(error: any): error is HTTPError {
    return !!error?.[kHTTPError]
  }

  constructor(message?: string, public code?: HTTP.Error.Code) {
    super(message)
  }
}

/**
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch
 */
function encodeRequest(data: any): [string | null, any] {
  if (data instanceof URLSearchParams) return [null, data]
  if (data instanceof ArrayBuffer) return [null, data]
  if (ArrayBuffer.isView(data)) return [null, data]
  if (data instanceof Blob) return [null, data]
  if (data instanceof FormData) return [null, data]
  return ['application/json', JSON.stringify(data)]
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

  export interface ResponseTypes {
    json: any
    text: string
    stream: ReadableStream
    blob: Blob
    formdata: FormData
    arraybuffer: ArrayBuffer
  }

  export interface Request1 {
    <K extends keyof ResponseTypes>(url: string | URL, config: HTTP.RequestConfig & { responseType: K }): Promise<ResponseTypes[K]>
    <T = any>(url: string | URL, config: HTTP.RequestConfig & { responseType: Decoder<T> }): Promise<T>
    <T = any>(url: string | URL, config?: HTTP.RequestConfig): Promise<T>
  }

  export interface Request2 {
    <K extends keyof ResponseTypes>(url: string | URL, data: any, config: HTTP.RequestConfig & { responseType: K }): Promise<ResponseTypes[K]>
    <T = any>(url: string | URL, data: any, config: HTTP.RequestConfig & { responseType: Decoder<T> }): Promise<T>
    <T = any>(url: string | URL, data?: any, config?: HTTP.RequestConfig): Promise<T>
  }

  export interface Intercept {
    baseURL?: string
    headers?: Dict
    timeout?: number
    proxyAgent?: string
  }

  export interface Config extends Intercept {}

  export interface RequestConfig extends Config {
    method?: Method
    params?: Dict
    data?: any
    keepAlive?: boolean
    redirect?: RequestRedirect
    signal?: AbortSignal
    responseType?: keyof ResponseTypes | Decoder
    validateStatus?: (status: number) => boolean
  }

  export interface Response<T = any> {
    url: string
    data: T
    status: number
    statusText: string
    headers: Headers
  }

  export interface AfterFetch {
    url: URL
    init: RequestInit
    config: RequestConfig
    response?: globalThis.Response
    error?: any
  }

  export type Decoder<T = any> = (raw: globalThis.Response) => Awaitable<T>

  export type Error = HTTPError

  export namespace Error {
    export type Code = 'ETIMEDOUT'
  }
}

export interface FileOptions {
  timeout?: number | string
}

export interface HTTP {
  <K extends keyof HTTP.ResponseTypes>(url: string | URL, config: HTTP.RequestConfig & { responseType: K }): Promise<HTTP.Response<HTTP.ResponseTypes[K]>>
  <T = any>(url: string | URL, config?: HTTP.RequestConfig): Promise<HTTP.Response<T>>
  <T = any>(method: HTTP.Method, url: string | URL, config?: HTTP.RequestConfig): Promise<HTTP.Response<T>>
  config: HTTP.Config
  get: HTTP.Request1
  delete: HTTP.Request1
  patch: HTTP.Request2
  post: HTTP.Request2
  put: HTTP.Request2
}

// we don't use `raw.ok` because it may be a 3xx redirect
const validateStatus = (status: number) => status < 400

export class HTTP extends Service {
  static Error = HTTPError

  static undici: typeof import('undici')

  static {
    const require = createRequire(import.meta.url)
    try {
      if (process.execArgv.includes('--expose-internals')) {
        this.undici = require('internal/deps/undici/undici')
      } else {
        this.undici = require('undici')
      }
    } catch {}

    for (const method of ['get', 'delete'] as const) {
      defineProperty(HTTP.prototype, method, async function (this: HTTP, url: string | URL, config?: HTTP.Config) {
        const response = await this(url, { method, validateStatus, ...config })
        return response.data
      })
    }

    for (const method of ['patch', 'post', 'put'] as const) {
      defineProperty(HTTP.prototype, method, async function (this: HTTP, url: string | URL, data?: any, config?: HTTP.Config) {
        const response = await this(url, { method, data, validateStatus, ...config })
        return response.data
      })
    }
  }

  static Config: z<HTTP.Config> = z.object({
    timeout: z.natural().role('ms').description('等待请求的最长时间。'),
    keepAlive: z.boolean().description('是否保持连接。'),
    proxyAgent: z.string().description('代理服务器地址。'),
  })

  static Intercept: z<HTTP.Config> = z.object({
    baseURL: z.string().description('基础 URL。'),
    timeout: z.natural().role('ms').description('等待请求的最长时间。'),
    keepAlive: z.boolean().description('是否保持连接。'),
    proxyAgent: z.string().description('代理服务器地址。'),
  })

  public isError = HTTPError.is

  private _decoders: Dict = Object.create(null)
  private _proxies: Dict<(url: URL) => Dispatcher> = Object.create(null)

  constructor(ctx: Context, public config: HTTP.Config = {}) {
    super(ctx, 'http')

    this.decoder('json', (raw) => raw.json())
    this.decoder('text', (raw) => raw.text())
    this.decoder('blob', (raw) => raw.blob())
    this.decoder('arraybuffer', (raw) => raw.arrayBuffer())
    this.decoder('formdata', (raw) => raw.formData())
    this.decoder('stream', (raw) => raw.body!)

    this.proxy(['http', 'https'], (url) => {
      return new this.undici.ProxyAgent(url.href)
    })

    // file: URL
    this.ctx.on('http/fetch', async (url, init, config, next) => {
      if (url.protocol !== 'file:') return next()
      if (init.method !== 'GET') {
        return new Response(null, { status: 405, statusText: 'Method Not Allowed' })
      }
      return fetchFile(url, init)
    }, { prepend: true })

    // data: URL
    this.ctx.on('http/fetch', async (url, init, config, next) => {
      // https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/MIME_types/Common_types
      const capture = /^data:([\w/.+-]+);base64,(.*)$/.exec(url.href)
      if (!capture) return next()
      if (init.method !== 'GET') {
        return new Response(null, { status: 405, statusText: 'Method Not Allowed' })
      }
      const [, type, base64] = capture
      return new Response(Binary.fromBase64(base64), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': type },
      })
    }, { prepend: true })
  }

  get undici() {
    if (HTTP.undici) return HTTP.undici
    throw new Error('please install `undici`')
  }

  static mergeConfig = (target: HTTP.Config, source?: HTTP.Config) => ({
    ...target,
    ...source,
    headers: {
      ...target?.headers,
      ...source?.headers,
    },
  })

  decoder<K extends keyof HTTP.ResponseTypes>(type: K, decoder: HTTP.Decoder<HTTP.ResponseTypes[K]>) {
    return this.ctx.effect(() => {
      this._decoders[type] = decoder
      return () => delete this._decoders[type]
    })
  }

  proxy(name: string[], factory: (url: URL) => Dispatcher) {
    return this.ctx.effect(() => {
      for (const key of name) {
        this._proxies[key] = factory
      }
      return () => {
        for (const key of name) {
          delete this._proxies[key]
        }
      }
    })
  }

  extend(config: HTTP.Config = {}) {
    return this[Service.extend]({
      config: HTTP.mergeConfig(this.config, config),
    })
  }

  resolveConfig(init?: HTTP.RequestConfig): HTTP.RequestConfig {
    let result = { headers: {}, ...this.config }
    this.ctx.emit(this, 'http/config', result)
    let intercept = this.ctx[Context.intercept]
    while (intercept) {
      result = HTTP.mergeConfig(result, intercept.http)
      intercept = Object.getPrototypeOf(intercept)
    }
    result = HTTP.mergeConfig(result, init)
    return result
  }

  resolveURL(url: string | URL, config: HTTP.RequestConfig, isWebSocket = false) {
    try {
      url = new URL(url, config.baseURL)
    } catch (error) {
      // prettify the error message
      throw new TypeError(`Invalid URL: ${url}`)
    }
    if (isWebSocket) url.protocol = url.protocol.replace(/^http/, 'ws')
    for (const [key, value] of Object.entries(config.params ?? {})) {
      if (isNullable(value)) continue
      url.searchParams.append(key, value)
    }
    return url
  }

  defaultDecoder(response: Response) {
    const type = response.headers.get('content-type')
    if (type?.startsWith('application/json')) {
      return response.json()
    } else if (type?.startsWith('text/')) {
      return response.text()
    } else {
      return response.arrayBuffer()
    }
  }

  async [Service.invoke](...args: any[]) {
    let method: HTTP.Method | undefined
    if (typeof args[1] === 'string' || args[1] instanceof URL) {
      method = args.shift()
    }
    const config = this.resolveConfig(args[1])
    const url = this.resolveURL(args[0], config)
    method ??= config.method ?? 'GET'

    const controller = new AbortController()
    if (config.signal) {
      if (config.signal.aborted) {
        throw config.signal.reason
      }
      config.signal.addEventListener('abort', () => {
        controller.abort(config.signal!.reason)
      })
    }

    const dispose = this.ctx.effect(() => {
      const timer = config.timeout && setTimeout(() => {
        controller.abort(new HTTPError('request timeout', 'ETIMEDOUT'))
      }, config.timeout)
      return () => {
        clearTimeout(timer)
      }
    })
    controller.signal.addEventListener('abort', () => dispose())

    try {
      const headers = new Headers(config.headers)
      const init: RequestInit = {
        method,
        headers,
        body: config.data,
        keepalive: config.keepAlive,
        redirect: config.redirect,
        signal: controller.signal,
      }

      if (config.data && typeof config.data === 'object') {
        const [type, body] = encodeRequest(config.data)
        init.body = body
        if (type && !headers.has('content-type')) {
          headers.append('content-type', type)
        }
      }

      if (config.proxyAgent) {
        const proxyURL = new URL(config.proxyAgent)
        const factory = this._proxies[proxyURL.protocol.slice(0, -1)]
        if (!factory) throw new Error(`Cannot resolve proxy agent ${proxyURL}`)
        init.dispatcher = factory(proxyURL)
      }

      const raw = await this.ctx.waterfall('http/fetch', url, init, config, () => {
        return this.undici.fetch(url, init) as any
      }).catch((cause) => {
        if (HTTP.Error.is(cause)) throw cause
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

      const validateStatus = config.validateStatus ?? (() => true)
      if (!validateStatus(raw.status)) {
        const error = new HTTP.Error(raw.statusText)
        error.response = response
        try {
          response.data = await this.defaultDecoder(raw)
        } catch {}
        throw error
      }

      if (config.responseType) {
        let decoder: HTTP.Decoder
        if (typeof config.responseType === 'function') {
          decoder = config.responseType
        } else {
          decoder = this._decoders[config.responseType]
          if (!decoder) {
            throw new TypeError(`Unknown responseType: ${config.responseType}`)
          }
        }
        response.data = await decoder(raw)
      } else {
        response.data = await this.defaultDecoder(raw)
      }
      return response
    } finally {
      dispose()
    }
  }

  async head(url: string | URL, config?: HTTP.Config) {
    const response = await this(url, { method: 'HEAD', validateStatus, ...config })
    return response.headers
  }

  ws(url: string | URL, _config?: HTTP.Config) {
    const config = this.resolveConfig(_config)
    url = this.resolveURL(url, config, true)
    const headers = new Headers(config.headers)
    const init: WebSocketInit = {
      headers,
    }

    if (config.proxyAgent) {
      const proxyURL = new URL(config.proxyAgent)
      const factory = this._proxies[proxyURL.protocol.slice(0, -1)]
      if (!factory) throw new Error(`Cannot resolve proxy agent ${proxyURL}`)
      init.dispatcher = factory(proxyURL)
    }

    this.ctx.emit(this, 'http/websocket-init', url, init, config)
    const socket = new this.undici.WebSocket(url, init)
    const dispose = this.ctx.on('dispose', () => {
      socket.close(1000, 'context disposed')
    })
    socket.addEventListener('close', () => {
      dispose()
    })
    return socket
  }

  async isLocal(url: string | URL) {
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
