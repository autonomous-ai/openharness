import { z } from 'zod'

/**
 * Why a host reports that it cannot type a delivery into an agent's terminal yet. These are the reasons the
 * harness core gives (cli/src/engines/kit/screen.ts). Kept on the delivery for logs only; people are never shown a
 * queued message as waiting, the agent simply answers when it can.
 */
export const holdReason = z.enum(['team_waiting_unavailable', 'team_waiting_user', 'team_waiting_draft', 'team_waiting_idle', 'team_waiting_control'])
export type HoldReason = z.infer<typeof holdReason>

/** Not a host's reason, so no host can send it (routes/superTabs.ts takes only those above): the delivery pass writes it on a
 *  claim it ended because nothing touched it for 10 minutes (deliverySettle.ts CLAIM_QUIET_MS), so the host's acknowledgement
 *  that it typed it still counts if it comes late (store.ts delivery). Prod 10-30: acknowledgements failed through two hours
 *  of SWARM_BUSY and typed messages showed Not sent. */
export const QUIET_CLAIM = 'claim_quiet'
