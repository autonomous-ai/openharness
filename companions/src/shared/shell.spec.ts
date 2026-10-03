/**
 * The floor's shell tokenizer (pair/shell.ts), on its own: how each quoting and redirection form is read,
 * and that everything it cannot read with certainty — an expansion, a stray redirection, an unterminated
 * quote, a control character — is refused with a reason rather than guessed at.
 */
import { describe, expect, it } from 'vitest'
import { parseShell, type ShellCommand, type ShellParse } from './shell.js'

const commands = (source: string): ShellCommand[] => {
  const parsed = parseShell(source)
  if (!parsed.ok) throw new Error(`refused ${JSON.stringify(source)}: ${parsed.reason}`)
  return parsed.commands
}
const words = (source: string): string[][] => commands(source).map((c) => c.words.map((w) => w.text))
const reason = (source: string): string => {
  const parsed: ShellParse = parseShell(source)
  if (parsed.ok) throw new Error(`read ${JSON.stringify(source)}`)
  return parsed.reason
}

describe('words', () => {
  it('trims the line, splits on blanks and tabs, and keeps quoted blanks inside one word', () => {
    expect(words('  \tls   -la\t src  ')).toEqual([['ls', '-la', 'src']])
    expect(words(`echo 'a  b' "c d"e f`)).toEqual([['echo', 'a  b', 'c de', 'f']])
  })

  it('removes quotes and escapes, and marks the word as quoted', () => {
    const [cmd] = commands(`r\\m "g"it g''it "a\\"b" "a\\\\b" "a\\nb" \\;`)
    expect(cmd!.words.map((w) => [w.text, w.quoted])).toEqual([
      ['rm', true], ['git', true], ['git', true], ['a"b', true], ['a\\b', true], ['a\\nb', true], [';', true],
    ])
  })

  it('flags an unquoted glob, a leading tilde and an assignment — and not their quoted forms', () => {
    const [cmd] = commands(`X=1 a*b c?d [x] ~/f a~b '*' "~" "X"=1 X"=1" X=1"a" 'X=1' 1X=2 X=a=b`)
    const flags = cmd!.words.map((w) => ({ t: w.text, g: w.glob, h: w.tilde, a: w.assignment }))
    expect(flags).toEqual([
      { t: 'X=1', g: false, h: false, a: true },
      { t: 'a*b', g: true, h: false, a: false },
      { t: 'c?d', g: true, h: false, a: false },
      { t: '[x]', g: true, h: false, a: false },
      { t: '~/f', g: false, h: true, a: false },
      { t: 'a~b', g: false, h: false, a: false },
      { t: '*', g: false, h: false, a: false },
      { t: '~', g: false, h: false, a: false },
      { t: 'X=1', g: false, h: false, a: false },     // the name was quoted: not an assignment
      { t: 'X=1', g: false, h: false, a: false },     // the = was quoted: not an assignment either
      { t: 'X=1a', g: false, h: false, a: true },     // only the value was quoted: still an assignment
      { t: 'X=1', g: false, h: false, a: false },
      { t: '1X=2', g: false, h: false, a: false },    // not a name
      { t: 'X=a=b', g: false, h: false, a: true },
    ])
  })

  it('a # or ! inside a word is a letter, not a comment or a negation', () => {
    expect(words('echo a#b c!d')).toEqual([['echo', 'a#b', 'c!d']])
    expect(reason('echo #x')).toBe('a comment')
    expect(reason('! ls')).toBe('a negation or history expansion')
  })
})

describe('separators', () => {
  it('splits on ; | || |& & && and nothing else', () => {
    expect(words('a;b|c||d|&e&f&&g')).toEqual([['a'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g']])
    expect(words('a ; b')).toEqual([['a'], ['b']])
  })

  it('refuses an empty command on either side of a separator', () => {
    expect(reason('; ls')).toBe('an empty command before ;')
    expect(reason('ls |')).toBe('an empty command before the end')
    expect(reason('ls && && ls')).toBe('an empty command before &')
    expect(reason('| ls')).toBe('an empty command before |')
  })
})

describe('redirections', () => {
  it('reads every operator, with its file descriptor and target', () => {
    const r = (source: string) => commands(source)[0]!.redirects
    expect(r('a > f')).toEqual([{ op: '>', fd: null, target: 'f' }])
    expect(r('a >>f')).toEqual([{ op: '>>', fd: null, target: 'f' }])
    expect(r('a >|f')).toEqual([{ op: '>|', fd: null, target: 'f' }])
    expect(r('a 2>&1')).toEqual([{ op: '>&', fd: 2, target: '1' }])
    expect(r('a <f')).toEqual([{ op: '<', fd: null, target: 'f' }])
    expect(r('a <&3')).toEqual([{ op: '<&', fd: null, target: '3' }])
    expect(r('a &>f')).toEqual([{ op: '&>', fd: null, target: 'f' }])
    expect(r('a &>>f')).toEqual([{ op: '&>>', fd: null, target: 'f' }])
    expect(r('a 10>f')).toEqual([{ op: '>', fd: 10, target: 'f' }])
    // A digit word that was quoted is an argument, not a descriptor.
    const quoted = commands(`a "2">f`)[0]!
    expect(quoted.words.map((w) => w.text)).toEqual(['a', '2'])
    expect(quoted.redirects).toEqual([{ op: '>', fd: null, target: 'f' }])
  })

  it('a redirection target ends at a separator, a blank or another redirection', () => {
    expect(commands('a >f|b')).toEqual([
      { words: [expect.objectContaining({ text: 'a' })], redirects: [{ op: '>', fd: null, target: 'f' }] },
      { words: [expect.objectContaining({ text: 'b' })], redirects: [] },
    ])
    expect(commands('a >f &>g')[0]!.redirects.map((r) => r.op)).toEqual(['>', '&>'])
    expect(commands('a >f 2>g')[0]!.redirects).toEqual([{ op: '>', fd: null, target: 'f' }, { op: '>', fd: 2, target: 'g' }])
    expect(commands('>f')).toEqual([{ words: [], redirects: [{ op: '>', fd: null, target: 'f' }] }])
  })

  it('refuses a target the shell would expand, however the word ends', () => {
    for (const source of ['a > *.txt', 'a > *.txt;b', 'a >~/f', 'a > f*|b', 'a >x?&b', 'a > [f]>g', 'a > ~ 2>&1', 'a >*&>f']) {
      expect(reason(source)).toBe('a redirection target that the shell would expand')
    }
  })

  it('refuses a redirection with no target, or two in a row', () => {
    expect(reason('a >')).toBe('a redirection with no target before the end')
    expect(reason('a > ;b')).toBe('a redirection with no target before ;')
    expect(reason('a > | b')).toBe('a redirection with no target before |')
    expect(reason('a > > f')).toBe('two redirections in a row')
    expect(reason('a >&>f')).toBe('two redirections in a row')
  })

  it('refuses process substitution, heredocs, herestrings and read-write opens', () => {
    expect(reason('a <(b)')).toBe('a process substitution')
    expect(reason('a >(b)')).toBe('a process substitution')
    expect(reason('a <<EOF')).toBe('a heredoc, herestring or read-write redirection')
    expect(reason('a <<<x')).toBe('a heredoc, herestring or read-write redirection')
    expect(reason('a <>f')).toBe('a heredoc, herestring or read-write redirection')
  })
})

describe('what it refuses', () => {
  it('an empty or blank line', () => {
    expect(reason('')).toBe('empty')
    expect(reason(' \t ')).toBe('empty')
  })

  it('more than one line, however the line ends', () => {
    expect(reason('ls\nrm x')).toBe('multi-line')
    expect(reason('ls\r')).toBe('multi-line')
    expect(reason('ls \\\nrm x')).toBe('multi-line')
  })

  it('a control character anywhere, quoted or not', () => {
    for (const c of ['\x00', '\x07', '\x08', '\x0b', '\x0c', '\x1b', '\x7f']) {
      expect(reason(`ls${c}`)).toBe('control character')
      expect(reason(`echo '${c}'`)).toBe('control character')
    }
  })

  it('every expansion: $, backticks, subshells, braces — also inside double quotes', () => {
    expect(reason('echo $HOME')).toBe('an expansion ($)')
    expect(reason(`echo $'\\x41'`)).toBe('an expansion ($)')
    expect(reason('echo `id`')).toBe('a command substitution (`)')
    expect(reason('(ls)')).toBe('a subshell or process substitution')
    expect(reason('echo a)')).toBe('a subshell or process substitution')
    expect(reason('{ ls; }')).toBe('a brace group or brace expansion')
    expect(reason('echo a}')).toBe('a brace group or brace expansion')
    expect(reason('echo "a$b"')).toBe('an expansion inside double quotes')
    expect(reason('echo "a`b`"')).toBe('an expansion inside double quotes')
    // An escaped $ or ` inside double quotes is a letter; outside quotes the escape is still refused-free.
    expect(words('echo "\\$x" "\\`" \\$')).toEqual([['echo', '$x', '`', '$']])
  })

  it('an unterminated quote or a trailing backslash', () => {
    expect(reason(`echo 'a`)).toBe('an unterminated quote')
    expect(reason('echo "a')).toBe('an unterminated quote')
    expect(reason('echo "a\\"')).toBe('an unterminated quote')
    expect(reason('echo a\\')).toBe('a trailing backslash')
  })
})

describe('what the person reads is what runs', () => {
  it('refuses invisible, control, separator and bidi characters outside ASCII, quoted or not', () => {
    for (const c of ['​', '‌', '‍', '⁠', '﻿', '­', '‮', '⁦', '\u0085', '\u009b', ' ', ' ',
      ' ', '　', ' ', '', '\ud800']) {
      expect(reason(`ls${c}`), JSON.stringify(c)).toBe('an invisible or look-alike character')
      expect(reason(`echo '${c}'`), JSON.stringify(c)).toBe('an invisible or look-alike character')
    }
  })

  it('refuses a look-alike of shell syntax: a fullwidth ； ｜ ＆ ＄ ＞, a Greek question mark, a small semicolon', () => {
    for (const c of ['；', '｜', '＆', '＄', '＞', '＜', ';', '﹔', '（', '＃', '＂', '＼', '＝']) {
      expect(reason(`echo a${c}b`), JSON.stringify(c)).toBe('an invisible or look-alike character')
    }
  })

  it('reads ordinary text outside ASCII as letters', () => {
    expect(words(`echo café ✓ 日本 "naïve" 'ü' …`)).toEqual([['echo', 'café', '✓', '日本', 'naïve', 'ü', '…']])
  })
})
