import { Context, Service } from 'cordis'
import { remove } from 'cosmokit'

declare module 'cordis' {
  interface Context {
    timer: TimerService
  }
}

class TimerService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'timer', true)
    ctx.mixin('timer', ['setTimeout', 'setInterval', 'sleep', 'throttle', 'debounce'])
  }

  setTimeout(callback: () => void, delay: number) {
    const dispose = this[Context.current].effect(() => {
      const timer = setTimeout(() => {
        dispose()
        callback()
      }, delay)
      return () => clearTimeout(timer)
    })
    return dispose
  }

  setInterval(callback: () => void, delay: number) {
    return this[Context.current].effect(() => {
      const timer = setInterval(callback, delay)
      return () => clearInterval(timer)
    })
  }

  sleep(delay: number) {
    const caller = this[Context.current]
    return new Promise<void>((resolve, reject) => {
      const dispose1 = this.setTimeout(() => {
        dispose1()
        dispose2()
        resolve()
      }, delay)
      const dispose2 = caller.on('dispose', () => {
        dispose1()
        dispose2()
        reject(new Error('Context has been disposed'))
      })
    })
  }
}

export default TimerService
