/**
 * The dial skill in one agent home's `skills/dial/SKILL.md`, the same for Claude Code and Codex (both read
 * `<home>/skills/<name>/SKILL.md`), so a session knows it can ring the dial. Harness writes and removes only its own
 * file, known by its marker line: anything else at that path is the person's. The `harness device` command and the
 * devices service both import it, so it loads nothing but Node's own modules.
 */
import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DIAL_SKILL_DESCRIPTION = 'The person has a Harness dial on their desk. Use it when you need them to do something you cannot: give information, act outside your reach (connect a VPN, sign in, plug in a device), or decide.'

/** A YAML comment: both engines' front-matter parsers skip it, and Harness knows its own file by it, whatever the
 *  text around it, so a later release's text still reads as Harness's and is written over. */
const DIAL_SKILL_MARKER = '# Written by Harness. Turn off the agent in Harness Device to remove it.'

/** The description is quoted: its `: ` ends a plain YAML scalar, and the engine would skip the skill without a word. */
export const DIAL_SKILL = `---
name: dial
description: ${JSON.stringify(DIAL_SKILL_DESCRIPTION)}
${DIAL_SKILL_MARKER}
---

When you need the person to act, ring their dial:

    harness device notify "<what you need, in one line>"

- Never for progress, and never for "done": only when the person must act.
- At most once for the same need.
- Never put a secret, a token or a file's content in the line: anyone near the desk can read it.
- Still write the full ask in your answer. The command prints \`shown\`, \`no dial\` or \`limited\`: whichever it prints, your answer carries the ask.
`

export const DIAL_PLUGIN_ID = 'harness-device@openharness'

const SKILL_BYTES = Buffer.from(DIAL_SKILL)
/** Harness's skill is well under this; a longer file is the person's and is never read whole. */
const MAX_SKILL_BYTES = 4096
/** A settings.json is a few keys; one past this is not read whole. */
const MAX_SETTINGS_BYTES = 1024 * 1024

/** A platform with no uid owns nothing, so nothing is written there. */
function ownUid(): number {
  return process.getuid?.() ?? -1
}

/** 'ok', or why a path is no folder of this user's: 'unreadable' when it cannot be looked at now (a folder above it
 *  shut), which says nothing of it being gone, so a listed folder stays listed. */
export function ownDirectory(path: string, uid = ownUid()): 'ok' | 'missing' | 'owner' | 'unreadable' {
  let info
  try {
    info = statSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable'
  }
  if (!info.isDirectory()) return 'missing'
  return info.uid === uid ? 'ok' : 'owner'
}

/**
 * `<home>/skills` through its link: an Orca profile's `skills/` points at `~/.claude/skills`, and homes that share one
 * folder are one write. null: not a directory this user owns, or missing and not made.
 */
export function skillsFolderOf(home: string, make: boolean, uid = ownUid()): string | null {
  const skills = join(home, 'skills')
  let real: string
  try {
    real = realpathSync(skills)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !make) return null
    try {
      // A dangling link is the person's: mkdir fails on it, and nothing is made at its target.
      mkdirSync(skills, { recursive: true, mode: 0o700 })
      real = realpathSync(skills)
    } catch {
      return null
    }
  }
  return ownDirectory(real, uid) === 'ok' ? real : null
}

/** A temp file, on disk before it is renamed into place: an engine, or a crash, never sees half a skill, which would read
 *  as the person's. */
export function writeSkill(skills: string): 'written' | 'same' | 'theirs' | 'failed' {
  const now = held(skills)
  if (now === 'same' || now === 'theirs') return now
  const folder = join(skills, 'dial')
  let made = false
  try {
    // Not recursive: `skills` is the resolved folder, and a `dial` already there was checked to be a real folder.
    mkdirSync(folder, { mode: 0o700 })
    made = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return 'failed'
  }
  const temporary = join(folder, `.SKILL.md.${process.pid}.${randomUUID()}.tmp`)
  try {
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(fd, DIAL_SKILL)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, join(folder, 'SKILL.md'))
    return 'written'
  } catch {
    rmSync(temporary, { force: true })
    // Left empty, the folder this call made would be nobody's.
    if (made) removeEmpty(folder)
    return 'failed'
  }
}

export function removeSkill(skills: string): 'removed' | 'none' | 'theirs' | 'failed' {
  const now = held(skills)
  if (now === 'none' || now === 'theirs') return now
  const folder = join(skills, 'dial')
  try {
    unlinkSync(join(folder, 'SKILL.md'))
  } catch (error) {
    // Another remover took it first: the command and the devices service both remove at a Turn off.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : 'failed'
  }
  // `skills` is the person's agent folder and stays.
  removeEmpty(folder)
  return 'removed'
}

/** Only an empty folder goes: a file of the person's beside the skill makes the folder theirs. */
function removeEmpty(folder: string): void {
  try {
    rmdirSync(folder)
  } catch {
    // Not empty, or already gone.
  }
}

/**
 * Claude Code's own record of the plugin, in its user settings: 'on' while its entry is true, 'off' once disabled or
 * uninstalled (the entry false or gone), 'unknown' when the file says nothing: missing, not a regular file, past 1 MiB,
 * not JSON or not an object. One read, sized by the file: the plugin's hook and mod read it on every call.
 */
export function claudePluginState(settingsPath: string): 'on' | 'off' | 'unknown' {
  let settings: unknown
  try {
    // No wait on a FIFO left at the path.
    const fd = openSync(settingsPath, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || info.size > MAX_SETTINGS_BYTES) return 'unknown'
      const buffer = Buffer.allocUnsafe(info.size)
      const length = readSync(fd, buffer, 0, info.size, 0)
      settings = JSON.parse(buffer.toString('utf8', 0, length))
    } finally {
      closeSync(fd)
    }
  } catch {
    return 'unknown'
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'unknown'
  const plugins = (settings as { enabledPlugins?: unknown }).enabledPlugins
  return !!plugins && typeof plugins === 'object' && (plugins as Record<string, unknown>)[DIAL_PLUGIN_ID] === true ? 'on' : 'off'
}

/**
 * Whether an engine's homes get the dial skill: Codex by its answer in dial-skill.json alone; Claude Code when that
 * answer is not Off and its own record says the plugin is on, so a plugin turned on before that file existed brings the
 * skill, and one uninstalled through /plugin takes it away.
 */
export function skillOn(engine: 'claude' | 'codex', answer: boolean | undefined, claudeSettings: string): boolean {
  return engine === 'codex' ? answer === true : answer !== false && claudePluginState(claudeSettings) === 'on'
}

/**
 * Harness's own skill is a regular file, never a link to one, of at most 4 KiB whose front matter holds the marker line;
 * 'same' is that file holding exactly DIAL_SKILL. A `dial` that is a link or not a folder is the person's: nothing is
 * read or written through it.
 */
function held(skills: string): 'same' | 'ours' | 'none' | 'theirs' {
  const folder = join(skills, 'dial')
  try {
    if (!lstatSync(folder).isDirectory()) return 'theirs'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'none' : 'theirs'
  }
  let fd: number
  try {
    // No link followed, and no wait on a FIFO left at the path.
    fd = openSync(join(folder, 'SKILL.md'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : 'theirs'
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > MAX_SKILL_BYTES) return 'theirs'
    const bytes = Buffer.alloc(info.size)
    const length = readSync(fd, bytes, 0, bytes.length, 0)
    const text = bytes.subarray(0, length)
    if (!marked(text.toString('utf8'))) return 'theirs'
    return text.equals(SKILL_BYTES) ? 'same' : 'ours'
  } catch {
    return 'theirs'
  } finally {
    closeSync(fd)
  }
}

/** The first line is `---`, and a line before the next `---` is the marker. Lines end with `\n`: a CRLF copy is the
 *  person's. */
function marked(text: string): boolean {
  const lines = text.split('\n')
  const end = lines.indexOf('---', 1)
  return lines[0] === '---' && end > 0 && lines.slice(1, end).includes(DIAL_SKILL_MARKER)
}
