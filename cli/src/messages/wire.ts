/**
 * Agent Messages' frames as the relay carries them between the owner's machines (lib/e2ee/applicationFrames.ts):
 * sealed both ways. They carry what agents say to each other.
 */
export const AGENT_MESSAGES_REQUEST_TYPES: ReadonlySet<string> = new Set(['agent_messages'])
export const AGENT_MESSAGES_RESULT_TYPES: ReadonlySet<string> = new Set(['agent_messages_result'])
