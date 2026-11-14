/**
 * `harness uninstall` at work, in the root: while it is there (and fresh) the desktop app does not start the daemon
 * again (desktop/lib/core/uninstall_marker.dart), which would hold the files being removed and undo the uninstall. It
 * is in no plan: it goes after every other path (removeNow, finalRemovalScript), and before the root, whatever
 * --keep-data keeps. Its text is the time it was written, in seconds: one that outlived an uninstall killed half way
 * stops counting on its own. Its own module, so that `harness start --if-down` reads it without loading the
 * uninstaller (lib/startIfDown.ts).
 */
export const UNINSTALL_MARKER = 'uninstalling'
