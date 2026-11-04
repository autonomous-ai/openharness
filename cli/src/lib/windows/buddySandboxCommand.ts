/**
 * `harness buddy-sandbox install|status|uninstall`: this computer's sandbox for a Buddy's shell (./buddySandbox.ts). The app's
 * one question runs `install`: Windows asks once, then the person's home is opened to the sandbox's account for reading,
 * which can take minutes the first time. Only when that finished may a Buddy read past its folder.
 */
import { homedir } from 'node:os'
import { isTeamAccount } from '../../team/config.js'
import { buddyProfileExcludes } from '../buddyGuard.js'
import { buddySandboxReady, forgetBuddySandboxInstalled, markBuddySandboxInstalled, srtWinBinary } from './buddySandbox.js'

const USAGE = 'Usage: harness buddy-sandbox install | status | uninstall'

export interface BuddySandboxInstall {
  /** Windows' own question and the sandbox's account; 'cancelled' when the person said no. */
  install(srtWin: string, excludes: readonly string[], progress: (line: string) => void): Promise<'installed' | 'cancelled'>
  uninstall(srtWin: string): Promise<void>
}

export interface BuddySandboxCommandDeps {
  platform?: NodeJS.Platform
  team?: () => boolean
  home?: () => string
  binary?: () => string | null
  ready?: () => boolean
  mark?: () => void
  forget?: () => void
  runtime?: BuddySandboxInstall
  out?: (line: string) => void
  err?: (line: string) => void
}

function realRuntime(): BuddySandboxInstall {
  const runtime = import('@anthropic-ai/sandbox-runtime')
  return {
    install: async (srtWin, excludes, progress) => {
      const { installWindowsSandboxAsync, resolveSrtWin } = await runtime
      const done = await installWindowsSandboxAsync({ srtWin: resolveSrtWin({ path: srtWin }), profileExclude: excludes, onProfileGrantProgress: progress,
        onProfileGrantStart: () => progress('Letting your Buddy read your files. The first time can take a few minutes.') })
      if (done.cancelled) return 'cancelled'
      // Without the grant a command in it reads nothing of the person's: not what they said yes to.
      if (done.profileGrant && !done.profileGrant.applied) throw new Error(done.profileGrant.reason)
      return 'installed'
    },
    uninstall: async (srtWin) => {
      const { resolveSrtWin, uninstallWindowsSandbox } = await runtime
      uninstallWindowsSandbox({ srtWin: resolveSrtWin({ path: srtWin }) })
    },
  }
}

/** `harness uninstall`: nothing of it stays on the computer. Windows asks for the part it installed. Nothing to do if none was. */
export async function removeBuddySandbox(deps: Pick<BuddySandboxCommandDeps, 'ready' | 'binary' | 'runtime' | 'forget'> = {}): Promise<boolean> {
  const srtWin = (deps.binary ?? srtWinBinary)()
  if (!srtWin || !(deps.ready ?? buddySandboxReady)()) return false
  await (deps.runtime ?? realRuntime()).uninstall(srtWin)
  ;(deps.forget ?? forgetBuddySandboxInstalled)()
  return true
}

export async function buddySandboxCommand(argv: readonly string[], deps: BuddySandboxCommandDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`))
  const err = deps.err ?? ((line: string) => process.stderr.write(`${line}\n`))
  if ((deps.platform ?? process.platform) !== 'win32') { err('This is for Windows. On a Mac or Linux a Buddy uses its engine\'s own sandbox.'); return 1 }
  const verb = argv[0]
  if (verb === 'status') {
    out((deps.ready ?? buddySandboxReady)() ? 'ready' : 'not set up')
    return 0
  }
  if (verb !== 'install' && verb !== 'uninstall') { err(USAGE); return 2 }
  // A Team account never gets it: the sandbox's account would read that account's home, and a Buddy never runs there.
  if (verb === 'install' && (deps.team ?? isTeamAccount)()) { err('A Harness Team account keeps its Buddies to their own folders.'); return 1 }
  const srtWin = (deps.binary ?? srtWinBinary)()
  if (!srtWin) { err('This Harness has no sandbox helper. Update Harness, then try again.'); return 1 }
  const runtime = deps.runtime ?? realRuntime()
  if (verb === 'uninstall') {
    await runtime.uninstall(srtWin)
    ;(deps.forget ?? forgetBuddySandboxInstalled)()
    out('Removed. Your Buddies read their own folders again from their next start.')
    return 0
  }
  let result: 'installed' | 'cancelled'
  try {
    result = await runtime.install(srtWin, buddyProfileExcludes((deps.home ?? homedir)()), out)
  } catch (error) {
    err(`Could not set this up: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  if (result === 'cancelled') { err('Windows did not get a yes. Your Buddy keeps to its own folder.'); return 1 }
  ;(deps.mark ?? markBuddySandboxInstalled)()
  out('Done. Your Buddies can read your files from their next start.')
  return 0
}
