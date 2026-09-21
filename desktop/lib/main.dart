
import 'app_shell.dart';
import 'screens/swarm_screen.dart';

/// Harness for macOS, Linux and Windows: a swarm of terminal panes in one
/// window. Everything before the first frame, and every screen up to sign-in,
/// is [startHarness]. `../mobile` mounts a phone shell into its own vendored
/// copy of that function rather than depending on this package.
Future<void> main() => startHarness(
  authenticatedScreen: (app) => SwarmScreen(notifier: app),
);
