import { Context, Schema, Service } from 'cordis'
import { Awaitable, Binary, defineProperty, Dict, isNullable, trimSlash } from 'cosmokit'
import { ClientOptions } from 'ws'
import { loadFile, lookup, WebSocket } from '@cordisjs/plugin-http/adapter'
import { ReadableStream } from 'node:stream/web'
import { isLocalAddress } from './utils.ts'
import mimedb from 'mime-db'

export type { WebSocket } from '@cordisjs/plugin-http/adapter'

declare module 'cordis' {
  interface Context {
    http: HTTP
  }

  interface Intercept {
    http: HTTP.Intercept
  }

  interface Events {
    'http/file'(this: HTTP, url: string, options: FileOptions): Awaitable<FileResponse | undefined>
    'http/config'(this: HTTP, config: HTTP.Config): void
    'http/fetch-init'(this: HTTP, url: URL, init: RequestInit, config: HTTP.Config): void
    'http/websocket-init'(this: HTTP, url: URL, init: ClientOptions, config: HTTP.Config): void
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
    stream: ReadableStream<Uint8Array>
    blob: Blob
    formdata: FormData
    arraybuffer: ArrayBuffer
  }

  export interface Request1 {
    <K extends keyof ResponseTypes>(url: string, config: HTTP.RequestConfig & { responseType: K }): Promise<ResponseTypes[K]>
    <T = any>(url: string, config?: HTTP.RequestConfig): Promise<T>
  }

  export interface Request2 {
    <K extends keyof ResponseTypes>(url: string, data: any, config: HTTP.RequestConfig & { responseType: K }): Promise<ResponseTypes[K]>
    <T = any>(url: string, data?: any, config?: HTTP.RequestConfig): Promise<T>
  }

  export interface Intercept {
    baseURL?: string
    /** @deprecated use `baseURL` instead */
    endpoint?: string
    headers?: Dict
    timeout?: number
  }

  export interface Config extends Intercept {}

  export interface RequestConfig extends Config {
    method?: Method
    params?: Dict
    data?: any
    keepAlive?: boolean
    redirect?: RequestRedirect
    signal?: AbortSignal
    responseType?: keyof ResponseTypes
    validateStatus?: (status: number) => boolean
  }

  export interface Response<T = any> {
    url: string
    data: T
    status: number
    statusText: string
    headers: Headers
  }

  export type Error = HTTPError

  export namespace Error {
    export type Code = 'ETIMEDOUT'
  }
}

export interface FileOptions {
  timeout?: number | string
}

export interface FileResponse {
  type: string
  /** @deprecated use `type` instead */
  mime?: string
  filename: string
  data: ArrayBuffer
}

export interface HTTP {
  <K extends keyof HTTP.ResponseTypes>(url: string, config: HTTP.RequestConfig & { responseType: K }): Promise<HTTP.Response<HTTP.ResponseTypes[K]>>
  <T = any>(url: string | URL, config?: HTTP.RequestConfig): Promise<HTTP.Response<T>>
  <T = any>(method: HTTP.Method, url: string | URL, config?: HTTP.RequestConfig): Promise<HTTP.Response<T>>
  config: HTTP.Config
  get: HTTP.Request1
  delete: HTTP.Request1
  patch: HTTP.Request2
  post: HTTP.Request2
  put: HTTP.Request2
}

export class HTTP extends Service<HTTP.Config> {
  static Error = HTTPError
  /** @deprecated use `http.isError()` instead */
  static isAxiosError = HTTPError.is

  static [Service.provide] = 'http'
  static [Service.immediate] = true

  static {
    for (const method of ['get', 'delete'] as const) {
      defineProperty(HTTP.prototype, method, async function (this: HTTP, url: string, config?: HTTP.Config) {
        const response = await this(url, { method, ...config })
        return response.data
      })
    }

    for (const method of ['patch', 'post', 'put'] as const) {
      defineProperty(HTTP.prototype, method, async function (this: HTTP, url: string, data?: any, config?: HTTP.Config) {
        const response = await this(url, { method, data, ...config })
        return response.data
      })
    }
  }

  static Config: Schema<HTTP.Config> = Schema.object({
    timeout: Schema.natural().role('ms').description('等待请求的最长时间。'),
    keepAlive: Schema.boolean().description('是否保持连接。'),
  })

  static Intercept: Schema<HTTP.Config> = Schema.object({
    baseURL: Schema.string().description('基础 URL。'),
    timeout: Schema.natural().role('ms').description('等待请求的最长时间。'),
    keepAlive: Schema.boolean().description('是否保持连接。'),
  })

  public isError = HTTPError.is

  private _decoders: Dict = Object.create(null)

  constructor(config?: HTTP.Config)
  constructor(ctx: Context, config?: HTTP.Config)
  constructor(...args: any[]) {
    super(args[0], args[1])
    this.decoder('json', (raw) => raw.json())
    this.decoder('text', (raw) => raw.text())
    this.decoder('blob', (raw) => raw.blob())
    this.decoder('arraybuffer', (raw) => raw.arrayBuffer())
    this.decoder('formdata', (raw) => raw.formData())
    this.decoder('stream', (raw) => raw.body as any)
    this.ctx.on('http/file', (url, options) => loadFile(url))
    this.ctx.schema.extend('service:http', HTTP.Intercept)
  }

  static mergeConfig = (target: HTTP.Config, source?: HTTP.Config) => ({
    ...target,
    ...source,
    headers: {
      ...target?.headers,
      ...source?.headers,
    },
  })

  decoder<K extends keyof HTTP.ResponseTypes>(type: K, decoder: (raw: Response) => Awaitable<HTTP.ResponseTypes[K]>) {
    return this[Context.origin].effect(() => {
      this._decoders[type] = decoder
      return () => delete this._decoders[type]
    })
  }

  extend(config: HTTP.Config = {}) {
    return this[Service.extend]({
      config: HTTP.mergeConfig(this.config, config),
    })
  }

  resolveConfig(init?: HTTP.RequestConfig): HTTP.RequestConfig {
    const caller = this[Context.origin]
    let result = { headers: {}, ...this.config }
    caller.emit(this, 'http/config', result)
    let intercept = caller[Context.intercept]
    while (intercept) {
      result = HTTP.mergeConfig(result, intercept.http)
      intercept = Object.getPrototypeOf(intercept)
    }
    result = HTTP.mergeConfig(result, init)
    return result
  }

  resolveURL(url: string | URL, config: HTTP.RequestConfig, isWebSocket = false) {
    if (config.endpoint) {
      // this[Context.origin].emit('internal/warning', 'endpoint is deprecated, please use baseURL instead')
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
    if (isWebSocket) url.protocol = url.protocol.replace(/^http/, 'ws')
    for (const [key, value] of Object.entries(config.params ?? {})) {
      if (isNullable(value)) continue
      url.searchParams.append(key, value)
    }
    return url
  }

  defaultDecoder(response: Response) {
    const type = response.headers.get('Content-Type')
    if (type?.startsWith('application/json')) {
      return response.json()
    } else if (type?.startsWith('text/')) {
      return response.text()
    } else {
      return response.arrayBuffer()
    }
  }

  async [Service.invoke](...args: any[]) {
    const caller = this[Context.origin]
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

    const dispose = caller.effect(() => {
      const timer = config.timeout && setTimeout(() => {
        controller.abort(new HTTPError('request timeout', 'ETIMEDOUT'))
      }, config.timeout)
      return (done?: boolean) => {
        clearTimeout(timer)
        if (done) return
        controller.abort(new HTTPError('context disposed', 'ETIMEDOUT'))
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
        if (type && !headers.has('Content-Type')) {
          headers.append('Content-Type', type)
        }
      }
      caller.emit(this, 'http/fetch-init', url, init, config)
      const raw = await fetch(url, init).catch((cause) => {
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

      // we don't use `raw.ok` because it may be a 3xx redirect
      const validateStatus = config.validateStatus ?? (status => status < 400)
      if (!validateStatus(raw.status)) {
        const error = new HTTP.Error(raw.statusText)
        error.response = response
        try {
          response.data = await this.defaultDecoder(raw)
        } catch {}
        throw error
      }

      if (config.responseType) {
        if (!(config.responseType in this._decoders)) {
          throw new TypeError(`Unknown responseType: ${config.responseType}`)
        }
        const decoder = this._decoders[config.responseType]
        response.data = await decoder(raw)
      } else {
        response.data = await this.defaultDecoder(raw)
      }
      return response
    } finally {
      dispose(true)
    }
  }

  async head(url: string, config?: HTTP.Config) {
    const response = await this(url, { method: 'HEAD', ...config })
    return response.headers
  }

  /** @deprecated use `ctx.http()` instead */
  axios<T = any>(config: { url: string } & HTTP.RequestConfig): Promise<HTTP.Response<T>>
  axios<T = any>(url: string, config?: HTTP.RequestConfig): Promise<HTTP.Response<T>>
  axios(...args: any[]) {
    const caller = this[Context.origin]
    caller.emit('internal/warning', 'ctx.http.axios() is deprecated, use ctx.http() instead')
    if (typeof args[0] === 'string') {
      return this(args[0], args[1])
    } else {
      return this(args[0].url, args[0])
    }
  }

  ws(url: string | URL, init?: HTTP.Config) {
    const caller = this[Context.origin]
    const config = this.resolveConfig(init)
    url = this.resolveURL(url, config, true)
    let options: ClientOptions | undefined
    if (WebSocket !== globalThis.WebSocket) {
      options = {
        handshakeTimeout: config?.timeout,
        headers: config?.headers,
      }
      caller.emit(this, 'http/websocket-init', url, options, config)
    }
    const socket = new WebSocket(url, options as never)
    const dispose = caller.on('dispose', () => {
      socket.close(1000, 'context disposed')
    })
    socket.addEventListener('close', () => {
      dispose()
    })
    return socket
  }

  async file(this: HTTP, url: string, options: FileOptions = {}): Promise<FileResponse> {
    const task = await this[Context.origin].serial(this, 'http/file', url, options)
    if (task) return task
    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/MIME_types/Common_types
    const capture = /^data:([\w/.+-]+);base64,(.*)$/.exec(url)
    if (capture) {
      const [, type, base64] = capture
      let name = 'file'
      const ext = type && mimedb[type]?.extensions?.[0]
      if (ext) name += `.${ext}`
      return { type, mime: type, data: Binary.fromBase64(base64), filename: name }
    }
    const { headers, data, url: responseUrl } = await this<ArrayBuffer>(url, {
      method: 'GET',
      responseType: 'arraybuffer',
      timeout: +options.timeout! || undefined,
    })
    const type = headers.get('content-type')!
    const [, name] = responseUrl.match(/.+\/([^/?]*)(?=\?)?/)!
    return { type, mime: type, filename: name, data }
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
