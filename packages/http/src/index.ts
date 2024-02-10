import { Context } from 'cordis'
import { Dict, trimSlash } from 'cosmokit'
import { WebSocket } from 'unws'
import { ClientOptions } from 'ws'

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
  get<T>(url: string, config?: HTTP.RequestConfig): Promise<T>
  delete<T>(url: string, config?: HTTP.RequestConfig): Promise<T>
  head(url: string, config?: HTTP.RequestConfig): Promise<Dict>
  patch<T>(url: string, data?: any, config?: HTTP.RequestConfig): Promise<T>
  post<T>(url: string, data?: any, config?: HTTP.RequestConfig): Promise<T>
  put<T>(url: string, data?: any, config?: HTTP.RequestConfig): Promise<T>
  /** @deprecated use `ctx.http()` instead */
  axios<T>(url: string, config?: HTTP.RequestConfig): Promise<HTTP.Response<T>>
  ws(url: string, config?: HTTP.RequestConfig): Promise<WebSocket>
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
    responseType?: ResponseType
  }

  export class Error extends _Error {
    response?: Response
  }

  export interface Response<T = any> {
    data: T
    status: number
    statusText: string
    headers: Dict
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

    const intercept = caller[Context.intercept]
    merge(intercept.http)
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
    const response = await fetch(url, {
      method,
      body: config.data,
      headers: config.headers,
      signal: controller.signal,
    })
    const data = await response.json()
    return {
      data,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
    }
  } as HTTP

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

  http.axios = async function (this: HTTP, url: string, config?: HTTP.Config) {
    const caller = this[Context.current]
    caller.emit('internal/warning', 'ctx.http.axios() is deprecated, use ctx.http() instead')
    return caller.http(url, config)
  }

  ctx.http = Context.associate(http, 'http')
  ctx.on('dispose', () => {
    ctx.http = null as never
  })
}
