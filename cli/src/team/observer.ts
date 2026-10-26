/** The privacy reading this process sends with its machine's Super Tab observation (superTabs/machines.ts). */
import { userInfo } from 'node:os'
import { readAuthSession } from '../lib/authSession.js'
import { readTeamConfig } from './config.js'
import { TeamPrivacyObserver, runPrivacyCheck, writeTeamStatus, type PrivacyObservation } from './privacy.js'

let observer: TeamPrivacyObserver | null = null

export function teamPrivacyObserver(): PrivacyObservation | null {
  observer ??= new TeamPrivacyObserver({
    config: () => readTeamConfig(),
    user: () => userInfo().username,
    teamSession: () => readAuthSession()?.kind === 'team',
    check: (config) => runPrivacyCheck(config),
    writeStatus: writeTeamStatus,
    now: () => Date.now(),
  })
  return observer.observe()
}
