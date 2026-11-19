/**
 * Ported from txcript (https://github.com/skillsynchq/txcript), Apache-2.0: the session paths of `ClaudeStore::save`
 * (src/harness/claude_code.rs) and `CodexStore::save` (src/harness/codex.rs).
 *
 * One conversation moved between Claude Code and Codex: the source engine's file read into the canonical
 * conversation (canonical.ts) and written as a new session of the other engine, where that engine resumes it
 * (`claude --resume <id>`, `codex resume <id>`). The source file is only read: removing it is the person's
 * later choice, through the delete that already exists.
 */
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readClaudeTranscript, writeClaudeTranscript } from './claudeCode.js'
import { readCodexRollout, writeCodexRollout } from './codex.js'
import type { Meta, Transcript } from './canonical.js'

export type MigrateEngine = 'claude' | 'codex'
export const MIGRATE_ENGINES: readonly MigrateEngine[] = ['claude', 'codex']

/** Why a conversation could not be converted; never carries any of its text. */
export class ConvertError extends Error {
  constructor(readonly reason: 'EMPTY' | 'NO_FOLDER') {
    super(`conversion failed: ${reason}`)
    this.name = 'ConvertError'
  }
}

export const readSession = (engine: MigrateEngine, text: string): Transcript =>
  engine === 'claude' ? readClaudeTranscript(text) : readCodexRollout(text)

export const writeSession = (engine: MigrateEngine, transcript: Transcript): string =>
  engine === 'claude' ? writeClaudeTranscript(transcript) : writeCodexRollout(transcript)

/**
 * `text`, `from`'s transcript, as a new session `sessionId` of the other engine in `cwd`, started at `now`. The
 * CLI version is left out: it names the source engine's build, which the target would read as its own.
 */
export function convertSession(from: MigrateEngine, text: string, to: { sessionId: string; cwd: string; now: number }): { meta: Meta; text: string } {
  const source = readSession(from, text)
  if (!source.messages.length) throw new ConvertError('EMPTY')
  const { cliVersion: _version, ...kept } = source.meta
  const meta: Meta = { ...kept, id: to.sessionId, cwd: to.cwd, timestamp: to.now }
  return { meta, text: writeSession(from === 'claude' ? 'codex' : 'claude', { meta, messages: source.messages }) }
}

/**
 * Claude Code's folder for `cwd` below its `projects`: every character but a letter or a digit becomes `-`
 * (`/Users/dudu/Bitcoin_builder/Grid` is `-Users-dudu-Bitcoin-builder-Grid` on a real machine). txcript maps
 * only `/ . \ :`, which puts a folder with `_` or a space where `claude --resume` never looks. Past 200 characters
 * Claude Code shortens the name and adds a hash of its own, so such a folder is used only when Claude Code made it.
 */
export function claudeProjectFolder(projectsDir: string, cwd: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (encoded.length <= 200) return join(projectsDir, encoded)
  const prefix = `${encoded.slice(0, 200)}-`
  let names: string[] = []
  try { names = readdirSync(projectsDir).filter(name => name.startsWith(prefix)) } catch { /* no projects yet */ }
  if (names.length !== 1) throw new ConvertError('NO_FOLDER')
  return join(projectsDir, names[0]!)
}

/** Where Claude Code resumes session `sessionId` started in `cwd`. */
export const claudeSessionPath = (projectsDir: string, cwd: string, sessionId: string): string =>
  join(claudeProjectFolder(projectsDir, cwd), `${sessionId}.jsonl`)

/** Where Codex writes a session it starts at `at`: `sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl`, in
 *  local time as Codex names its own. */
export function codexRolloutPath(codexHome: string, at: number, sessionId: string): string {
  const d = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')
  const day = [String(d.getFullYear()), two(d.getMonth() + 1), two(d.getDate())]
  const stamp = `${day.join('-')}T${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`
  return join(codexHome, 'sessions', ...day, `rollout-${stamp}-${sessionId}.jsonl`)
}

/**
 * Writes `text` as a new file at `path`, readable by its owner alone, never over one that exists: a temporary file
 * beside it (`wx`, 0600) is synced and then hard-linked into place, which fails rather than replaces, so the engine
 * never sees half a session and nothing of the person's is overwritten.
 */
export function writeNewSessionFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    try {
      const bytes = Buffer.from(text, 'utf8')
      for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at)
      fsyncSync(fd)
    } finally { closeSync(fd) }
    linkSync(temporary, path)
  } finally { unlinkSync(temporary) }
}
