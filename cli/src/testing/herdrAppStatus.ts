/** `herdr-app status`'s stdout in Herdr 0.1.16's shape (docs/plans/2026-11-17-dial-herdr-scroll-design.md §3), written
 *  by hand with made-up ids: the devices read `tab` alone. With no tab the key is left out. `agent` is not what is on
 *  screen (Diego's first check, 2026-11-18): t5 unless the test names another. */
export const herdrAppStatus = (tab?: string | null, agent = 't5'): string => JSON.stringify({
  zoom: 1,
  font_size: 14,
  ui_font_size: 13,
  space: 'sp0123',
  // JSON.stringify leaves a key whose value is undefined out.
  tab,
  focused_pane: 'p0456',
  layout: 'main',
  agent,
  floats: {},
  overlays: [],
  errors: [],
})
