import { describe, expect, it } from 'vitest'

// The bundle's escaping (scripts/lib/asciiOnly.mjs, build-bundle.mjs): what it rewrites must mean what it did.
// @ts-expect-error — plain ESM with no declaration file
const { asciiOnly } = await import('../scripts/lib/asciiOnly.mjs') as { asciiOnly: (code: string) => string }

describe('asciiOnly', () => {
  it('leaves Latin-1, which V8 still stores a byte a character, and escapes the rest', () => {
    expect(asciiOnly('ß ø © a')).toBe('ß ø © a')
    expect(asciiOnly('/^[✳❯]/')).toBe('/^[\\u2733\\u276f]/')
    expect(/[^\x00-\xff]/.test(asciiOnly('— 🎉 │'))).toBe(false)
  })

  it('keeps what a regular expression matches, with and without u', () => {
    for (const [source, flags, input] of [
      ['^[✳✱]+\\s', '', '✳✱ x'], ['^(?:🎉\\s*)?Update', '', '🎉 Update'], ['^(?:🎉\\s*)?Update', 'u', '🎉 Update'],
      ['[🎉]', 'u', 'a🎉'], ['[\\p{L}\'’-]+', 'u', 'it’s'], ['(?<=…)\\s*\\d', '', '… 5'],
    ]) {
      const escaped = new RegExp(asciiOnly(source), flags)
      expect(escaped.exec(input)).toEqual(new RegExp(source, flags).exec(input))
      expect(escaped.exec(input)).not.toBeNull()
    }
  })

  it('refuses a backslash before such a character, which escaping would change', () => {
    expect(() => asciiOnly('/\\✳/')).toThrow(/backslash/)
  })
})
