/**
 * Whether this process runs as an old Harness Team account's boot job, which ends at once (entry.ts).
 *
 * Team accounts went with Swarm v3 (#4221) and their code with them (anh Dee, 2026-11-10: "clean up v1/2/3 entirely"). A
 * computer set up before 2026-11-07 whose person has not yet removed the account (Desktop asks: widgets/old_team_account.dart)
 * still has its boot job, which runs the account's own copy of this CLI at every boot: `team __start` and `__harnessd` on a
 * Mac and Linux, `__harnessd` in a loop that ends on exit 0 on Windows. That copy takes releases, as every Team account did.
 * So those commands end at once, exit 0, before anything loads: no daemon, no port, no dial or Wi-Fi device beside the
 * owner's, no update check. Exit 0 is the clean stop launchd (`KeepAlive` `SuccessfulExit` false), systemd
 * (`Restart=on-failure`) and the task's loop do not start again. `__harnessd-probe` still answers: an old Team daemon that
 * is still running probes a new build before it re-executes on it, and a probe that failed would roll this release back.
 *
 * The account is the one setup made, `harnessteam`, and only while the root-owned config setup wrote (./layout.ts) names
 * it: a file anyone could plant in `C:\ProgramData` cannot stop another account's Harness, and every other account reads
 * nothing here.
 */
import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { TEAM_CONFIG_FILES } from './layout.js'

/** The account Team setup always made. */
const TEAM_USER = 'harnessteam'

/** What the boot job's log says once a boot. */
export const OLD_TEAM_ACCOUNT_LINE = 'harness: this is an old Harness Team account, which runs nothing now. Remove it in Harness on this computer\'s own account.'

export function isOldTeamAccount(platform: NodeJS.Platform = process.platform,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'), user: () => string = () => userInfo().username): boolean {
  if (!Object.hasOwn(TEAM_CONFIG_FILES, platform)) return false
  // Windows' account names are not case-sensitive.
  const same = (a: string, b: string): boolean => platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  try {
    const me = user()
    if (!same(me, TEAM_USER)) return false
    const config = JSON.parse(read(TEAM_CONFIG_FILES[platform as keyof typeof TEAM_CONFIG_FILES])) as { version?: unknown; user?: unknown }
    return config.version === 1 && typeof config.user === 'string' && same(config.user, me)
  } catch {
    // No name for this account, no config, or one that cannot be read: not a Team account.
    return false
  }
}
