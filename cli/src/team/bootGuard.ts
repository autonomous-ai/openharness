/**
 * Whether this process runs as an old Harness Team account, which ends at once (entry.ts).
 *
 * Team accounts went with Swarm v3 (#4221) and their code with them (anh Dee, 2026-11-10: "clean up v1/2/3 entirely"). A
 * computer set up before 2026-11-07 whose person has not yet removed the account (Desktop asks: widgets/old_team_account.dart)
 * still has its boot job, which runs the account's own copy of this CLI at every boot: `team __start` and `__harnessd` on a
 * Mac and Linux, `__harnessd` in a loop that ends on exit 0 on Windows. That copy took this release, as every Team account
 * took releases. So every command it runs exits 0 before anything loads: no daemon, no port, no dial or Wi-Fi device beside
 * the owner's, no update check, no log line. Exit 0 is the clean stop launchd (`KeepAlive` `SuccessfulExit` false), systemd
 * (`Restart=on-failure`) and the task's loop do not start again.
 *
 * Read from the root-owned config setup wrote (./layout.ts `TEAM_CONFIG_FILES`), which names the account. Nothing else is
 * loaded: entry.ts runs this in every process.
 */
import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { TEAM_CONFIG_FILES } from './layout.js'

export function isOldTeamAccount(platform: NodeJS.Platform = process.platform,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'), user: () => string = () => userInfo().username): boolean {
  if (!Object.hasOwn(TEAM_CONFIG_FILES, platform)) return false
  try {
    const named = (JSON.parse(read(TEAM_CONFIG_FILES[platform as keyof typeof TEAM_CONFIG_FILES])) as { user?: unknown }).user
    if (typeof named !== 'string' || !named) return false
    const me = user()
    // Windows' account names are not case-sensitive.
    return platform === 'win32' ? named.toLowerCase() === me.toLowerCase() : named === me
  } catch {
    // No config (every computer set up since), or one that cannot be read, or no name for this account: not a Team account.
    return false
  }
}
