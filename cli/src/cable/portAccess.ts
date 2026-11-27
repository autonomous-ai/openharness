// Why a Linux account may not open the dial's port, in words that say what to do.
//
// The ESP32-S3's /dev/ttyACM* belongs to a group (dialout on Debian, Ubuntu and Fedora, uucp on Arch), and an
// account outside it got only stty's "Permission denied" in the log every 2 s. The group is read from the device
// node, never assumed. Advice is given only when that group explains the refusal; anything else fails as before.
// Node built-ins only: serial.ts, which calls this, is bundled into the real-port fixtures.
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'

export const NO_ACCESS = (group: string) => `No access to the dial. Run: sudo usermod -aG ${group} $USER, then log out and in.`
export const NO_ACCESS_YET = 'No access to the dial yet. Log out and in.'

/** The port's group would let this account in, and it is not in it, or not in this login. */
export class PortAccessError extends Error {
  readonly code = 'EACCES'
  constructor(readonly problem: string) { super(problem) }
}

export interface PortAccessDeps {
  platform: NodeJS.Platform
  /** Throws as accessSync(path, R_OK | W_OK) does. */
  access(path: string): void
  stat(path: string): { gid: number; mode: number }
  /** /etc/group. */
  groupFile(): string
  /** This login's groups, as process.getgroups(). */
  groups(): readonly number[]
  user: string
}

// The name goes into a command the person pastes into a shell.
const GROUP_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/
const GROUP_RW = 0o060

const realDeps: PortAccessDeps = {
  get platform() { return process.platform },
  access: (path) => accessSync(path, constants.R_OK | constants.W_OK),
  stat: (path) => statSync(path),
  groupFile: () => readFileSync('/etc/group', 'utf8'),
  groups: () => process.getgroups?.() ?? [],
  get user() { return userInfo().username },
}

export function portAccessProblem(path: string, deps: PortAccessDeps = realDeps): PortAccessError | null {
  try {
    if (deps.platform !== 'linux') return null
    try {
      deps.access(path)
      return null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EACCES') return null
    }
    const { gid, mode } = deps.stat(path)
    if ((mode & GROUP_RW) !== GROUP_RW || deps.groups().includes(gid)) return null
    const fields = deps.groupFile().split('\n').map((line) => line.split(':')).find((entry) => entry[2] === String(gid))
    if (!fields || !GROUP_NAME.test(fields[0])) return null
    const members = (fields[3] ?? '').split(',')
    return new PortAccessError(members.includes(deps.user) ? NO_ACCESS_YET : NO_ACCESS(fields[0]))
  } catch {
    return null
  }
}
