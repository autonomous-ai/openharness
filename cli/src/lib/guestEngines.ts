/** The engines a guest's harness runs. In a file of their own: the core's rule for a guest's requests needs the list,
 *  and loaded the pane's whole command for it (lib/guestPaneCommand.ts; the audit of 2026-11-12). */
export type GuestLaunchEngine = 'claude' | 'codex'
export const GUEST_LAUNCH_ENGINES: readonly string[] = ['claude', 'codex'] satisfies readonly GuestLaunchEngine[]
