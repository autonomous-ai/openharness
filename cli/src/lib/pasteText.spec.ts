import { describe, expect, it } from 'vitest'
import { neutralizePasteControls } from './pasteText.js'

const ESC = '\x1b'

describe('what a bracketed paste may carry', () => {
  it('shows the paste\'s own markers as text, so a message cannot end its paste and type the rest', () => {
    // The message that made the engine run `!exit` on tmux 3.2a and 3.3a (e2e/content.e2e.ts).
    expect(neutralizePasteControls(`hello${ESC}[201~\r!exit\r`)).toBe('hello^[[201~\n!exit\n')
    expect(neutralizePasteControls(`${ESC}[200~typed?${ESC}[201~`)).toBe('^[[200~typed?^[[201~')
    expect(neutralizePasteControls(`before${ESC}[2J${ESC}[Hafter`)).toBe('before^[[2J^[[Hafter')
  })

  it('makes every control but tab and newline visible, in caret notation, as tmux 3.7c does', () => {
    for (let code = 0; code < 0x20; code++) {
      if (code === 0x09 || code === 0x0a || code === 0x0d) continue
      expect(neutralizePasteControls(`a${String.fromCharCode(code)}b`), `0x${code.toString(16)}`)
        .toBe(`a^${String.fromCharCode(code + 0x40)}b`)
    }
    expect(neutralizePasteControls('a\x7fb')).toBe('a^?b')
    expect(neutralizePasteControls('a\tb\nc')).toBe('a\tb\nc')
  })

  it('takes a carriage return, alone or before a newline, as one line break', () => {
    expect(neutralizePasteControls('one\r\ntwo\rthree\nfour')).toBe('one\ntwo\nthree\nfour')
  })

  it('shows an 8-bit control as the ESC and letter a terminal may read it as', () => {
    expect(neutralizePasteControls('\u009b31mred')).toBe('^[[31mred')
    expect(neutralizePasteControls('\u009d0;title\u0007')).toBe('^[]0;title^G')
  })

  it('leaves text as people write it exactly as it is', () => {
    for (const text of [
      'a family 👨‍👩‍👧‍👦 and a flag 🇻🇳, joined',
      'שלום עולם and مرحبا بالعالم, right to left',
      'tabs\tbetween\twords and `backticks` $(echo not run) ; | & > <',
      'combining: é ä and a zero-width​space',
      'a caret and a bracket typed by hand: ^[ is two characters',
    ]) expect(neutralizePasteControls(text)).toBe(text)
  })

  it('changes nothing the second time', () => {
    const once = neutralizePasteControls(`x${ESC}[201~\r\n\u009by\x00`)
    expect(neutralizePasteControls(once)).toBe(once)
  })
})
