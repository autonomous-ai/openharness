/** Always sealed over the relay; replies go only to the requester. */
export const SHELL_REQUESTS = ['shell_capabilities', 'shell_open', 'shell_open_status', 'shell_context_reply'] as const
