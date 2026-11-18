/**
 * Whether Claude Code draws a session fullscreen (`"tui": "fullscreen"`), as far as its settings files say. Only then
 * does the dial's scroll press its page keys in a VS Code terminal: VS Code pulls its view to the bottom after each
 * write, so under the default renderer a key would undo the scroll (Decided 7 of
 * docs/plans/2026-11-18-dial-vscode-claude-fullscreen-scroll-design.md). A doubt is therefore "no", the line scroll.
 *
 * What is read: the `tui` key alone, and nothing else of a file is kept or logged, since a settings file holds a
 * person's permissions, hooks and environment. The files are Claude Code's own, in its own precedence less its command
 * line, which the devices never read: managed, the project's local file, the project's, then the user's. The
 * project's files come from whatever folder the person opened, so each is opened only when its path names a regular
 * file (a link to a serial port would toggle its DTR as it opens), then without waiting for a writer and never as a
 * controlling terminal, checked a regular file again, and read no further than one byte past its cap.
 *
 * The user file is `settings.json` in the session's own Claude Code home, which its transcript path names
 * (`<home>/projects/<slug>/<id>.jsonl`): a session started with its own CLAUDE_CONFIG_DIR, such as an Orca account's,
 * is judged by its own file, and the devices never read another process's environment to learn that home.
 *
 * Limit: fullscreen turned on by the environment (CLAUDE_CODE_NO_FLICKER=1) is not seen, for the same reason. Such a
 * session scrolls line by line, as before.
 */
import { constants } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
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
  /** The managed file, the platform's MANAGED_SETTINGS; none where the platform has none. */
  managed: string | undefined
}

/** `<home>` of a transcript path `<home>/projects/<slug>/<id>.jsonl`, from its shape alone. A path spelled any other
 *  way (relative, `..`, a doubled `/`) names none, so it never points the read at a folder it does not plainly name. */
function homeOf(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath || !isAbsolute(transcriptPath) || normalize(transcriptPath) !== transcriptPath) return undefined
  if (extname(transcriptPath) !== '.jsonl') return undefined
  const projects = dirname(dirname(transcriptPath))
  return basename(projects) === 'projects' ? dirname(projects) : undefined
}

/** The four files, highest precedence first: managed (where there is one), project local, project, user.
 *  `cwd` is absolute. The user file is `settings.json` in the session's own Claude Code home, `<home>` of its
 *  `transcriptPath` `<home>/projects/<slug>/<id>.jsonl`; in `opts.defaultHome` when there is none or it has another
 *  shape. From the path alone: no environment is read. */
export function settingsFiles(cwd: string, transcriptPath: string | undefined, opts: RendererOptions): string[] {
  return [
    ...(opts.managed ? [opts.managed] : []),
    join(cwd, '.claude', 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'),
    join(homeOf(transcriptPath) ?? opts.defaultHome, 'settings.json'),
  ]
}

/** The two calls readSettings makes of the file system. */
export interface SettingsFs {
  stat(path: string): Promise<{ isFile(): boolean }>
  open(path: string, flags: number): Promise<FileHandle>
}

/** One file's text: none when it is missing, not a regular file, over SETTINGS_MAX_BYTES or unreadable. Never rejects. */
export async function readSettings(path: string, fs: SettingsFs = { stat, open }): Promise<string | undefined> {
  let file: FileHandle | undefined
  try {
    // Before it is opened: opening a device has effects of its own, such as a serial port's DTR.
    if (!(await fs.stat(path)).isFile()) return undefined
    // Non-blocking: a FIFO in a cloned project's .claude must not hold a thread waiting for a writer. No controlling
    // terminal: a tty swapped in after the stat never becomes the devices'.
    file = await fs.open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY)
    // Again on what was opened: the path may name something else by now. A folder, a FIFO or a device such as
    // /dev/zero is no settings file.
    const opened = await file.stat()
    if (!opened.isFile()) return undefined
    // Its size, up to the cap, and one byte past it: a full buffer is a file over the cap, or one that grew meanwhile.
    const buffer = Buffer.alloc(Math.min(opened.size, SETTINGS_MAX_BYTES) + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    return bytesRead === buffer.length ? undefined : buffer.toString('utf8', 0, bytesRead)
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
