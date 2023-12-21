import { Context, Service } from 'cordis'
import { defineProperty, remove } from 'cosmokit'
import Logger from 'reggol'

export { Logger }

declare module 'cordis' {
  interface Context {
    timer: TimerService
  }
}

class TimerService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'timer', true)
    defineProperty(this, Context.current, ctx)
  }

  createTimerDispose(timer: number | NodeJS.Timeout) {
    const dispose = () => {
      clearTimeout(timer)
      if (!this[Context.current].scope) return
      return remove(this[Context.current].scope.disposables, dispose)
    }
    this[Context.current].scope.disposables.push(dispose)
    return dispose
  }

  setTimeout(callback: (...args: any[]) => void, ms: number, ...args: any[]) {
    const dispose = this.createTimerDispose(setTimeout(() => {
      dispose()
      callback()
    }, ms, ...args))
    return dispose
  }

  setInterval(callback: (...args: any[]) => void, ms: number, ...args: any[]) {
    return this.createTimerDispose(setInterval(callback, ms, ...args))
  }

  sleep(ms: number) {
    return new Promise<void>((resolve, reject) => {
      const dispose1 = this.setTimeout(() => {
        dispose1()
        dispose2()
        resolve()
      }, ms)
      const dispose2 = this[Context.current].on('dispose', () => {
        dispose1()
        dispose2()
        reject(new Error('Context disposed'))
      })
    })
  }
}

export default TimerService
