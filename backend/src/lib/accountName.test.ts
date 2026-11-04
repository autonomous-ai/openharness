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
      expect(parseAccountName(input), JSON.stringify(input)).toMatchObject({ ok: false })
    }
  })

  it('is refused with a hidden, control or line-breaking character', () => {
    for (const input of ['a​b', 'a‮b', 'a⁦b', 'a\nb', 'a\rb', 'a\u0007b', 'a b', 'a b', '﻿Elvis']) {
      expect(parseAccountName(input), JSON.stringify(input)).toMatchObject({ ok: false })
    }
  })

  it('takes up to 60 characters, counted as people see them', () => {
    expect(MAX_ACCOUNT_NAME_LENGTH).toBe(60)
    expect(parseAccountName('😀'.repeat(60))).toEqual({ ok: true, name: '😀'.repeat(60) })
    expect(parseAccountName('😀'.repeat(61))).toMatchObject({ ok: false })
    expect(parseAccountName('a'.repeat(60))).toEqual({ ok: true, name: 'a'.repeat(60) })
    expect(parseAccountName('a'.repeat(61))).toMatchObject({ ok: false })
  })

  // Outside a Swarm the account name meets no clash check (store reviews, community comments, shares, terminal observers),
  // so it keeps the Swarm name's own refusals (superTabs/personNames.ts nameRefusal): review 1 of #2917.
  it('is refused as a web address, which would show as a link', () => {
    for (const input of ['https://ev.il', 'see http://x.y', 'www.example.com', 'ＷＷＷ.example.com']) {
      expect(parseAccountName(input), input).toEqual({ ok: false, code: 'INVALID_NAME', message: 'Use a name, not a web address.' })
    }
  })

  it('is refused as a role\'s or the Swarm\'s own name, numbered or in wide letters too', () => {
    for (const input of ['Product Manager', 'PM', 'Lead', 'Lead 2', 'Engineer', 'Reviewer', 'Harness', 'admin', 'System-3', 'Ｈａｒｎｅｓｓ', 'Someone', 'you']) {
      expect(parseAccountName(input), input).toEqual({ ok: false, code: 'NAME_RESERVED', message: `${input} is a role's name. Choose another.` })
    }
  })

  // Shares, the leaderboard and community comments show the name alone where people tell each other apart by email, so an
  // email-shaped name could pose as another person: review 2 of #2917.
  it('is refused with an @, so it never reads as someone\'s email', () => {
    for (const input of ['ken15@autonomous.ai', 'Ken @ Autonomous', '@ken', 'ken\uFF20autonomous.ai']) {
      expect(parseAccountName(input), input).toEqual({ ok: false, code: 'INVALID_NAME', message: 'Use a name, not an email address.' })
    }
  })

  it('still takes a name that only contains a role\'s word', () => {
    expect(parseAccountName('Lead Singer Elvis')).toEqual({ ok: true, name: 'Lead Singer Elvis' })
    expect(parseAccountName('Harnessa')).toEqual({ ok: true, name: 'Harnessa' })
  })
})
