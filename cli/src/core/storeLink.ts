/**
 * The Harness Store in its own process, as the core hears it (beside the viewers; the process's side is
 * services/storeProcess.ts). The apps' requests are routed to it. The
 * Store reports progress and readiness. Package lookups are bounded requests; the core
 * owns no installed index, manifest or package cache.
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DSH_SESSION_ENV } from '../dsh/sessionEnv.js'
import { DSH_ID_RE } from '../dsh/id.js'
import { launchContributionIn, launchText } from '../lib/launchContribution.js'
import { dshAccountIn } from '../dsh/launchWire.js'
import type { DshContextAnswer, DshLaunchRequest, DshLaunchAnswer, DshMaterializeAnswer, DshRefusal, DshDescribeAnswer } from '../dsh/launchWire.js'
import type { CoreApi, StorePort } from './api.js'
import { ServiceUnavailableError } from './serviceHost.js'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)

function refusal(value: Record<string, unknown>): DshRefusal | null {
  if (value.ok !== false || !launchText(value.error) || !launchText(value.detail)) return null
  if (value.unavailable !== undefined && value.unavailable !== 'store') return null
  if (value.thrown !== undefined && !launchText(value.thrown)) return null
  if (value.holdScope !== undefined && value.holdScope !== 'workspace') return null
  return { ok: false, error: value.error, detail: value.detail,
    ...(value.unavailable ? { unavailable: value.unavailable } : {}),
    ...(value.holdScope ? { holdScope: value.holdScope } : {}),
    ...(value.thrown !== undefined ? { thrown: value.thrown } : {}) }
}

/** The fixed shape bounds a lookup before any caller retains its facts. */
export function dshDescriptionIn(value: unknown): DshDescribeAnswer | null {
  if (!record(value)) return null
  if (value.ok !== true) return refusal(value)
  const short = (value: unknown): value is string => launchText(value, 4096)
  if (!short(value.id) || !DSH_ID_RE.test(value.id) || !short(value.name) || !value.name
    || !(value.permissionMode === null || short(value.permissionMode))
    || !(value.refusal === null || short(value.refusal))) return null
  return { ok: true, id: value.id, name: value.name, permissionMode: value.permissionMode, refusal: value.refusal }
}

/** Only a checked contribution can reach the pane; malformed answers hold the launch. */
export function dshMaterializeAnswerIn(value: unknown): DshMaterializeAnswer | null {
  if (!record(value)) return null
  if (value.ok !== true) return refusal(value)
  return texts(value.created) && texts(value.kept) && texts(value.warnings)
    ? { ok: true, created: value.created, kept: value.kept, warnings: value.warnings } : null
}

export function dshContextAnswerIn(value: unknown): DshContextAnswer | null {
  if (!record(value)) return null
  if (value.ok !== true) return refusal(value)
  const account = dshAccountIn(value.account)
  return account ? { ok: true, account } : null
}

/** Captured before awaiting the launch. New creates retain their admitted package id.
 * Historical snapshot ids remain Store-declared package authority; an alias list in a reply is no proof. */
export interface DshLaunchIdentity { ids?: readonly string[]; workspace: string }

export function dshLaunchAnswerIn(value: unknown, request: DshLaunchRequest, identity?: DshLaunchIdentity): DshLaunchAnswer | null {
  if (!record(value)) return null
  if (value.ok !== true) return refusal(value)
  const launch = launchContributionIn(value.launch)
  if (!launch || Object.keys(launch.env).some(name => name.startsWith('HARNESS_') && !(DSH_SESSION_ENV as readonly string[]).includes(name))) return null
  const env = launch.env
  if (env.HARNESS_PRIVATE_GRID !== undefined && env.HARNESS_PRIVATE_GRID !== request.account.privateGrid) return null
  if (identity) {
    const runtime = join(identity.workspace, '.harness', 'runtime', createHash('sha256').update(request.key).digest('hex'))
    if ((identity.ids ? !identity.ids.includes(env.HARNESS_DSH!) : !DSH_ID_RE.test(env.HARNESS_DSH ?? '')) || env.HARNESS_WORKSPACE !== identity.workspace
      || env.HARNESS_CONTEXT_FILE !== join(runtime, 'CONTEXT.md') || env.HARNESS_SKILLS_DIR !== join(runtime, 'skills')) return null
  }
  return { ok: true, launch }
}

type CallStore = (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>

export function createStoreLink(core: Pick<CoreApi, 'clients'>,
  call: CallStore = async () => ({ error: 'SERVICE_UNAVAILABLE' })) {
  const listeners = new Set<() => void>()
  const port: StorePort = {
    stop: () => {},
    dshContext: async request => {
      const answer = dshContextAnswerIn(await call('dshContext', { ...request }))
      if (!answer) throw new ServiceUnavailableError('store')
      return answer
    },
    dshDescribe: async request => {
      const answer = dshDescriptionIn(await call('dshDescribe', { ...request }))
      if (!answer) { console.warn('[store] PACKAGE_FACTS_REFUSED'); throw new ServiceUnavailableError('store') }
      return answer
    },
    dshMaterialize: async request => {
      const answer = dshMaterializeAnswerIn(await call('dshMaterialize', { ...request }))
      if (!answer) throw new ServiceUnavailableError('store')
      return answer
    },
    dshLaunch: request => call('dshLaunch', { ...request }),
  }
  return {
    port,
    /** Restore is already held in core; a Store notice only schedules another pass after core ready. */
    onReady(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    /** The core's answers to the Store's questions (core/serviceLinks.ts `answer`, for `store`). */
    answer(query: string, payload: Record<string, unknown>): Record<string, unknown> {
      if (query === 'installStatus') {
        const status = payload.status
        if (!status || typeof status !== 'object' || Array.isArray(status)) return { error: 'BAD_STATUS' }
        core.clients.dshInstallStatus(status as Record<string, unknown>)
        return { said: true }
      }
      if (query === 'prepared' || query === 'installed') {
        if (query === 'prepared') {
          for (const ready of listeners) ready()
        }
        return { read: true }
      }
      return { error: 'UNKNOWN_QUERY' }
    },
  }
}
