/**
 * The owner's three requests about the Claude accounts this machine's Product Managers may move between
 * (lib/pmAccountPool.ts): the list with how much each has left, the tick, and the moves made. Theirs alone, as
 * `claude_profiles_list` is: an account's email and quota are the owner's to see, and a tick spends their account.
 *
 * Nothing here reads usage: the windows are what the host's machine reading already kept (machines.ts), so an account not read
 * yet shows none rather than costing a read Anthropic may refuse.
 */
import type { Asker, CoreApi } from '../core/api.js'
import { claudeAccountOf, listClaudeProfiles, type ClaudeProfile } from '../lib/claudeProfiles.js'
import { profileSignedIn } from './leadSwitchRequest.js'
import { readPmMoves, readPmPool, setPmPool } from '../lib/pmAccountPool.js'

type Window = { name: '5-hour' | 'weekly'; leftPercent: number; resetsAt?: string }
export interface PmAccountsDeps {
  /** This machine's Claude accounts, the default first. */
  profiles: (machineId: string) => ClaudeProfile[]
  /** The email of a folder's account, for the owner's screen. */
  email: (folder: string) => string | undefined
  /** The windows the host last read for an account (`'default'` or a profile id); none while no host runs or none was read. */
  windows: (id: string) => Window[]
  /** Whether an account holds a sign-in Claude can use (`'default'` for the default account). */
  signedIn: (home: string) => Promise<boolean>
  /** Names of the Product Managers running on an account here, by profile id. The roster is the host's, so until it is passed in (the
   *  PM rotation), nobody is listed. */
  pmHere: (id: string) => string[]
}

export const realPmAccountsDeps = (windows: PmAccountsDeps['windows']): PmAccountsDeps => ({
  profiles: machineId => listClaudeProfiles([], { machineId }),
  email: folder => claudeAccountOf(folder).emailAddress,
  windows,
  signedIn: home => profileSignedIn('claude', home, Date.now()),
  pmHere: () => [],
})

type Reply = Record<string, unknown>
const OWNER_REQUIRED = { error: 'OWNER_REQUIRED' }
/** The check superTabs/service.ts makes for every request that spends or shows the host account: control of this machine is not
 *  enough, a verified machine share included; only this machine's own processes or its account's owner. */
const mayUse = (asker: Asker): boolean => asker.owner && (asker.local || asker.accountOwner === true)

export function pmAccountsRequests(core: CoreApi, deps: PmAccountsDeps): Record<'pm_accounts_list' | 'pm_accounts_use' | 'pm_accounts_history',
  (payload: Record<string, unknown>, asker: Asker) => Promise<Reply>> {
  return {
    pm_accounts_list: async (_payload, asker) => {
      if (!mayUse(asker)) return OWNER_REQUIRED
      try {
        const pool = new Set(readPmPool())
        const accounts = await Promise.all(deps.profiles(core.daemon.machineId()).map(async p => {
          const windows = deps.windows(p.default ? 'default' : p.id)
          const email = deps.email(p.path)
          return { id: p.id, label: p.label, ...(email ? { email } : {}), ...(p.default ? { default: true as const } : {}),
            pmMayUse: pool.has(p.id), pmHere: deps.pmHere(p.id), signedIn: await deps.signedIn(p.default ? 'default' : p.path), windows }
        }))
        return { accounts }
      } catch {
        return { error: 'PM_ACCOUNTS_FAILED' }
      }
    },

    // Ticking an account that is not one of this machine's is refused; unticking one is always allowed, because a pool keeps the ids
    // of folders that went missing until the owner removes them (pmAccountPool.ts).
    pm_accounts_use: async (payload, asker) => {
      if (!mayUse(asker)) return OWNER_REQUIRED
      const { ids, on } = payload
      if (!Array.isArray(ids) || ids.length > 64 || !ids.every((id): id is string => typeof id === 'string' && id !== '') || typeof on !== 'boolean') return { error: 'INVALID_REQUEST' }
      try {
        if (on) {
          const known = new Set(deps.profiles(core.daemon.machineId()).map(p => p.id))
          if (!ids.every(id => known.has(id))) return { error: 'NOT_FOUND' }
        }
        const current = readPmPool()
        const pool = on ? [...current, ...ids] : current.filter(id => !ids.includes(id))
        setPmPool(pool)
        return { pool: readPmPool() }
      } catch {
        return { error: 'PM_ACCOUNTS_FAILED' }
      }
    },

    pm_accounts_history: async (payload, asker) => {
      if (!mayUse(asker)) return OWNER_REQUIRED
      const limit = typeof payload.limit === 'number' && Number.isInteger(payload.limit) && payload.limit > 0 ? payload.limit : undefined
      return { moves: readPmMoves(limit) }
    },
  }
}
