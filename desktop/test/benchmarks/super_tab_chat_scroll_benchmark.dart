// Run explicitly: flutter test test/benchmarks/super_tab_chat_scroll_benchmark.dart --reporter expanded
// Headless CPU time of one scrolled frame of the Swarm chat (build, layout,
// paint and post-frame work, the day pill's measure included), not display
// latency. Compare runs on the same machine and workload only.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import '../support/super_tab_fixture.dart';
import 'swarm_benchmark.dart' show distribution;

const _updates = [
  'Reading the offline queue before the reconnect.',
  'The reconnect keeps every queued edit in order.',
  'Two devices editing at once settle on the newest edit.',
  'Pushed the branch; the checks are running.',
];

void main() {
  testWidgets('Swarm chat: one scrolled frame, 300 messages over 5 days', (
    tester,
  ) async {
    final server = ConversationServer();
    for (var i = 1; i <= 300; i++) {
      server.append('${_updates[i % _updates.length]} ($i)');
      server.messages.last
        ..['author'] = i.isEven
            ? const {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'}
            : const {'kind': 'person', 'id': 'owner', 'name': 'owner@x.com'}
        // 60 a day, at noon UTC: five local days in every zone.
        ..['createdAt'] = DateTime.utc(
          2026,
          10,
          28 + (i - 1) ~/ 60,
          12,
        ).toIso8601String();
    }
    final c = server.controller();
    await c.refresh();
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final scroll = tester
        .widget<CustomScrollView>(
          find.byWidgetPredicate(
            (w) =>
                w is CustomScrollView &&
                '${(w.key as PageStorageKey?)?.value}'.startsWith(
                  'super-messages-',
                ),
          ),
        )
        .controller!;
    final bottom = scroll.position.pixels;

    // Back and forth over the newest 2400 px, across day lines: the same
    // frames on every run.
    var step = -40.0;
    Future<int> frame() async {
      var next = scroll.position.pixels + step;
      if (next < bottom - 2400 || next > bottom) {
        step = -step;
        next = scroll.position.pixels + step;
      }
      final watch = Stopwatch()..start();
      scroll.jumpTo(next);
      await tester.pump();
      return watch.elapsedMicroseconds;
    }

    for (var i = 0; i < 60; i++) {
      await frame();
    }
    final times = [for (var i = 0; i < 600; i++) await frame()];
    // ignore: avoid_print
    print(
      jsonEncode({
        'benchmark': 'super_tab_chat_scroll_frame',
        'messages': 300,
        ...distribution(times),
      }),
    );

    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  });
}
