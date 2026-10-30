/**
 * A kitty graphics command: `G`, then comma-separated one-letter keys with values, then `;` and its payload. tmux
 * takes any APC string (ESC _ … ESC \) as the pane's title, and Claude Code sends this query when it thinks it is not
 * inside tmux, as a guest's harness does: the guest helper starts the engine with `env -i`, so it has no TMUX. That
 * harness was named "Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA" (seen on a shared Mac, tmux 3.7c, 2026-10-22). It is never a
 * title: tmux.ts does not read one, and registry.ts does not name a harness with one it stored before.
 */
const KITTY_GRAPHICS = /^G[a-zA-Z]=[^,;\s]*(?:,[a-zA-Z]=[^,;\s]*)*(?:;[A-Za-z0-9+/=]*)?$/

export function isKittyGraphicsCommand(text: string): boolean {
  return KITTY_GRAPHICS.test(text.trim())
}
