import { chmodSync, existsSync, lstatSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RC_MARKER, SH_PATH_LINE, filesWithHarnessPathLines, fishPathLine, rcFiles, removeHarnessPathLines, withoutHarnessPathLines } from './rcFiles.js'

const fsState = vi.hoisted(() => ({ failRename: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    if (fsState.failRename) { fsState.failRename = false; throw new Error('rename refused') }
    return actual.renameSync(...args)
  } }
})

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

  it('names the files that hold the installer\'s pair, and changes none of them', () => {
    const home = mkdtempSync(join(tmpdir(), 'rc-files-'))
    dirs.push(home)
    const zshrc = installed('alias ll="ls -l"\n')
    writeFileSync(join(home, '.zshrc'), zshrc)
    // A marker whose line the person changed is not Harness's PATH line.
    writeFileSync(join(home, '.bashrc'), `${RC_MARKER}\nexport PATH="/opt/x:$PATH"\n`)
    writeFileSync(join(home, '.profile'), 'export UNTOUCHED=1\n')
    expect(filesWithHarnessPathLines(home)).toEqual([join(home, '.zshrc')])
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe(zshrc)
    rmSync(join(home, '.zshrc'))
    expect(filesWithHarnessPathLines(home)).toEqual([])
  })

  // POSIX-only: file modes (chmod/0o640) and /h/... paths do not exist on Windows; the rc files are a mac/Linux feature.
  it.skipIf(process.platform === 'win32')('edits every startup file the installer wrote to, through a link without replacing it', () => {
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

  const home = () => { const dir = mkdtempSync(join(tmpdir(), 'rc-files-')); dirs.push(dir); return dir }
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0

  it.skipIf(asRoot || process.platform === 'win32')('reports a file it cannot read and goes on to the next', () => {
    const h = home()
    writeFileSync(join(h, '.zshrc'), installed('a\n'), { mode: 0o000 })
    writeFileSync(join(h, '.bashrc'), installed('b\n'))
    const outcomes = removeHarnessPathLines(h)
    expect(outcomes[0]).toMatchObject({ file: join(h, '.zshrc'), removed: 0, changedByPerson: 0 })
    expect(outcomes[0].failed).toBeTruthy()
    expect(outcomes[1]).toMatchObject({ file: join(h, '.bashrc'), removed: 1 })
    chmodSync(join(h, '.zshrc'), 0o600)
    expect(readFileSync(join(h, '.zshrc'), 'utf8')).toBe(installed('a\n'))
  })

  it('keeps every other byte of a file that is not valid UTF-8', () => {
    const h = home()
    const before = Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9, 0xff]), Buffer.from(`\n\n${RC_MARKER}\n${SH_PATH_LINE}\nexport X=1\n`)])
    writeFileSync(join(h, '.zshrc'), before)
    expect(removeHarnessPathLines(h)[0]).toMatchObject({ removed: 1 })
    expect(readFileSync(join(h, '.zshrc'))).toEqual(Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9, 0xff]), Buffer.from('\nexport X=1\n')]))
  })

  it('matches the fish line of a home with non-ASCII characters and keeps its other bytes', () => {
    const h = home()
    const unicode = join(h, 'Nguyễn')
    mkdirSync(join(unicode, '.config', 'fish'), { recursive: true })
    const file = join(unicode, '.config', 'fish', 'config.fish')
    writeFileSync(file, `set -x Ä 1\n\n${RC_MARKER}\n${fishPathLine(unicode)}\nset -x Ö 2\n`)
    expect(removeHarnessPathLines(unicode)[0]).toMatchObject({ removed: 1 })
    expect(readFileSync(file, 'utf8')).toBe('set -x Ä 1\nset -x Ö 2\n')
  })

  it('leaves no temporary file when the rename fails, and still handles the next file', () => {
    const h = home()
    writeFileSync(join(h, '.zshrc'), installed('a\n'))
    writeFileSync(join(h, '.bashrc'), installed('b\n'))
    fsState.failRename = true
    const outcomes = removeHarnessPathLines(h)
    expect(outcomes[0].failed).toContain('rename refused')
    expect(outcomes[1]).toMatchObject({ file: join(h, '.bashrc'), removed: 1 })
    expect(readFileSync(join(h, '.zshrc'), 'utf8')).toBe(installed('a\n'))
    expect(readdirSync(h).filter((n) => n.includes('harness-uninstall'))).toEqual([])
  })

  // POSIX-only: asserts file modes, which Windows does not keep.
  it.skipIf(process.platform === 'win32')('edits a link\'s target by rename, keeping the link and the target\'s mode', () => {
    const h = home()
    mkdirSync(join(h, 'dots'))
    writeFileSync(join(h, 'dots', 'zshrc'), installed('a\n'), { mode: 0o600 })
    chmodSync(join(h, 'dots', 'zshrc'), 0o600)
    symlinkSync(join(h, 'dots', 'zshrc'), join(h, '.zshrc'))
    expect(removeHarnessPathLines(h)[0]).toMatchObject({ removed: 1 })
    expect(lstatSync(join(h, '.zshrc')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(h, 'dots', 'zshrc'), 'utf8')).toBe('a\n')
    expect(lstatSync(join(h, 'dots', 'zshrc')).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(h, 'dots'))).toEqual(['zshrc'])
  })

  it('reports a dangling link instead of skipping it', () => {
    const h = home()
    symlinkSync(join(h, 'nowhere'), join(h, '.zshrc'))
    const outcomes = removeHarnessPathLines(h)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0].failed).toBeTruthy()
    expect(existsSync(join(h, 'nowhere'))).toBe(false)
  })

  it('handles a file with no trailing newline, and a fish line naming another home', () => {
    const h = home()
    writeFileSync(join(h, '.zshrc'), `a\n\n${RC_MARKER}\n${SH_PATH_LINE}`)
    mkdirSync(join(h, '.config', 'fish'), { recursive: true })
    const fish = `x\n\n${RC_MARKER}\n${fishPathLine('/Users/other')}\n`
    writeFileSync(join(h, '.config', 'fish', 'config.fish'), fish)
    const outcomes = removeHarnessPathLines(h)
    expect(outcomes.map((o) => [o.file, o.removed, o.changedByPerson])).toEqual([
      [join(h, '.zshrc'), 1, 0], [join(h, '.config', 'fish', 'config.fish'), 0, 1],
    ])
    expect(readFileSync(join(h, '.zshrc'), 'utf8')).toBe('a\n')
    expect(readFileSync(join(h, '.config', 'fish', 'config.fish'), 'utf8')).toBe(fish)
  })

  // POSIX-only: asserts /h/... paths; Windows joins with backslashes.
  it.skipIf(process.platform === 'win32')('names every file it looks at', () => {
    expect(rcFiles('/h').map((f) => f.file)).toEqual([
      '/h/.zshrc', '/h/.bashrc', '/h/.bash_profile', '/h/.bash_login', '/h/.profile', '/h/.config/fish/config.fish',
    ])
  })
})
