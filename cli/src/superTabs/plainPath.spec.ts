import { describe, expect, it } from 'vitest'
import { plainPath } from './plainPath.js'

describe('a file\'s path as a line says it', () => {
  it('keeps its letters, digits, spaces and `. _ / + -`, and drops what would tag, link or end a code span', () => {
    expect(plainPath('src/app/hub_v2+old-1.ts')).toBe('src/app/hub_v2+old-1.ts')
    expect(plainPath('docs/@juno [x](y) `z`.md')).toBe('docs/juno xy z.md')
  })

  it('says the last hundred letters of a long one, where its name is', () => {
    const long = `${'deep/'.repeat(30)}name.ts`
    expect(plainPath(long)).toBe(`…${long.slice(-99)}`)
    expect([...plainPath(long)]).toHaveLength(100)
    expect(plainPath(long.slice(-100))).toBe(long.slice(-100))
  })
})
