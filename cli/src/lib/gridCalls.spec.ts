import { describe, expect, it } from 'vitest'
import { gridCallStarted, withGridCallsPaused } from './gridCalls.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('withGridCallsPaused — an install and the grid calls Harness makes', () => {
  it('waits for the grid calls already running before it starts', async () => {
    const done = await gridCallStarted()
    let ran = false
    const install = withGridCallsPaused(async () => { ran = true })
    await tick()
    expect(ran).toBe(false)
    done()
    await install
    expect(ran).toBe(true)
  })

  it('holds a grid call asked for meanwhile until the install is over', async () => {
    let finish: () => void = () => {}
    const install = withGridCallsPaused(() => new Promise<void>((resolve) => { finish = resolve }))
    await tick()
    let started = false
    const call = gridCallStarted().then((done) => { started = true; return done })
    await tick()
    expect(started).toBe(false)
    finish()
    await install
    ;(await call)()
    expect(started).toBe(true)
  })

  it('starts anyway once the wait is over — grid\'s installer still refuses to replace a running grid', async () => {
    const done = await gridCallStarted()
    let ran = false
    await withGridCallsPaused(async () => { ran = true }, 20)
    expect(ran).toBe(true)
    done()
  })

  it('a call counted twice as done is counted once', async () => {
    const done = await gridCallStarted()
    done()
    done()
    let ran = false
    await withGridCallsPaused(async () => { ran = true })
    expect(ran).toBe(true)
  })
})
