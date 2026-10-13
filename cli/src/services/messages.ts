/**
 * Agent Messages (`messages`), an experiment: harnesses in a tab with Agent Messages on message each other with
 * `harness send` (messages/service.ts, docs/design/2026-10-10-agent-messages.md). Its typed deliveries go
 * through `core.turns.deliver` under `team:` ids, which the core writes only into an idle, empty composer, and
 * the core asks in line whether one may still be written (`canWrite`).
 * - The `agent_messages` request: `harness send` in an agent's pane, the owner's other machines, the windows.
 * - In the core's process (`HARNESSD_SERVICES=none`) it starts here, at once; in its own process,
 *   services/messagesProcess.ts starts the same service.
 */
import type { CoreApi, CorePorts, ServiceRequests } from '../core/api.js'
import { startAgentMessages, type MessagesOptions } from '../messages/service.js'

/** The requests Agent Messages answers, declared in core/api.ts for the core to route. */
export { MESSAGES_REQUESTS } from '../core/api.js'

/** Agent Messages in the core's process (`HARNESSD_SERVICES=none`): its port is whether a delivery may be written. */
export function startMessagesInCore(core: CoreApi, ports: CorePorts, options: MessagesOptions = {}): ServiceRequests {
  const messages = startAgentMessages(core, options)
  ports.messages = Object.assign({ canWrite: (deliveryId: string) => messages.canWrite(deliveryId) }, { stop: () => messages.stop() })
  messages.start()
  return messages.requests
}
