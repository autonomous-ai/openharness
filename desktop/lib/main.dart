import 'app_shell.dart';
import 'core/connected_semantics.dart';
import 'desktop_workspace.dart'
    if (dart.library.js_interop) 'web/web_entry.dart';

/// Harness: a swarm of terminal panes in one window. Everything before the
/// first frame, and every screen up to sign-in, is [startHarness]; only the
/// signed-in workspace and the frame around the app differ, picked at compile
/// time — a browser build gets the mouse-first `lib/web/` composition under
/// its store bar, native builds never compile it.
/// `../mobile` mounts a phone shell into its own vendored copy of
/// [startHarness] rather than depending on this package.
Future<void> main() {
  HarnessWidgetsBinding();
  return startHarness(
    authenticatedScreen: authenticatedWorkspace,
    frame: appFrame,
    transportPlugins: terminalTransportPlugins,
  );
}
