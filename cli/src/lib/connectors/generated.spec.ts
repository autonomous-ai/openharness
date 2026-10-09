import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// @ts-expect-error: a plain .mjs build script, without types.
import { render } from '../../../scripts/connector-assets.mjs'

describe('the connectors\' generated modules', () => {
  it('match assets/: run node scripts/connector-assets.mjs after changing them', () => {
    for (const [name, body] of Object.entries(render() as Record<string, string>)) {
      expect(readFileSync(fileURLToPath(new URL(`./generated/${name}`, import.meta.url)), 'utf8'), name).toBe(body)
    }
  })
})
