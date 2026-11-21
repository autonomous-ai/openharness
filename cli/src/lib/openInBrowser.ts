/** A link opened in the browser, never through a shell: cmd.exe ends a command at a URL's `&` and runs the rest, splits
 *  it at a space and expands its `%`, and a sign-in URL is full of `&`. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { ownProcessGroup } from './windows/noWindow.js'
import { systemProgram } from './windows/powershell.js'

/** Harness OS opens links in its own browser. */
const HARNESS_BROWSER = '/usr/bin/hn-browser'

/** What opens [url] on [platform], with no shell; null when [url] is not opened (not http(s), or holds whitespace or
 *  a quote). */
export function browserCommand(url: string, platform: NodeJS.Platform, harnessBrowser?: string | null): { file: string; args: string[] } | null {
  // url.dll is handed the rest of rundll32's command line as it stands, and Node quotes an argument holding whitespace
  // or a quote: such a URL would reach the browser quoted or cut, so it is not opened.
  if (!/^https?:\/\/[^\s"']+$/.test(url)) return null
  if (harnessBrowser) return { file: harnessBrowser, args: [url] }
  if (platform === 'win32') return { file: systemProgram('rundll32.exe'), args: ['url.dll,FileProtocolHandler', url] }
  return { file: platform === 'darwin' ? 'open' : 'xdg-open', args: [url] }
}

/** Best-effort: false when refused or not started; the caller prints the URL either way. */
export function openInBrowser(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const command = browserCommand(url, process.platform, [HARNESS_BROWSER].find(existsSync))
  if (!command) return false
  try {
    const child = spawn(command.file, command.args, { stdio: 'ignore', ...ownProcessGroup(), env })
    child.on('error', () => { /* No browser here (headless, ssh): the printed address is the way. */ })
    child.unref()
    return true
  } catch { return false }
}
