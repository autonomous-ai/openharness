/**
 * The PATH lines cli/scripts/install.sh adds to a shell's startup files (`ensure_rc`, `ensure_path_rc`), found by the
 * marker comment it writes above them, and taken out again by `harness uninstall`.
 *
 * Only the installer's exact pair goes: the marker and, on the next line, the line it wrote. A marker whose next line
 * the person changed is theirs now, and stays, as does every other line of the file.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/**
 * Matching is by exact line: a heredoc or comment holding the very marker line and PATH line is removed too. It cannot be
 * told apart from the installer's own pair, as with install.sh's grep.
 *
 * [text] without the installer's pairs, and the blank line it printed before each one. */
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

/**
 * The startup files in [home] that hold one of the installer's pairs, read and left as they are: whether there is a
 * PATH line of Harness's at all, before uninstall says it kept one (B5.9 review, M8). A file that cannot be read holds none.
 */
export function filesWithHarnessPathLines(home: string): string[] {
  return rcFiles(home).filter(({ file, line }) => {
    try {
      return withoutHarnessPathLines(readFileSync(file, 'latin1'), Buffer.from(line, 'utf8').toString('latin1')).removed > 0
    } catch {
      return false
    }
  }).map(({ file }) => file)
}

export interface RcOutcome { file: string; removed: number; changedByPerson: number; failed?: string }

/**
 * Take the installer's lines out of each startup file in [home].
 *
 * Files are read and written as latin1, so every byte outside the lines removed survives as it was, valid UTF-8 or not;
 * the lines looked for are converted the same way. A link is followed: the edit is written to a temporary file next to
 * the link's target and renamed onto the target, so the link stays a link and nothing is truncated. The mode is kept.
 * Ownership, ACLs and hardlinks of the file are not kept by the rename. A file that is not there is skipped; any other
 * problem (unreadable file, dangling link, failed write) is reported as `failed` and the next file is still handled.
 */
export function removeHarnessPathLines(home: string): RcOutcome[] {
  const outcomes: RcOutcome[] = []
  for (const { file, line } of rcFiles(home)) {
    let temporary: string | undefined
    let changedByPerson = 0
    try {
      try {
        lstatSync(file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      const target = realpathSync(file) // a dangling link throws here: reported, not skipped
      const mode = statSync(target).mode & 0o777
      const text = readFileSync(target, 'latin1')
      const edit = withoutHarnessPathLines(text, Buffer.from(line, 'utf8').toString('latin1'))
      changedByPerson = edit.changedByPerson
      if (edit.removed === 0) {
        if (changedByPerson) outcomes.push({ file, removed: 0, changedByPerson })
        continue
      }
      temporary = `${target}.harness-uninstall-${randomBytes(6).toString('hex')}`
      writeFileSync(temporary, edit.text, { encoding: 'latin1', flag: 'wx', mode })
      chmodSync(temporary, mode) // the umask masks the mode given above
      renameSync(temporary, target)
      outcomes.push({ file, removed: edit.removed, changedByPerson })
    } catch (error) {
      if (temporary) rmSync(temporary, { force: true })
      outcomes.push({ file, removed: 0, changedByPerson, failed: error instanceof Error ? error.message : String(error) })
    }
  }
  return outcomes
}
