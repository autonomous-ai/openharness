import 'package:harness/core/test_run.dart';
import 'package:integration_test/integration_test.dart';

import '../test/terminal_link_gesture_test.dart' as gestures;
import '../test/terminal_panel_links_test.dart' as links;

/// Exercise the production TerminalPanel in the native renderer. These tests
/// inject Flutter pointer/key events; file reads, downloads and URL launches
/// are fakes. They do not verify physical AppKit modifier-key delivery.
void main() {
  if (!kUnderTest) {
    throw StateError('Native terminal link fixtures require FLUTTER_TEST=1');
  }
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  gestures.main();
  links.main();
}
