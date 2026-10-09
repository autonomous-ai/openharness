import { describe, expect, it, vi } from 'vitest'
import { createPaneOperations } from './paneOperations.js'

describe('core pane operations', () => {
  it('makes Stop join the dispatched pane commit, while other agents remain independent', async () => {
    const operations = createPaneOperations()
    expect(operations.pending('absent')).toBeUndefined()
    await operations.settle('absent')
    let reply!: () => void
    const committed: string[] = []
    const running = operations.run('a', async () => {
      await new Promise<void>(done => { reply = done })
      committed.push('new pane')
      return 'done'
    })
    const stopped = vi.fn()
    const stopping = operations.settle('a').then(() => { expect(committed).toEqual(['new pane']); stopped() })
    expect(operations.busy('a')).toBe(true)
    expect(operations.pending('a')).toBeInstanceOf(Promise)
    await expect(operations.run('a', async () => 'overlap')).rejects.toThrow('already changing')
    expect(await operations.run('b', async () => 'independent')).toBe('independent')
    expect(stopped).not.toHaveBeenCalled()
    reply()
    expect(await running).toBe('done')
    await stopping
    expect(stopped).toHaveBeenCalledOnce()
    expect(operations.busy('a')).toBe(false)
  })
  it('reserves a whole allocation group synchronously and rejects overlaps without partially reserving', async () => {
    const operations = createPaneOperations()
    let finish!: () => void
    const running = operations.runMany(['a', 'b'], () => new Promise<void>(done => { finish = done }))
    expect(operations.busy('a')).toBe(true)
    expect(operations.pending('a')).toBe(operations.pending('b'))
    await expect(operations.runMany(['c', 'b'], async () => {})).rejects.toThrow('already changing')
    expect(operations.busy('c')).toBe(false)
    finish()
    await running
    expect(operations.busy('b')).toBe(false)
  })
  it('reports an uncertain dispatch to the joining Stop and releases the operation', async () => {
    const operations = createPaneOperations()
    const running = operations.run('a', async () => { throw new Error('unconfirmed') })
    const joining = operations.settle('a')
    await expect(running).rejects.toThrow('unconfirmed')
    await expect(joining).rejects.toThrow('unconfirmed')
    expect(operations.busy('a')).toBe(false)
  })
})
