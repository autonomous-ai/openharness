import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/machines.dart';

import 'support/super_tab_fixture.dart';

/// Manage → Machines' draw time with crew on every machine (ENGINEERING §4, review of #3232): [_crew] crew members (half
/// asleep) and [_others] other agents on each machine, every row expanded so the details draw too, at today's size
/// (10 machines) and at 10x (100). The same file runs on the code before the crew line and after it, so both draw the
/// same Swarm. Runs only with MACHINE_CREW_BENCH set; prints the median and p95 of [_draws] redraws.
const _crew = 4, _others = 2, _draws = 200;
final _bench = Platform.environment['MACHINE_CREW_BENCH'] != null;

void main() {
  for (final machines in [10, 100]) {
    testWidgets('Manage → Machines draws $machines machines with crew', (
      tester,
    ) async {
      if (!_bench) return;
      // Tall enough that every expanded row is laid out and painted, not only the first screen.
      await tester.binding.setSurfaceSize(Size(1280, machines * 520.0));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = ConversationServer();
      final now = DateTime.now().millisecondsSinceEpoch;
      server.state['machines'] = [
        for (var m = 0; m < machines; m++)
          {
            'machineId': 'm$m',
            'name': 'Mac $m',
            'contributorId': 'owner',
            'scope': 'swarm',
            'cwd': '/swarm',
            'engines': ['claude', 'codex'],
            'maxAgents': 8,
            'paused': false,
            'observation': {
              'receivedAt': now,
              'resources': {
                'cpuPercent': 20,
                'memoryTotalBytes': 64e9,
                'memoryUsedBytes': 20e9,
                'diskFreeBytes': 120e9,
                'diskTotalBytes': 1000e9,
              },
            },
            'teamWork': {'allowed': true},
          },
      ];
      (server.state['agents'] as List).addAll([
        for (var m = 0; m < machines; m++)
          for (var i = 0; i < _crew + _others; i++)
            {
              'id': 'a$m-$i',
              'projectId': 'lead',
              'name': 'Agent $m $i',
              'machineId': 'm$m',
              'harnessId': 'h$m-$i',
              'contributorId': 'owner',
              'configuration': {'engine': 'claude', 'model': 'opus'},
              if (i < _crew) 'crew': {'role': 'Engineer', 'at': 1, 'by': 'o'},
              if (i < _crew && i.isOdd)
                'asleep': {'since': now - (i + 1) * 3600000},
            },
      ]);
      final c = server.controller(account: 'owner');
      await c.refresh();
      for (var m = 0; m < machines; m++) {
        c.toggleMachineExpanded('m$m');
      }
      final redraw = ValueNotifier(0);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ValueListenableBuilder<int>(
              valueListenable: redraw,
              builder: (context, value, _) => SuperTabMachines(
                key: const ValueKey('machines'),
                controller: c,
                manage: true,
                onAddAgent: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final times = <int>[];
      final watch = Stopwatch();
      for (var i = 0; i < _draws; i++) {
        redraw.value++;
        watch
          ..reset()
          ..start();
        await tester.pump();
        watch.stop();
        times.add(watch.elapsedMicroseconds);
      }
      times.sort();
      final median = times[times.length ~/ 2];
      final p95 = times[(times.length * .95).floor()];
      // ignore: avoid_print
      print(
        'MACHINE_CREW_BENCH machines=$machines crew=${machines * _crew} '
        'draws=$_draws median_us=$median p95_us=$p95',
      );
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    });
  }
}
