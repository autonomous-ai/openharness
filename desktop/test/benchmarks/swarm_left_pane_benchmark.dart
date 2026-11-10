// Run explicitly: flutter test test/benchmarks/swarm_left_pane_benchmark.dart --reporter expanded
// Headless CPU measurements of the Desktop's Swarm left pane (task #4466), not display latency claims. It uses only
// what main's pane had before the redraw, so the same file runs on both sides.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/project_sidebar.dart';

import '../support/super_tab_swarm.dart' show load, swarm;
import '../swarm_state_test.dart' show createApp;

Map<String, num> _distribution(List<int> microseconds) {
  microseconds.sort();
  return {
    'samples': microseconds.length,
    'medianMs': microseconds[microseconds.length ~/ 2] / 1000,
    'p95Ms': microseconds[(microseconds.length * .95).ceil() - 1] / 1000,
  };
}

void main() {
  testWidgets('the Desktop left pane with 40 agents: rebuild and relayout', (
    tester,
  ) async {
    final server = swarm()
      ..state['agents'] = [
        for (var i = 0; i < 40; i++)
          {
            'id': 'agent-$i',
            'projectId': 'lead',
            'name': 'Agent number $i',
            'displayName': 'Agent number $i',
            'machineId': 'host',
            'harnessId': 'session-$i',
            'contributorId': 'owner',
            'configuration': {'engine': 'codex'},
            'kind': i < 8 ? 'pm' : 'regular',
            'myAgent': true,
          },
      ];
    final c = (await tester.runAsync(() => load(server)))!;
    final app = createApp();
    addTearDown(app.dispose);
    await tester.binding.setSurfaceSize(const Size(300, 2400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    var width = 300.0;
    late StateSetter resize;
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, setState) {
              resize = setState;
              return Align(
                alignment: Alignment.topLeft,
                child: SizedBox(
                  width: width,
                  child: ProjectSidebar(
                    controller: c,
                    app: app,
                    onSelect: (_) {},
                    onNewAgent: () {},
                    onNewSwarm: () {},
                    onPage: (_) {},
                    onManage: () {},
                  ),
                ),
              );
            },
          ),
        ),
      ),
    );
    await tester.pump();
    final rebuild = <int>[], relayout = <int>[];
    for (var i = 0; i < 120; i++) {
      final watch = Stopwatch()..start();
      tester.element(find.byType(ProjectSidebar)).markNeedsBuild();
      await tester.pump();
      if (i >= 20) rebuild.add(watch.elapsedMicroseconds);
      watch
        ..reset()
        ..start();
      resize(() => width = i.isEven ? 280 : 300);
      await tester.pump();
      if (i >= 20) relayout.add(watch.elapsedMicroseconds);
    }
    // ignore: avoid_print
    print(
      'SWARM_LEFT_PANE ${jsonEncode({'rebuild': _distribution(rebuild), 'relayout': _distribution(relayout)})}',
    );
    await tester.pumpWidget(const SizedBox());
    await tester.runAsync(c.flush);
  });
}
