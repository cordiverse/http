import { Context } from 'cordis'
import Logger from 'reggol'

export { Logger }

declare module 'cordis' {
  interface Context {
    baseDir: string
    logger: LoggerService
  }
}

interface LoggerService {
  (name: string): Logger
}

export function apply(ctx: Context) {
  ctx.root.baseDir = globalThis.process?.cwd() || ''

  ctx.provide('logger')

  ctx.logger = function (name: string) {
    return new Logger(name, { [Context.current]: this })
  }

  ctx.on('internal/error', function (format, ...args) {
    this.logger('app').error(format, ...args)
  })

  ctx.on('internal/warning', function (format, ...args) {
    this.logger('app').warn(format, ...args)
  })
}
