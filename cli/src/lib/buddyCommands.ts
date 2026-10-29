/**
 * A Buddy's own Super Tab commands: reading its chats and posting in its own, and its owner's proposal. The pane it runs in
 * says who it is (superTabs/command.ts), so it never names an agent, a port or a machine. Both of its guards allow these
 * and nothing more: Claude Code's hook (lib/buddyGuard.ts) and Codex's rule (lib/buddyCodexRules.ts).
 */
export const BUDDY_SUPER_TAB_ACTIONS = ['status', 'messages', 'message', 'decisions', 'post', 'propose', 'help'] as const
