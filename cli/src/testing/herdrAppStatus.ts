/** `herdr-app status`'s stdout in Herdr 0.1.16's shape (docs/plans/2026-11-17-dial-herdr-scroll-design.md §3), written
 *  by hand with made-up ids: the devices read `agent` alone. With no argument the key is left out. */
export const herdrAppStatus = (agent?: string | null): string => JSON.stringify({
  zoom: 1,
  font_size: 13,
  ui_font_size: 13,
  space: 'space-a',
  tab: 'tab-a',
  focused_pane: 'pane-a',
  layout: 'layout-a',
  // JSON.stringify leaves a key whose value is undefined out.
  agent,
  floats: [],
  overlays: [],
  errors: [],
})
