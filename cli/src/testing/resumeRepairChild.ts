/** Disposable engine worker for process-boundary repair tests, always given a private test data directory. */
import { engineResumeRepairRequests } from '../engines/worker/resumeRepairRequests.js'
import { RESUME_REPAIR_PREPARE } from '../engines/worker/resumeRepairProtocol.js'

const requests = engineResumeRepairRequests()
let proceed!: () => void
const gate = new Promise<void>(resolve => { proceed = resolve })
process.on('message', async (request: { id: number; method: string; payload: Record<string, unknown>; proceed?: boolean }) => {
  if (request.proceed) { proceed(); return }
  try {
    if (request.method === 'fixture_append_codex_history') {
      const { appendCodexHistory } = await import('./codexRollout.js')
      appendCodexHistory(String(request.payload.file), Number(request.payload.bytes))
      process.send?.({ id: request.id, answer: { pid: process.pid } })
      return
    }
    const answer = await requests[request.method](request.payload, { owner: true, local: true } as never)
    if (process.argv[2] === 'pause-prepared' && request.method === RESUME_REPAIR_PREPARE) {
      process.send?.({ staged: answer })
      await gate
    }
    process.send?.({ id: request.id, answer })
  } catch { process.send?.({ id: request.id, answer: { error: 'SERVICE_FAILED' } }) }
})
process.on('disconnect', () => { process.exit(0) })
process.send?.({ ready: true })
