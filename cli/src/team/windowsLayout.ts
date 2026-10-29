/**
 * Where the Harness Team account lives on Windows, and the checks every value passes before it goes into the elevated
 * PowerShell script (docs/superpowers/plans/2026-10-28-harness-team-account-windows.md, the layout table).
 *
 * The same account a Mac gets (./layout.ts): a separate standard local user, `harnessteam`, listed on the sign-in screen,
 * whose own daemon runs teammates' Swarm agents. Its profile is the one Windows makes (`C:\Users\harnessteam`). What
 * setup made sits under `C:\ProgramData\Harness`: Administrators' and SYSTEM's, readable by every account, so a process
 * in the team account cannot point its own privacy check somewhere else.
 */
import { TEAM_USER } from './layout.js'

export const WINDOWS_TEAM_HOME = `C:\\Users\\${TEAM_USER}`
export const WINDOWS_TEAM_SHARED_DIR = 'C:\\ProgramData\\Harness'
/** Left by a setup that made the shared folder, so removal takes it away once it is empty, as on a Mac. */
export const WINDOWS_TEAM_SHARED_MARK = `${WINDOWS_TEAM_SHARED_DIR}\\.made-by-harness-team-setup`
export const WINDOWS_TEAM_CONFIG_FILE = `${WINDOWS_TEAM_SHARED_DIR}\\team.json`
/** The team account may change it; every account may read it (the owner's `harness team status`). */
export const WINDOWS_TEAM_STATUS_DIR = `${WINDOWS_TEAM_SHARED_DIR}\\Team`
export const WINDOWS_TEAM_STATUS_FILE = `${WINDOWS_TEAM_STATUS_DIR}\\status.json`
/**
 * The sign-in handover folder. The owner's own process writes the single-use code here after the elevated script
 * returns, and the team daemon reads and deletes it. Not the team home, as on a Mac: when the owner is a standard user,
 * UAC runs the elevated script as another administrator, whose `team __handoff` would sign in the wrong person, and the
 * owner cannot write into the team account's profile.
 */
export const WINDOWS_TEAM_HANDOFF_DIR = `${WINDOWS_TEAM_STATUS_DIR}\\handoff`
export const WINDOWS_TEAM_HANDOFF_FILE = `${WINDOWS_TEAM_HANDOFF_DIR}\\team-handoff`
/** The scheduled task that runs the team daemon, the Windows form of the LaunchDaemon. */
export const WINDOWS_TEAM_TASK_PATH = '\\Harness\\'
export const WINDOWS_TEAM_TASK_NAME = 'Harness Team'
export const WINDOWS_TEAM_TASK = `${WINDOWS_TEAM_TASK_PATH}${WINDOWS_TEAM_TASK_NAME}`
/** The owner's folder for the subscription relay hand-off (./relay.ts), per owner. Setup makes it, owned by the owner. */
export const windowsTeamRelayDir = (owner: string) => `${WINDOWS_TEAM_SHARED_DIR}\\team-relay-${owner}`

/** Well-known SIDs, by number: the names are translated on a German or French Windows ("Administratoren"). */
export const SID = {
  administrators: 'S-1-5-32-544',
  users: 'S-1-5-32-545',
  system: 'S-1-5-18',
  everyone: 'S-1-1-0',
  authenticatedUsers: 'S-1-5-11',
} as const

/** The team account's own files, all inside its profile; the Windows twin of ./layout.ts `teamPaths`. */
export function windowsTeamPaths(home: string = WINDOWS_TEAM_HOME) {
  const harness = `${home}\\.harness`
  const cli = `${harness}\\cli`
  const data = `${cli}\\data`
  return {
    home,
    harness,
    cli,
    cliJs: `${cli}\\cli.js`,
    data,
    log: `${data}\\harness.log`,
    runtime: `${harness}\\runtime`,
    auth: `${harness}\\auth`,
    session: `${harness}\\auth\\session.json`,
    computerId: `${harness}\\computer-id`,
    /** npm's `--global --prefix` on Windows puts the commands in the prefix itself, not in its bin folder. */
    npmPrefix: `${home}\\.local`,
    bin: `${home}\\.local\\bin`,
  }
}

// The checks live in ./layout.ts, beside the POSIX ones: one checkWindowsPath for every caller.
export { checkSid, checkWindowsPath, checkWindowsUser } from './layout.js'
