import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'perf/perf_binding.dart';
import 'perf/scenarios.dart';

/// The phone app's on-device performance benchmark.
///
/// Production widgets — `TerminalPage`, Find, the mic, the new-agent form —
/// over a synthetic account whose terminals are fed Claude Code-shaped output
/// through the production binary path, in a profile build on a real phone.
/// Every frame is timed by the engine ([FrameTiming]); every interaction is
/// timed from its framework dispatch to the raster finish of the first frame
/// that shows its verified result.
///
/// Run it with `flutter drive` — see `integration_test/README.md`. Results go
/// back to the host through the binding's `reportData`, and
/// `test_driver/perf_driver.dart` writes them under `docs/performance/`.
void main() {
  final binding = PerfBinding()
    ..framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.benchmarkLive;
  final options = PerfOptions.fromEnvironment();

  testWidgets('phone performance baseline', (tester) async {
    final suite = PerfSuite(tester, binding, options);
    try {
      await suite.run();
    } finally {
      // Unmounted first: the pages still listen to what is being disposed.
      await tester.pumpWidget(const SizedBox.shrink());
      suite.fixture.dispose();
    }
    if (suite.failures.isNotEmpty) {
      fail('Scenarios failed: ${suite.failures.keys.join(', ')}');
    }
  }, timeout: const Timeout(Duration(minutes: 20)));
}
