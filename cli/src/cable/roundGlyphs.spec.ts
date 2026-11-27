import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { roundDrawable } from './roundGlyphs.js'

/** The firmware's faces: what the round dial draws is decided there, and the copy must not drift from it. */
const FACES = fileURLToPath(
  new URL('../../../devices/harness-device/firmware/main/ui/habitat/focus_faces.c', import.meta.url),
)

describe('roundDrawable', () => {
  it('the table is the firmware\'s', () => {
    const source = readFileSync(FACES, 'utf8')
    const table = /static const uint16_t inter_20_codes\[\] = \{([0-9,]+)\};/.exec(source)
    expect(table).not.toBeNull()
    const codes = table![1].split(',').map(Number)
    // A question is set in Inter 25, which draws from the same table.
    const face = /const ht_pfont_t ht_lv_inter_25 = \{\{[^}]*\},inter_25_glyphs,(\w+),(\d+),/.exec(source)
    expect(face?.[1]).toBe('inter_20_codes')
    expect(Number(face?.[2])).toBe(codes.length)
    // ui_can_display lets a newline through besides the table.
    const drawable = new Set([0x0a, ...codes])
    const differ: number[] = []
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      const kept = roundDrawable(String.fromCodePoint(cp)) !== '?' || cp === 0x3f
      if (kept !== drawable.has(cp)) differ.push(cp)
    }
    expect(differ).toEqual([])
  })

  it('ASCII, Vietnamese, … and ✓ stay, and so does a newline', () => {
    const text = 'Thêm phần kiểm tra … ✓\nAllow Bash? ~/a_b-c.txt'
    expect(roundDrawable(text)).toBe(text)
  })

  it('CJK becomes one ? per character', () => {
    expect(roundDrawable('echo 你好')).toBe('echo ??')
  })

  it('an emoji becomes one ?, not two', () => {
    expect(roundDrawable('rm 🙂.txt')).toBe('rm ?.txt')
  })

  it('an arrow, a tab and a lone surrogate become ?', () => {
    expect(roundDrawable('a→b\tc\ud800d\udc00')).toBe('a?b?c?d?')
  })
})
