import { z } from 'zod'

/**
 * Why a host reports that it cannot type a delivery into an agent's terminal yet. These are the reasons the
 * harness core gives (cli/src/engines/kit/screen.ts). Kept on the delivery for logs only; people are never shown a
 * queued message as waiting, the agent simply answers when it can.
 */
export const holdReason = z.enum(['team_waiting_unavailable', 'team_waiting_user', 'team_waiting_draft', 'team_waiting_idle', 'team_waiting_control'])
export type HoldReason = z.infer<typeof holdReason>
