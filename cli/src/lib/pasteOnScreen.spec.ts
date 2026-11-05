import { describe, expect, it, vi } from 'vitest'
import { PASTE_LAND_LIMIT_MS, pasteComesAsKeys, pasteOnScreen } from './pasteOnScreen.js'

// Codex on Windows takes a paste as a stream of keys, and an Enter within 120 ms of the last counts as a newline in it. Its 2,249
// characters stayed in the composer as "[Pasted Content 2250 chars]", and every later message waited behind that "draft", for good.
describe('whether a paste comes as keys', () => {
  it('is Codex on Windows alone', () => {
    expect(pasteComesAsKeys('codex', 'win32')).toBe(true)
    expect(pasteComesAsKeys('codex', 'darwin')).toBe(false)
    expect(pasteComesAsKeys('claude', 'win32')).toBe(false)
  })
})

describe('waiting for a paste to land before its Enter', () => {
  const EMPTY = { draft: false, screen: '› ' }
  const PASTED = { draft: true, screen: '› [Pasted Content 2249 chars]' }
  const run = async (reads: Array<{ draft: boolean; screen: string | null }>, before: string | null = '› ') => {
    let asked = 0, waited = 0
    const landed = await pasteOnScreen(async () => reads[Math.min(asked++, reads.length - 1)], before, async (ms) => { waited += ms })
    return { landed, asked, waited }
  }

  it('waits through the reads that show nothing yet, until the composer holds it and has stopped changing', async () => {
    const { landed, asked } = await run([EMPTY, EMPTY, { draft: true, screen: '› part' }, PASTED, PASTED])
    expect(landed).toBe(true)
    expect(asked).toBe(5)
  })

  it('does not take a draft that was there before the paste for the paste', async () => {
    const before = '› what a person was typing'
    const typed = { draft: true, screen: before }
    const { asked } = await run([typed, typed, PASTED, PASTED], before)
    expect(asked).toBe(4)
  })

  it('gives up at its limit and says so, so the Enter is not held for good', async () => {
    const { landed, waited } = await run([EMPTY])
    expect(landed).toBe(false)
    expect(waited).toBeGreaterThanOrEqual(PASTE_LAND_LIMIT_MS)
  })

  it('survives a read that fails', async () => {
    const reads = [() => Promise.reject(new Error('gone')), async () => PASTED, async () => PASTED]
    let asked = 0
    const wait = vi.fn(async () => {})
    expect(await pasteOnScreen(() => reads[asked++]!(), '› ', wait)).toBe(true)
  })
})
