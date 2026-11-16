/**
 * A folder moved to the system's Trash, never deleted: the person can put it back. macOS through the Finder's own call
 * (NSFileManager `trashItemAtURL`, run by `osascript`, which needs no permission to control the Finder), Linux by the
 * freedesktop.org Trash specification in the home trash, Windows to the Recycle Bin (SHFileOperation, run by PowerShell).
 * A folder that cannot be moved there stays where it is: nothing here falls back to deleting it.
 */
import { execFile } from 'node:child_process'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { runPowershellAsync, type PowershellResult } from './windows/powershell.js'

/** Why a folder was not moved: a fixed code, since the system's own text names the folder. */
export class TrashError extends Error {
  constructor(readonly code: 'TRASH_FAILED' | 'TRASH_UNAVAILABLE' | 'TRASH_DECLINED') { super(code) }
}

/** Moves [path] to the Trash; rejects with a TrashError and leaves it in place otherwise. */
export type Trash = (path: string) => Promise<void>

/** How long one move may take: a rename on the same volume, or Windows copying a folder into the Recycle Bin. */
export const TRASH_TIMEOUT_MS = 120_000

/** The Finder's move to the Trash, keeping what Put Back needs; a failure leaves with its error on stderr and exit 1. */
const MAC_SCRIPT = [
  'function run(argv) {',
  '  ObjC.import("Foundation")',
  '  const error = $()',
  '  if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[0]), null, error)) {',
  '    throw new Error(ObjC.unwrap(error.localizedDescription))',
  '  }',
  '}',
].join('\n')

/**
 * The Recycle Bin, with no window: FO_DELETE with FOF_ALLOWUNDO, and no confirmation, progress or error UI. Windows deletes a
 * folder too big for the Recycle Bin outright when it is not asked first, so FOF_WANTNUKEWARNING asks the person in that one
 * case; a no is reported as declined, and the folder stays.
 */
const WINDOWS_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HarnessRecycleBin {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Operation {
    public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags;
    [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHFileOperation(ref Operation operation);
  public static string Recycle(string path) {
    var operation = new Operation { wFunc = 3, pFrom = path + "\\0\\0", fFlags = 0x0040 | 0x0010 | 0x0004 | 0x0400 | 0x4000 };
    int result = SHFileOperation(ref operation);
    return result != 0 ? "failed" : operation.fAnyOperationsAborted ? "declined" : "recycled";
  }
}
'@
[Console]::Out.Write([HarnessRecycleBin]::Recycle($env:HARNESS_TRASH_PATH))
`

export interface TrashDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** `osascript` with its arguments: resolves on exit 0. Swapped in tests, which must never reach the person's Trash. */
  osascript?: (args: string[]) => Promise<void>
  powershell?: (script: string, inputs: Record<string, string>) => Promise<PowershellResult>
  now?: () => Date
}

export function systemTrash(deps: TrashDeps = {}): Trash {
  const platform = deps.platform ?? process.platform
  if (platform === 'darwin') {
    const osascript = deps.osascript ?? ((args) => new Promise<void>((resolve, reject) => {
      execFile('/usr/bin/osascript', args, { timeout: TRASH_TIMEOUT_MS, killSignal: 'SIGKILL' }, (error) => error ? reject(error) : resolve())
    }))
    return async (path) => {
      try { await osascript(['-l', 'JavaScript', '-e', MAC_SCRIPT, path]) } catch { throw new TrashError('TRASH_FAILED') }
    }
  }
  if (platform === 'win32') {
    const powershell = deps.powershell ?? ((script, inputs) => runPowershellAsync(script, inputs, TRASH_TIMEOUT_MS))
    return async (path) => {
      const result = await powershell(WINDOWS_SCRIPT, { HARNESS_TRASH_PATH: path })
      if (result.status === 0 && result.stdout === 'recycled') return
      throw new TrashError(result.status === 0 && result.stdout === 'declined' ? 'TRASH_DECLINED' : 'TRASH_FAILED')
    }
  }
  return (path) => homeTrash(path, deps.env ?? process.env, deps.now ?? (() => new Date()))
}

/** How many names a folder may take in the Trash before it is refused: `<name>`, `<name>.2`, … */
const NAMES_MAX = 1000

/** `YYYY-MM-DDThh:mm:ss` in local time, as the specification has it. */
function deletionDate(at: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`
}

/**
 * The freedesktop.org home trash ($XDG_DATA_HOME/Trash): its `.trashinfo` written first and exclusively, which reserves the
 * name, then the folder renamed into `files/`. A rename across volumes (EXDEV) is refused rather than copied and deleted.
 */
async function homeTrash(path: string, env: NodeJS.ProcessEnv, now: () => Date): Promise<void> {
  const trash = join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share'), 'Trash')
  const files = join(trash, 'files'), info = join(trash, 'info')
  try {
    await mkdir(files, { recursive: true, mode: 0o700 })
    await mkdir(info, { recursive: true, mode: 0o700 })
  } catch { throw new TrashError('TRASH_UNAVAILABLE') }
  const record = `[Trash Info]\nPath=${path.split('/').map(encodeURIComponent).join('/')}\nDeletionDate=${deletionDate(now())}\n`
  for (let n = 1; n <= NAMES_MAX; n++) {
    const name = n === 1 ? basename(path) : `${basename(path)}.${n}`
    const reserved = join(info, `${name}.trashinfo`)
    try { await writeFile(reserved, record, { flag: 'wx', mode: 0o600 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw new TrashError('TRASH_UNAVAILABLE')
    }
    // A folder left in files/ without its record: a rename onto an empty one would replace it.
    if (await lstat(join(files, name)).then(() => true, () => false)) { await rm(reserved, { force: true }); continue }
    try { await rename(path, join(files, name)); return } catch (error) {
      await rm(reserved, { force: true })
      throw new TrashError((error as NodeJS.ErrnoException).code === 'EXDEV' ? 'TRASH_UNAVAILABLE' : 'TRASH_FAILED')
    }
  }
  throw new TrashError('TRASH_UNAVAILABLE')
}
