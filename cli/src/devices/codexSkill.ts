/**
 * `harness device codex status|enable|disable`: the dial skill in the Codex home the person's Codex reads
 * (`$CODEX_HOME/skills/dial/SKILL.md`, checked against Codex 0.167.1), so a Codex session knows it can ring the dial.
 * Harness writes and removes only its own file: a skill named dial the person made, or edited, stays theirs. This runs
 * only in the `harness` command's own process.
 */
import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const DIAL_SKILL_DESCRIPTION = 'The person has a Harness dial on their desk. Use it when you need them to do something you cannot: give information, act outside your reach (connect a VPN, sign in, plug in a device), or decide.'

/** The description is quoted: its `: ` ends a plain YAML scalar, and Codex would skip the skill without a word. */
export const DIAL_SKILL = `---
name: dial
description: ${JSON.stringify(DIAL_SKILL_DESCRIPTION)}
---

When you need the person to act, ring their dial:

    harness device notify "<what you need, in one line>"

- Never for progress, and never for "done": only when the person must act.
- At most once for the same need.
- Never put a secret, a token or a file's content in the line: anyone near the desk can read it.
- Still write the full ask in your answer. The command prints \`shown\`, \`no dial\` or \`limited\`: whichever it prints, your answer carries the ask.
`

const SKILL_BYTES = Buffer.from(DIAL_SKILL)

export interface CodexSkillDeps {
  /** The Codex home: Harness's own setting, `env.CODEX_HOME`. */
  home: string
  installed: boolean
  platform: NodeJS.Platform
}

export interface CodexStatus {
  supported: boolean
  installed: boolean
  enabled: boolean
}

export type CodexResult = { ok: true } | { ok: false; error: string }

const UNSUPPORTED = 'The dial reaches Codex on macOS and Linux.'
const NOT_INSTALLED = 'Codex is not on this computer.'
const NOT_OURS = 'Codex already has a skill named dial that Harness did not write.'
const WRITE_FAILED = 'Could not write the Codex skill.'
const REMOVE_FAILED = 'Could not remove the Codex skill.'

export function codexSkillPath(home: string): string {
  return join(home, 'skills', 'dial', 'SKILL.md')
}

export function codexStatus(deps: CodexSkillDeps): CodexStatus {
  return { supported: supported(deps.platform), installed: deps.installed, enabled: held(codexSkillPath(deps.home)) === 'ours' }
}

export function codexEnable(deps: CodexSkillDeps): CodexResult {
  if (!supported(deps.platform)) return { ok: false, error: UNSUPPORTED }
  if (!deps.installed) return { ok: false, error: NOT_INSTALLED }
  const path = codexSkillPath(deps.home)
  const now = held(path)
  if (now === 'ours') return { ok: true }
  if (now === 'other') return { ok: false, error: NOT_OURS }
  return written(path) ? { ok: true } : { ok: false, error: WRITE_FAILED }
}

export function codexDisable(deps: Pick<CodexSkillDeps, 'home'>): CodexResult {
  const path = codexSkillPath(deps.home)
  if (held(path) !== 'ours') return { ok: true }
  try {
    unlinkSync(path)
  } catch {
    return { ok: false, error: REMOVE_FAILED }
  }
  try {
    // Only an empty folder goes; `skills` is the person's Codex folder and stays.
    rmdirSync(dirname(path))
  } catch {
    // A file of the person's beside the skill: the folder is theirs now.
  }
  return { ok: true }
}

function supported(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'linux'
}

/** Harness's own skill is a regular file of exactly DIAL_SKILL, never a link to one; anything else there is the person's. */
function held(path: string): 'ours' | 'none' | 'other' {
  let fd: number
  try {
    // No link followed, and no wait on a FIFO left at the path.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'none' : 'other'
  }
  try {
    const stat = fstatSync(fd)
    // Sized by the skill: a longer file is not ours, and is never read whole.
    if (!stat.isFile() || stat.size !== SKILL_BYTES.length) return 'other'
    const text = Buffer.alloc(SKILL_BYTES.length)
    return readSync(fd, text, 0, text.length, 0) === text.length && text.equals(SKILL_BYTES) ? 'ours' : 'other'
  } finally {
    closeSync(fd)
  }
}

/** A temp file renamed into place: Codex, or a crash, never sees half a skill, which would read as the person's. */
function written(path: string): boolean {
  const folder = dirname(path)
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
  } catch {
    return false
  }
  const temporary = join(folder, `.SKILL.md.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, DIAL_SKILL, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
    return true
  } catch {
    rmSync(temporary, { force: true })
    return false
  }
}
