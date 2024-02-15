import { Context, Service } from 'cordis'
import { defineProperty, Dict, trimSlash } from 'cosmokit'
import { ClientOptions } from 'ws'
import { WebSocket } from 'undios/adapter'

declare module 'cordis' {
  interface Context {
    http: HTTP
  }

  interface Intercept {
    http: HTTP.Config
  }

  interface Events {
    'http/config'(config: HTTP.Config): void
    'http/fetch-init'(init: RequestInit, config: HTTP.Config): void
    'http/websocket-init'(init: ClientOptions, config: HTTP.Config): void
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
    <T = any>(url: string, config?: HTTP.RequestConfig): Promise<T>
  }

  export interface Request2 {
    (url: string, data?: any, config?: HTTP.RequestConfig & { responseType: 'arraybuffer' }): Promise<ArrayBuffer>
    (url: string, data?: any, config?: HTTP.RequestConfig & { responseType: 'stream' }): Promise<ReadableStream<Uint8Array>>
    (url: string, data?: any, config?: HTTP.RequestConfig & { responseType: 'text' }): Promise<string>
    <T = any>(url: string, data?: any, config?: HTTP.RequestConfig): Promise<T>
  }

  export interface Config {
    baseURL?: string
    /** @deprecated use `baseURL` instead */
    endpoint?: string
    headers?: Dict
    timeout?: number
  }

  export interface RequestConfig extends Config {
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

  export type Error = HTTPError
}

export interface HTTP {
  <T = any>(url: string | URL, config?: HTTP.RequestConfig): Promise<HTTP.Response<T>>
  <T = any>(method: HTTP.Method, url: string | URL, config?: HTTP.RequestConfig): Promise<HTTP.Response<T>>
  config: HTTP.Config
  get: HTTP.Request1
  delete: HTTP.Request1
  patch: HTTP.Request2
  post: HTTP.Request2
  put: HTTP.Request2
}

export class HTTP extends Service {
  static Error = HTTPError
  /** @deprecated use `HTTP.Error.is()` instead */
  static isAxiosError = HTTPError.is

  static {
    for (const method of ['get', 'delete'] as const) {
      defineProperty(HTTP.prototype, method, async function (this: HTTP, url: string, config?: HTTP.Config) {
        const response = await this(method, url, config)
        return response.data
      })
    }

    for (const method of ['patch', 'post', 'put'] as const) {
      defineProperty(HTTP.prototype, method, async function (this: HTTP, url: string, data?: any, config?: HTTP.Config) {
        const response = await this(method, url, { data, ...config })
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

  resolveConfig(init?: HTTP.RequestConfig): HTTP.RequestConfig {
    const caller = this[Context.current]
    let result = { headers: {}, ...this.config }
    caller.emit('http/config', result)
    let intercept = caller[Context.intercept]
    while (intercept) {
      result = HTTP.mergeConfig(result, intercept.http)
      intercept = Object.getPrototypeOf(intercept)
    }
    result = HTTP.mergeConfig(result, init)
    return result
  }

  resolveURL(url: string | URL, config: HTTP.RequestConfig) {
    if (config.endpoint) {
      // this[Context.current].emit('internal/warning', 'endpoint is deprecated, please use baseURL instead')
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

  async [Context.invoke](...args: any[]) {
    const caller = this[Context.current]
    let method: HTTP.Method | undefined
    if (typeof args[1] === 'string' || args[1] instanceof URL) {
      method = args.shift()
    }
    const config = this.resolveConfig(args[1])
    const url = this.resolveURL(args[0], config)

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
      const init: RequestInit = { method, headers: config.headers, signal: controller.signal }
      caller.emit('http/fetch-init', init, config)
      const raw = await fetch(url, init).catch((cause) => {
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
    const response = await this('HEAD', url, config)
    return response.headers
  }

  /** @deprecated use `ctx.http()` instead */
  axios<T = any>(config: { url: string } & HTTP.RequestConfig): Promise<HTTP.Response<T>>
  axios<T = any>(url: string, config?: HTTP.RequestConfig): Promise<HTTP.Response<T>>
  axios(...args: any[]) {
    const caller = this[Context.current]
    caller.emit('internal/warning', 'ctx.http.axios() is deprecated, use ctx.http() instead')
    if (typeof args[0] === 'string') {
      return this(args[0], args[1])
    } else {
      return this(args[0].url, args[0])
    }
  }

  async ws(this: HTTP, url: string | URL, init?: HTTP.Config) {
    const caller = this[Context.current]
    const config = this.resolveConfig(init)
    url = this.resolveURL(url, config)
    let options: ClientOptions | undefined
    if ('Server' in WebSocket) {
      options = {
        handshakeTimeout: config?.timeout,
        headers: config?.headers,
      }
      caller.emit('http/websocket-init', options, config)
    }
    const socket = new WebSocket(url, options)
    const dispose = caller.on('dispose', () => {
      socket.close(1001, 'context disposed')
    })
    socket.addEventListener('close', () => {
      dispose()
    })
    return socket
  }
}

export default HTTP
