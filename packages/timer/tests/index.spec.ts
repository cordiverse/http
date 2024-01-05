import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import { Context } from 'cordis'
import { expect } from 'chai'
import Timer from '../src'
import assert from 'node:assert'

function tick(delay = 0) {
  mock.timers.tick(delay)
  return new Promise<void>(resolve => process.nextTick(resolve))
}

beforeEach(() => {
  mock.timers.enable()
})

afterEach(() => {
  mock.timers.reset()
})

function withContext(callback: (ctx: Context) => Promise<void>) {
  return () => new Promise<void>((resolve, reject) => {
    const ctx = new Context()
    ctx.plugin(Timer)
    ctx.plugin(() => {
      callback(ctx).then(resolve, reject)
    })
  })
}

describe('ctx.setTimeout()', () => {
  test('basic support', withContext(async (ctx) => {
    const callback = mock.fn()
    ctx.setTimeout(callback, 1000)
    expect(callback.mock.calls).to.have.length(0)
    await tick(1000)
    expect(callback.mock.calls).to.have.length(1)
    await tick(1000)
    expect(callback.mock.calls).to.have.length(1)
  }))

  test('dispose', withContext(async (ctx) => {
    const callback = mock.fn()
    const dispose = ctx.setTimeout(callback, 1000)
    expect(callback.mock.calls).to.have.length(0)
    dispose()
    await tick(5000)
    expect(callback.mock.calls).to.have.length(0)
  }))
})

describe('ctx.setInterval()', () => {
  test('basic support', withContext(async (ctx) => {
    const callback = mock.fn()
    const dispose = ctx.setInterval(callback, 1000)
    expect(callback.mock.calls).to.have.length(0)
    await tick(1000)
    expect(callback.mock.calls).to.have.length(1)
    await tick(1000)
    expect(callback.mock.calls).to.have.length(2)
    dispose()
    await tick(5000)
    expect(callback.mock.calls).to.have.length(2)
  }))
})

describe('ctx.sleep()', () => {
  test('basic support', withContext(async (ctx) => {
    const resolve = mock.fn()
    const reject = mock.fn()
    ctx.sleep(1000).then(resolve, reject)
    await tick(500)
    assert.strictEqual(resolve.mock.calls.length, 0)
    assert.strictEqual(reject.mock.calls.length, 0)
    await tick(500)
    assert.strictEqual(resolve.mock.calls.length, 1)
    assert.strictEqual(reject.mock.calls.length, 0)
    ctx.scope.dispose()
    await tick(5000)
    assert.strictEqual(resolve.mock.calls.length, 1)
    assert.strictEqual(reject.mock.calls.length, 0)
  }))
})
