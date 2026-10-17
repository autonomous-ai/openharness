import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RC_MARKER, SH_PATH_LINE, fishPathLine, rcFiles, removeHarnessPathLines, withoutHarnessPathLines } from './rcFiles.js'

const installed = (before: string) => `${before}\n${RC_MARKER}\n${SH_PATH_LINE}\n`

describe('withoutHarnessPathLines', () => {
  it('takes out the marker, the line under it and the blank line the installer put before them', () => {
    const edit = withoutHarnessPathLines(installed('alias ll="ls -l"\n'), SH_PATH_LINE)
    expect(edit).toEqual({ text: 'alias ll="ls -l"\n', removed: 1, changedByPerson: 0 })
  })

  it('leaves an empty file empty when the installer made it', () => {
    expect(withoutHarnessPathLines(installed(''), SH_PATH_LINE)).toEqual({ text: '', removed: 1, changedByPerson: 0 })
  })

  it('keeps a marker whose next line the person changed, and every other line', () => {
    const text = `export A=1\n\n${RC_MARKER}\nexport PATH="$HOME/.local/bin:/opt/x:$PATH"\nexport B=2\n`
    expect(withoutHarnessPathLines(text, SH_PATH_LINE)).toEqual({ text, removed: 0, changedByPerson: 1 })
  })

  it('takes out every pair, and nothing between them', () => {
    const text = `${installed('a\n')}b\n\n${RC_MARKER}\n${SH_PATH_LINE}\n`
    expect(withoutHarnessPathLines(text, SH_PATH_LINE)).toEqual({ text: 'a\nb\n', removed: 2, changedByPerson: 0 })
  })

  it('reads the fish line with the home the installer expanded', () => {
    const text = `set -x A 1\n\n${RC_MARKER}\nfish_add_path /Users/u/.local/bin\n`
    expect(withoutHarnessPathLines(text, fishPathLine('/Users/u')).text).toBe('set -x A 1\n')
  })

  it('keeps a user line that only looks like the marker or the PATH line', () => {
    const text = `${RC_MARKER} (mine)\n${SH_PATH_LINE}\n  ${RC_MARKER}\n${SH_PATH_LINE} # x\n# ${SH_PATH_LINE}\n${SH_PATH_LINE}\n`
    expect(withoutHarnessPathLines(text, SH_PATH_LINE)).toEqual({ text, removed: 0, changedByPerson: 0 })
  })

  it('leaves a PATH line without the marker above it alone', () => {
    const text = `a\n${SH_PATH_LINE}\n`
    expect(withoutHarnessPathLines(text, SH_PATH_LINE)).toEqual({ text, removed: 0, changedByPerson: 0 })
  })

  it('keeps a marker at the end of the file with nothing under it', () => {
    const text = `a\n${RC_MARKER}\n`
    expect(withoutHarnessPathLines(text, SH_PATH_LINE)).toEqual({ text, removed: 0, changedByPerson: 1 })
  })

  it('keeps the person\'s CRLF lines byte for byte around the installer\'s LF block', () => {
    const text = `a\r\nb\r\n\n${RC_MARKER}\n${SH_PATH_LINE}\nc\r\n`
    expect(withoutHarnessPathLines(text, SH_PATH_LINE).text).toBe('a\r\nb\r\nc\r\n')
  })

  it('does not match a marker whose line a CRLF editor re-ended', () => {
    const text = `a\r\n${RC_MARKER}\r\n${SH_PATH_LINE}\r\n`
    expect(withoutHarnessPathLines(text, SH_PATH_LINE)).toEqual({ text, removed: 0, changedByPerson: 0 })
  })

  it('keeps a missing trailing newline after the block', () => {
    const text = `${installed('a\n')}tail`
    expect(withoutHarnessPathLines(text, SH_PATH_LINE).text).toBe('a\ntail')
  })

  it('keeps a missing trailing newline when the block ends the file', () => {
    expect(withoutHarnessPathLines(`a\n\n${RC_MARKER}\n${SH_PATH_LINE}`, SH_PATH_LINE).text).toBe('a\n')
  })

  it('keeps blank lines the person has around the block, beyond the installer\'s one', () => {
    const text = `a\n\n\n${RC_MARKER}\n${SH_PATH_LINE}\n\nb\n`
    expect(withoutHarnessPathLines(text, SH_PATH_LINE).text).toBe('a\n\n\nb\n')
  })
})

describe('install.sh', () => {
  it('writes the lines this module removes', () => {
    const script = readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'install.sh'), 'utf8')
    expect(script).toContain(`marker='${RC_MARKER}'`)
    expect(script).toContain(`add_path_line='${SH_PATH_LINE}'`)
    expect(script).toContain(`printf '\\n%s\\n%s\\n' "$marker" "$add_path_line"`)
    expect(script).toContain(`printf '\\n%s\\nfish_add_path %s\\n' "$marker" "$HOME/.local/bin"`)
  })
})

describe('removeHarnessPathLines', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('edits every startup file the installer wrote to, through a link without replacing it', () => {
    const home = mkdtempSync(join(tmpdir(), 'rc-files-'))
    dirs.push(home)
    writeFileSync(join(home, '.zshrc'), installed('alias ll="ls -l"\n'), { mode: 0o640 })
    mkdirSync(join(home, 'dotfiles'))
    writeFileSync(join(home, 'dotfiles', 'bashrc'), installed('export A=1\n'))
    symlinkSync(join(home, 'dotfiles', 'bashrc'), join(home, '.bashrc'))
    mkdirSync(join(home, '.config', 'fish'), { recursive: true })
    writeFileSync(join(home, '.config', 'fish', 'config.fish'), `\n${RC_MARKER}\n${fishPathLine(home)}\n`)
    writeFileSync(join(home, '.profile'), 'export UNTOUCHED=1\n')

    const outcomes = removeHarnessPathLines(home)

    expect(outcomes.map((o) => [o.file, o.removed])).toEqual([
      [join(home, '.zshrc'), 1], [join(home, '.bashrc'), 1], [join(home, '.config', 'fish', 'config.fish'), 1],
    ])
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('alias ll="ls -l"\n')
    expect(lstatSync(join(home, '.zshrc')).mode & 0o777).toBe(0o640)
    expect(readlinkSync(join(home, '.bashrc'))).toBe(join(home, 'dotfiles', 'bashrc'))
    expect(readFileSync(join(home, 'dotfiles', 'bashrc'), 'utf8')).toBe('export A=1\n')
    expect(readFileSync(join(home, '.config', 'fish', 'config.fish'), 'utf8')).toBe('')
    expect(readFileSync(join(home, '.profile'), 'utf8')).toBe('export UNTOUCHED=1\n')
  })

  it('names every file it looks at', () => {
    expect(rcFiles('/h').map((f) => f.file)).toEqual([
      '/h/.zshrc', '/h/.bashrc', '/h/.bash_profile', '/h/.bash_login', '/h/.profile', '/h/.config/fish/config.fish',
    ])
  })
})
