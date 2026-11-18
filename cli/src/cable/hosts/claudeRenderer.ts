/**
 * Whether Claude Code draws a session fullscreen (`"tui": "fullscreen"`), as far as its settings files say. Only then
 * does the dial's scroll press its page keys in a VS Code terminal: VS Code pulls its view to the bottom after each
 * write, so under the default renderer a key would undo the scroll (Decided 7 of
 * docs/plans/2026-11-18-dial-vscode-claude-fullscreen-scroll-design.md). A doubt is therefore "no", the line scroll.
 *
 * What is read: the `tui` key alone, and nothing else of a file is kept or logged, since a settings file holds a
 * person's permissions, hooks and environment. The files are Claude Code's own, in its own precedence less its command
 * line, which the devices never read: managed, the project's local file, the project's, then the user's. The
 * project's files come from whatever folder the person opened, so each is opened without waiting for a writer, read
 * only when it is a regular file, and no further than one byte past its cap.
 *
 * The user file is `settings.json` in the session's own Claude Code home, which its transcript path names
 * (`<home>/projects/<slug>/<id>.jsonl`): a session started with its own CLAUDE_CONFIG_DIR, such as an Orca account's,
 * is judged by its own file, and the devices never read another process's environment to learn that home.
 *
 * Limit: fullscreen turned on by the environment (CLAUDE_CODE_NO_FLICKER=1) is not seen, for the same reason. Such a
 * session scrolls line by line, as before.
 */
import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, normalize } from 'node:path'

/** A settings file is about 1–10 KiB; a larger file is not read. */
export const SETTINGS_MAX_BYTES = 256 * 1024

/** Claude Code's managed settings, by platform: the highest of its files. None elsewhere. */
export const MANAGED_SETTINGS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
}

export interface RendererOptions {
  /** The devices' default Claude Code home, dirname(CLAUDE_PROJECTS_DIR): the user file's home for a session whose
   *  transcript path names none. */
  defaultHome: string
  platform: NodeJS.Platform
}

/** `<home>` of a transcript path `<home>/projects/<slug>/<id>.jsonl`, from its shape alone. A path spelled any other
 *  way (relative, `..`, a doubled `/`) names none, so it never points the read at a folder it does not plainly name. */
function homeOf(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath || !isAbsolute(transcriptPath) || normalize(transcriptPath) !== transcriptPath) return undefined
  if (extname(transcriptPath) !== '.jsonl') return undefined
  const projects = dirname(dirname(transcriptPath))
  return basename(projects) === 'projects' ? dirname(projects) : undefined
}

/** The four files, highest precedence first: managed (where the platform has one), project local, project, user.
 *  `cwd` is absolute. The user file is `settings.json` in the session's own Claude Code home, `<home>` of its
 *  `transcriptPath` `<home>/projects/<slug>/<id>.jsonl`; in `opts.defaultHome` when there is none or it has another
 *  shape. From the path alone: no environment is read. */
export function settingsFiles(cwd: string, transcriptPath: string | undefined, opts: RendererOptions): string[] {
  const managed = MANAGED_SETTINGS[opts.platform]
  return [
    ...(managed ? [managed] : []),
    join(cwd, '.claude', 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'),
    join(homeOf(transcriptPath) ?? opts.defaultHome, 'settings.json'),
  ]
}

/** One file's text: none when it is missing, not a regular file, over SETTINGS_MAX_BYTES or unreadable. Never rejects. */
export async function readSettings(path: string): Promise<string | undefined> {
  let file: FileHandle | undefined
  try {
    // Non-blocking: a FIFO in a cloned project's .claude must not hold a thread waiting for a writer.
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    // A folder, a FIFO or a device such as /dev/zero is no settings file.
    if (!(await file.stat()).isFile()) return undefined
    // One byte past the cap tells a larger file from one exactly at it.
    const buffer = Buffer.alloc(SETTINGS_MAX_BYTES + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    return bytesRead > SETTINGS_MAX_BYTES ? undefined : buffer.toString('utf8', 0, bytesRead)
  } catch {
    return undefined
  } finally {
    await file?.close().catch(() => {})
  }
}

/** What a file's text says: true or false when it is a JSON object with a `tui` of its own, which passes only as
 *  "fullscreen"; undefined when it gives way to the next file. */
function decides(text: string | undefined): boolean | undefined {
  if (text === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  // Its own key only: `{"__proto__":{"tui":…}}` sets none.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed, 'tui')) return undefined
  return (parsed as { tui: unknown }).tui === 'fullscreen'
}

/** Whether Claude Code draws the session in `cwd` with that transcript fullscreen, as far as its settings say: the first
 *  of settingsFiles whose JSON object has its own `tui` decides, and only `"fullscreen"` passes. Reads `tui` alone;
 *  keeps and logs nothing. Never rejects. */
export async function readFullscreen(
  cwd: string, transcriptPath: string | undefined, opts: RendererOptions, read = readSettings,
): Promise<boolean> {
  // One at a time: the file that decides spares reading the ones below it.
  for (const path of settingsFiles(cwd, transcriptPath, opts)) {
    let text: string | undefined
    try {
      text = await read(path)
    } catch {
      text = undefined
    }
    const fullscreen = decides(text)
    if (fullscreen !== undefined) return fullscreen
  }
  return false
}
