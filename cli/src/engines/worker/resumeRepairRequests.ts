import type { ServiceRequests } from '../../core/api.js'
import { env } from '../../config/env.js'
import { join } from 'node:path'
import type { ResumeRepairWorker } from '../resumeRepairs.js'
import { repairAnswer, repairPath, repairPreparation, repairSource, repairToken,
  RESUME_REPAIR_CAPABILITIES, RESUME_REPAIR_LOCATE, RESUME_REPAIR_PREPARE, RESUME_REPAIR_RELEASE,
  RESUME_REPAIR_REPLY_BYTES, RESUME_REPAIR_VERSION, RESUME_REPAIR_WAIT_MS } from './resumeRepairProtocol.js'
import { record } from './protocol.js'
import { snapshotRequests } from './snapshotRequests.js'

export function engineResumeRepairRequests(deps: { load?: () => Promise<ResumeRepairWorker>; recycle?: () => void } = {}): ServiceRequests {
  return snapshotRequests<ResumeRepairWorker>({
    engine: 'codex', version: RESUME_REPAIR_VERSION, capabilities: RESUME_REPAIR_CAPABILITIES, capability: 'resumeRepair',
    inFlight: 2, waitMs: RESUME_REPAIR_WAIT_MS, replyBytes: RESUME_REPAIR_REPLY_BYTES,
    load: deps.load ?? (async () => (await import('../resumeRepairs.js')).createResumeRepairWorker({ directory: join(env.ADAPTER_DATA_DIR, 'resume-repair') })),
    recycle: deps.recycle ?? (() => process.exit(1)),
    methods: {
      [RESUME_REPAIR_LOCATE]: { fields: ['source'], accepts: payload => repairSource(payload.source),
        answer: (worker, payload) => worker.locate(payload.source as never),
        valid: value => record(value) && Object.keys(value).length === 1 && (value.file === null || repairPath(value.file)) || repairAnswer(value) },
      [RESUME_REPAIR_PREPARE]: { fields: ['preparation'], accepts: payload => repairPreparation(payload.preparation),
        answer: (worker, payload) => worker.prepare(payload.preparation as never), valid: repairAnswer },
      [RESUME_REPAIR_RELEASE]: { fields: ['token'], accepts: payload => repairToken(payload.token),
        answer: (worker, payload) => worker.release(payload.token as string), valid: value => typeof value === 'boolean' },
    },
  })
}
