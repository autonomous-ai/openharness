import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// The CLI's devices and gateway name what they count from their copy; the report route takes only names from this one.
it('keeps the client and server dial vocabulary identical', () => {
  expect(readFileSync(new URL('../../../cli/src/lib/dialUsageContract.ts', import.meta.url), 'utf8'))
    .toBe(readFileSync(new URL('./dialUsage.ts', import.meta.url), 'utf8'))
})
