export namespace WebSocket {
  /** The connection is not yet open. */
  export const CONNECTING = 0
  /** The connection is open and ready to communicate. */
  export const OPEN = 1
  /** The connection is in the process of closing. */
  export const CLOSING = 2
  /** The connection is closed. */
  export const CLOSED = 3

  export type ReadyState =
    | typeof CONNECTING
    | typeof OPEN
    | typeof CLOSING
    | typeof CLOSED

  export interface EventMap {
    open: Event
    error: ErrorEvent
    message: MessageEvent
    close: CloseEvent
  }

  export interface EventListener {
    (event: Event): void
  }

  export interface Event {
    type: string
    target: WebSocket
  }

  export interface CloseEvent extends Event {
    code: number
    reason: string
  }

  export interface MessageEvent extends Event {
    data: string
  }

  export interface ErrorEvent extends Event {
    message?: string
  }
}

export interface WebSocket {
  readonly url?: string
  readonly protocol?: string
  readonly readyState?: number
  close(code?: number, reason?: string): void
  send(data: string): void
  dispatchEvent?(event: any): boolean
  addEventListener<K extends keyof WebSocket.EventMap>(type: K, listener: (event: WebSocket.EventMap[K]) => void): void
  removeEventListener<K extends keyof WebSocket.EventMap>(type: K, listener: (event: WebSocket.EventMap[K]) => void): void
}
