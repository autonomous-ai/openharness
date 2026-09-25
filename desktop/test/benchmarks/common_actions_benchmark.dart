// Run separately from builds/other tests, with --concurrency=1.
// Real production shortcuts and widgets, synthetic machines; debug CPU elapsed
// time and simulated animation settling are not native keyboard/display latency.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/shortcuts/shortcuts_browser.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/new_harness_form.dart';

import '../keymap_host_test.dart' show MemoryKeymap, key;
import '../keymap_runtime_test.dart' show mount;
import '../support/mixed_agents.dart';
import '../swarm_screen_test.dart' show terminal;
import '../swarm_state_test.dart' show createApp;
import 'swarm_benchmark.dart' show distribution;

void main() {
  testWidgets('common workspace shortcuts and creation fields', (tester) async {
    newHarnessOpensInBox = true;
    addTearDown(() => newHarnessOpensInBox = false);
    final app = createApp();
    seedMixedAgents(app);
    final map = MemoryKeymap();
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    app.adoptSessionForTest(terminal('a1', input));
    await mount(tester, app, map, native: true);

    Future<void> dismiss() async {
      await tester.pump(const Duration(milliseconds: 300));
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pump(const Duration(milliseconds: 300));
    }

    for (final (name, shortcut) in [
      ('cmd_n', LogicalKeyboardKey.keyN),
      ('cmd_p', LogicalKeyboardKey.keyP),
      ('cmd_shift_p', LogicalKeyboardKey.keyP),
      ('cmd_comma', LogicalKeyboardKey.comma),
      ('cmd_slash', LogicalKeyboardKey.slash),
    ]) {
      final times = <int>[];
      for (var i = -5; i < 40; i++) {
        final watch = Stopwatch()..start();
        await key(tester, shortcut, cmd: true, shift: name == 'cmd_shift_p');
        final elapsed = watch.elapsedMicroseconds;
        if (i >= 0) times.add(elapsed);
        if (name == 'cmd_n') {
          expect(find.byType(NewHarnessForm), findsOneWidget);
        } else if (name == 'cmd_p' || name == 'cmd_shift_p') {
          expect(
            find.byKey(const ValueKey('swarm-search-input')),
            findsOneWidget,
          );
        } else if (name == 'cmd_comma') {
          expect(find.byType(SettingsScreen), findsOneWidget);
        } else if (name == 'cmd_slash') {
          expect(find.byType(ShortcutsBrowser), findsOneWidget);
        }
        expect(tester.takeException(), isNull);
        await dismiss();
      }
      debugPrint(
        'COMMON_ACTION_BENCH ${jsonEncode({'kind': 'headless_debug_widget_elapsed', 'operation': name, 'shortcutAndFirstFrame': distribution(times)})}',
      );
    }
    expect(input, isEmpty);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
    map.dispose();
  });
}
