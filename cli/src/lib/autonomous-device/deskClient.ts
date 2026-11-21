import { connectSocket, type Connect, type Where } from '../../agentClient/daemon.js'
import { requestOnce } from '../../agentClient/requestOnce.js'
import { DeviceWorkBudget } from './pendingWork.js'
import { DESK_WAIT_MS, type DeskDirection } from './deskProtocol.js'
import type { DeskStep } from '../../services/deviceDesk.js'

// Replacing an inline service never forgets a previous request's physical socket charge.
const work = new DeviceWorkBudget()
export async function stepDeviceDesk(where: Where, direction: DeskDirection, currentAgentId: string | undefined,
  current: () => boolean, signal: AbortSignal, connect: Connect = connectSocket): Promise<DeskStep> {
  const answer = await requestOnce(where, 'harness_device_step', {
    machineId: where.machineId, direction, ...(currentAgentId ? { currentAgentId } : {}), expiresAt: Date.now() + DESK_WAIT_MS,
  }, current, signal, work, DESK_WAIT_MS, code => console.warn(`[wifi] DESK_${code}`), connect)
  if (!current() || signal.aborted || !answer) return 'no_agents'
  if (answer.step === 'no_agents' || answer.step === 'no_app') return answer.step
  if (typeof answer.machineId !== 'string' || !answer.machineId || answer.machineId.length > 200
    || typeof answer.agentId !== 'string' || !answer.agentId || answer.agentId.length > 128) return 'no_agents'
  return { machineId: answer.machineId, agentId: answer.agentId }
}
