import { describe, expect, it } from 'vitest'
import { cleanUp } from './cleanup.js'

describe('the gate\'s clean-up', () => {
  it('runs every step after one that throws or hangs, and throws their failures as one at the end', async () => {
    const ran: string[] = []
    const run = cleanUp([
      ['throws', () => {
        ran.push('throws')
        throw new Error('broke')
      }],
      ['hangs', () => {
        ran.push('hangs')
        return new Promise(() => {})
      }],
      ['rejects', async () => {
        ran.push('rejects')
        throw new Error('refused')
      }],
      ['last', () => {
        ran.push('last')
      }],
    ], 50)

    const failure = await run.then(() => undefined, (error: unknown) => error)
    expect(ran).toEqual(['throws', 'hangs', 'rejects', 'last'])
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors.map(({ message }: Error) => message)).toEqual([
      'throws: broke',
      'hangs: did not finish in 50 ms',
      'rejects: refused',
    ])
  })

  it('passes when every step does', async () => {
    await expect(cleanUp([['one', () => {}], ['two', () => Promise.resolve()]], 50)).resolves.toBeUndefined()
  })
})
