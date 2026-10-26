import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'claude_scroll/bench.dart';
import 'perf/perf_binding.dart';

/// Claude Code's fullscreen scroll on a real phone, against what a native list
/// does — the rows move exactly as far as the finger, every frame, and stop when
/// it does.
///
/// The production `TerminalView`, set up for Claude Code as `TerminalPanel`
/// sets it up, in a profile build, touched through the device's own dispatch.
/// Behind it either Claude Code faked in the app (`CLAUDE_SCROLL_PROGRAM=fake`,
/// the default: the same every run) or the real one on a Mac
/// (`=live`, through `claude_scroll/claude_bridge.py`). See
/// `integration_test/README.md`.
void main() {
  final binding = PerfBinding()
    ..framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.benchmarkLive;
  final options = ClaudeScrollOptions.fromEnvironment();

  testWidgets('Claude Code scroll on the phone', (tester) async {
    final bench = ClaudeScrollBench(tester, binding, options);
    try {
      await bench.run();
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      bench.dispose();
      binding.reportData = bench.results;
    }
    if (bench.failures.isNotEmpty) {
      fail('Scenarios failed: ${bench.failures}');
    }
  }, timeout: const Timeout(Duration(minutes: 15)));
}
