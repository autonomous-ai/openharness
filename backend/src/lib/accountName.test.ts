import { describe, expect, it } from 'vitest'
import { MAX_ACCOUNT_NAME_LENGTH, parseAccountName } from './accountName.js'

describe('an account name a person sets for themselves', () => {
  it('is trimmed, with one space between words', () => {
    expect(parseAccountName('  Elvis  ')).toEqual({ ok: true, name: 'Elvis' })
    expect(parseAccountName('Minh\t  Nguyen')).toEqual({ ok: true, name: 'Minh Nguyen' })
    expect(parseAccountName('Lê　Huy')).toEqual({ ok: true, name: 'Lê Huy' })
  })

  it('is stored in one form, so the same letters are the same name', () => {
    expect(parseAccountName('Lê')).toEqual({ ok: true, name: 'Lê' })
  })

  it('is refused when empty or not words', () => {
    for (const input of ['', '   ', '\t', 42, null, undefined, ['Elvis'], { name: 'Elvis' }]) {
      expect(parseAccountName(input), JSON.stringify(input)).toEqual({ ok: false })
    }
  })

  it('is refused with a hidden, control or line-breaking character', () => {
    for (const input of ['a​b', 'a‮b', 'a⁦b', 'a\nb', 'a\rb', 'a\u0007b', 'a b', 'a b', '﻿Elvis']) {
      expect(parseAccountName(input), JSON.stringify(input)).toEqual({ ok: false })
    }
  })

  it('takes up to 60 characters, counted as people see them', () => {
    expect(MAX_ACCOUNT_NAME_LENGTH).toBe(60)
    expect(parseAccountName('😀'.repeat(60))).toEqual({ ok: true, name: '😀'.repeat(60) })
    expect(parseAccountName('😀'.repeat(61))).toEqual({ ok: false })
    expect(parseAccountName('a'.repeat(60))).toEqual({ ok: true, name: 'a'.repeat(60) })
    expect(parseAccountName('a'.repeat(61))).toEqual({ ok: false })
  })
})
