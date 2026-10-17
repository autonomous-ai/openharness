/**
 * The PATH lines cli/scripts/install.sh adds to a shell's startup files (`ensure_rc`, `ensure_path_rc`), found by the
 * marker comment it writes above them, and taken out again by `harness uninstall`.
 *
 * Only the installer's exact pair goes: the marker and, on the next line, the line it wrote. A marker whose next line
 * the person changed is theirs now, and stays, as does every other line of the file.
 */
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** install.sh `marker`. */
export const RC_MARKER = '# added by harness installer'
/** install.sh `add_path_line`, for the sh family. */
export const SH_PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"'
/** install.sh's fish line, with the home it expanded when it wrote it. */
export function fishPathLine(home: string): string {
  return `fish_add_path ${home}/.local/bin`
}

export interface RcFile { file: string; line: string }

/** Every startup file install.sh may have written to, whichever shell the person uses now. */
export function rcFiles(home: string): RcFile[] {
  return [
    ...['.zshrc', '.bashrc', '.bash_profile', '.bash_login', '.profile'].map((name) => ({ file: join(home, name), line: SH_PATH_LINE })),
    { file: join(home, '.config', 'fish', 'config.fish'), line: fishPathLine(home) },
  ]
}

export interface RcEdit { text: string; removed: number; changedByPerson: number }

/** [text] without the installer's pairs, and the blank line it printed before each one. */
export function withoutHarnessPathLines(text: string, line: string): RcEdit {
  const lines = text.split('\n')
  const out: string[] = []
  let removed = 0
  let changedByPerson = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== RC_MARKER) { out.push(lines[i]); continue }
    if (lines[i + 1] !== line) { changedByPerson++; out.push(lines[i]); continue }
    // `printf '\n%s\n%s\n'`: the blank line before the marker is the installer's too.
    const blank = out.length > 0 && out[out.length - 1] === ''
    if (blank) out.pop()
    removed++
    i++
    // The pair ended the file without a newline: the line before it keeps the one the blank line was.
    if (blank && i + 1 >= lines.length) out.push('')
  }
  return { text: out.join('\n'), removed, changedByPerson }
}

export interface RcOutcome { file: string; removed: number; changedByPerson: number; failed?: string }

/**
 * Take the installer's lines out of each startup file in [home]. A file that is a link is written through the link:
 * the installer's `>>` followed it, and a rename would replace somebody's dotfiles link with a copy.
 */
export function removeHarnessPathLines(home: string): RcOutcome[] {
  const outcomes: RcOutcome[] = []
  for (const { file, line } of rcFiles(home)) {
    let text: string
    let link: boolean
    let mode: number
    try {
      const info = lstatSync(file)
      link = info.isSymbolicLink()
      mode = info.mode & 0o777
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const edit = withoutHarnessPathLines(text, line)
    if (edit.removed === 0) {
      if (edit.changedByPerson) outcomes.push({ file, removed: 0, changedByPerson: edit.changedByPerson })
      continue
    }
    try {
      if (link) writeFileSync(file, edit.text)
      else {
        const temporary = `${file}.harness-uninstall-${process.pid}`
        writeFileSync(temporary, edit.text, { mode })
        renameSync(temporary, file)
      }
      outcomes.push({ file, removed: edit.removed, changedByPerson: edit.changedByPerson })
    } catch (error) {
      outcomes.push({ file, removed: 0, changedByPerson: edit.changedByPerson, failed: error instanceof Error ? error.message : String(error) })
    }
  }
  return outcomes
}
