import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/test_run.dart';
import 'package:integration_test/integration_test.dart';
import 'package:window_manager/window_manager.dart';

import '../test/desktop_dialog_interaction_test.dart' as interactions;
import '../test/desktop_compact_launch_test.dart' as compact;
import '../test/desktop_history_dialog_test.dart' as history;

/// Exercise creation, search and History in the macOS engine/window.
///
/// Run serially with other native fixtures:
/// FLUTTER_TEST=1 flutter test -d macos --no-pub \
///   integration_test/friendly_desktop_e2e_test.dart
/// If this host throttles background native frames, run all four shards in
/// separate sequential processes with --total-shards=4 --shard-index=0..3.
///
/// The imported fixture mounts the real workspace overlays around in-memory
/// transports, fake terminal sessions, and a memory-only keymap. It never boots
/// the CLI or sends a request to a real machine. Keyboard events and IME values
/// are injected, so this suite does not establish physical AppKit candidate
/// window behavior. Rebuild lib/main.dart afterward for the normal review app.
/// Exhaustive project, async launch, and method-channel scenarios remain in the
/// full widget suite. Each native smoke journey has a 45-second time limit.
void main() {
  if (!kUnderTest) {
    throw StateError('Friendly desktop fixtures require FLUTTER_TEST=1');
  }
  IntegrationTestWidgetsFlutterBinding.ensureInitialized().framePolicy =
      LiveTestWidgetsFlutterBindingFramePolicy.onlyPumps;
  setUpAll(() async {
    await windowManager.ensureInitialized();
    await windowManager.setSize(const Size(1280, 800));
    // Keep this isolated fixture visible while other Harness windows run.
    // macOS can suspend frame delivery for a fully occluded test window.
    await windowManager.setAlwaysOnTop(true);
  });
  tearDownAll(() => windowManager.setAlwaysOnTop(false));
  setUp(() async {
    // Foreground this isolated fixture rather than another running build.
    await windowManager.show();
    await windowManager.focus();
  });
  interactions.main(nativeSmoke: true);
  compact.main(nativeSmoke: true);
  history.main();
}
