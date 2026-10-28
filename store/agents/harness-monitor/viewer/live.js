/**
 * The page's one live connection to its viewer server, open only while someone can see the page and has
 * not frozen it. The server reads every machine on the account for as long as a page is connected, so a
 * Monitor tab behind another tab, in a minimised window or frozen kept the whole fleet answering it
 * (2026-10-28). Opening again brings the current readings at once and the server reads anything stale.
 */

/** Harness marks the page `data-host-visible="false"` while its tab is out of sight: a web view kept
 *  alive behind another tab can still report itself visible to the page. */
export const hostHidden = root => root?.dataset?.hostVisible === 'false'

export function liveConnection({ open, paused }) {
  let stream = null
  return {
    /** Open or close the connection to match `paused()`; true when it is open afterwards. */
    sync() {
      if (paused()) { stream?.close(); stream = null; return false }
      stream ??= open()
      return true
    },
    get open() { return stream !== null },
  }
}
