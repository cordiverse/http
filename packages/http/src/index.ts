import { Context } from 'cordis'
import { Dict } from 'cosmokit'
import { WebSocket } from 'unws'
import { ClientOptions } from 'ws'

declare module 'cordis' {
  interface Context {
    http: HTTP
  }
}

interface HTTP {
  [Context.current]: Context
  <T>(url: string | URL, config?: HTTP.Config): Promise<HTTP.Response<T>>
  <T>(method: HTTP.Method, url: string | URL, config?: HTTP.Config): Promise<HTTP.Response<T>>
  get<T>(url: string, config?: HTTP.Config): Promise<T>
  delete<T>(url: string, config?: HTTP.Config): Promise<T>
  head(url: string, config?: HTTP.Config): Promise<Dict>
  patch<T>(url: string, data?: any, config?: HTTP.Config): Promise<T>
  post<T>(url: string, data?: any, config?: HTTP.Config): Promise<T>
  put<T>(url: string, data?: any, config?: HTTP.Config): Promise<T>
  /** @deprecated use `ctx.http()` instead */
  axios<T>(url: string, config?: HTTP.Config): Promise<HTTP.Response<T>>
  ws(url: string, config?: HTTP.Config): Promise<WebSocket>
}

const _Error = Error

namespace HTTP {
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
    method?: Method
    params?: Dict
    data?: any
    headers?: Dict
    timeout?: number
    proxyAgent?: string
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

export function apply(ctx: Context) {
  ctx.provide('http')

  const http = async function http(this: Context, ...args: any[]) {
    let method: HTTP.Method | undefined
    if (typeof args[1] === 'string' || args[1] instanceof URL) {
      method = args.shift()
    }
    const response = await fetch(args[0], {
      method,
      ...args[1],
    })
    const data = await response.json()
    return {
      data,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
    }
  } as HTTP

  for (const method of ['GET', 'DELETE'] as const) {
    http[method.toLowerCase()] = async function (this: HTTP, url: string, config?: HTTP.Config) {
      const caller = this[Context.current]
      const response = await caller.http(url, {
        method,
        ...config,
      })
      return response.data
    }
  }

  for (const method of ['PATCH', 'POST', 'PUT'] as const) {
    http[method.toLowerCase()] = async function (this: HTTP, url: string, data?: any, config?: HTTP.Config) {
      const caller = this[Context.current]
      const response = await caller.http(url, {
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

  http.ws = async function (this: HTTP, url: string, config?: HTTP.Config) {
    // const caller = this[Context.current]
    return new WebSocket(url, 'Server' in WebSocket ? {
      // agent: caller.agent(config?.proxyAgent),
      handshakeTimeout: config?.timeout,
      headers: {
        ...config?.headers,
      },
    } as ClientOptions as never : undefined)
  }

  http.axios = async function (this: HTTP, url: string, config?: HTTP.Config) {
    const caller = this[Context.current]
    caller.emit('internal/warning', 'ctx.http.axios() is deprecated, use ctx.http() instead')
    return caller.http(url, config)
  }

  ctx.http = http
  ctx.on('dispose', () => {
    ctx.http = null as never
  })
}
