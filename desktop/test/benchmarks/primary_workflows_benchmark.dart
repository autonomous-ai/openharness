// Run alone with --concurrency=1. These are headless debug CPU/event-loop
// timings, including the first Flutter frame, not OS input/display latency.
// HARNESS_PRIMARY_CPU_PROFILE=/private/tmp/primary enables optional profiling
// with --enable-vmservice. HARNESS_PRIMARY_OPERATION selects one operation.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/new_harness_box.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:harness/ws/ws_conn.dart';

import '../keymap_host_test.dart' show MemoryKeymap, key;
import '../keymap_runtime_test.dart' show mount;
import '../support/cpu_profile.dart';
import '../swarm_state_test.dart' show createApp;
import 'swarm_benchmark.dart' show distribution;

class _FixtureConnection extends WsConn {
  _FixtureConnection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final unexpected = <String>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'engines_probe') return {'engines': []};
    if (type == 'dsh_list') return {'dsh': []};
    if (type == 'grid_models_list') return {'models': []};
    if (type == 'fs_list_dir') return {'path': '/fixture', 'entries': []};
    if (type == 'git_project_info') return {'isGit': false};
    unexpected.add(type);
    throw StateError('Unexpected fixture request: $type');
  }
}

void main() {
  for (final (terminals, agents) in [(16, 70), (48, 2000)]) {
    testWidgets('primary workflows with $terminals retained terminals', (
      tester,
    ) async {
      newHarnessOpensInBox = true;
      addTearDown(() => newHarnessOpensInBox = false);
      var terminalInputs = 0;
      final connection = _FixtureConnection();
      final app = createApp(connectionForTest: (_) => connection);
      final machine = app.machineStates['m']!;
      machine.nodeOnline = true;
      machine.agents = [
        for (var i = 0; i < agents; i++)
          Agent(
            id: 'a$i',
            name: 'Harness Task $i',
            engine: 'codex',
            terminalAvailable: true,
          ),
      ];
      final first = app.activeSwarmId;
      for (var tab = 0; tab < terminals ~/ 4; tab++) {
        if (tab > 0) app.newSwarm();
        for (var pane = 0; pane < 4; pane++) {
          final id = 'a${tab * 4 + pane}';
          final session = TerminalSession(
            machineId: 'm',
            agentId: id,
            agentName: 'Harness Task ${tab * 4 + pane}',
            engineId: 'codex',
            send: (_, _) async => true,
            sendBinary: (packet) async {
              if (packet.kind == TerminalBinaryKind.input) terminalInputs++;
              return true;
            },
          )..status = TerminalSessionStatus.controlling;
          session.terminal.write(
            List.generate(1000, (line) => '$line  terminal output\r\n').join(),
          );
          app.adoptSessionForTest(session);
        }
      }
      app.selectSwarm(first);
      final map = MemoryKeymap();
      const channel = MethodChannel('harness/swarm_tabs');
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        (_) async => null,
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      await mount(tester, app, map, native: true);
      // Retain every terminal before timing the main workflows.
      for (final tab in app.swarms.toList()) {
        app.selectSwarm(tab.id);
        await tester.pump();
      }
      app.selectSwarm(first);
      await tester.pumpAndSettle();
      expect(
        find.byType(TerminalPanel, skipOffstage: false),
        findsNWidgets(terminals),
      );

      final only = Platform.environment['HARNESS_PRIMARY_OPERATION'];
      for (final (name, shortcut) in [
        ('cmd_n', LogicalKeyboardKey.keyN),
        ('cmd_o', LogicalKeyboardKey.keyO),
        ('cmd_t', LogicalKeyboardKey.keyT),
        ('switch_tab', LogicalKeyboardKey.bracketRight),
      ]) {
        if (only != null && name != only) continue;
        final profilePath = Platform.environment['HARNESS_PRIMARY_CPU_PROFILE'];
        final profile = profilePath == null
            ? null
            : await tester.runAsync(BenchmarkCpuProfile.start);
        if (profile != null) {
          addTearDown(() => tester.runAsync(profile.close));
        }
        final times = <int>[];
        var firstMicros = 0;
        final rebuilds = <String, int>{};
        for (var sample = -5; sample < 41; sample++) {
          final before = app.activeSwarmId;
          final tabCount = app.swarms.length;
          if (sample == 0) {
            debugOnRebuildDirtyWidget = (element, _) {
              final type = element.widget.runtimeType.toString();
              rebuilds.update(type, (value) => value + 1, ifAbsent: () => 1);
            };
          }
          final watch = Stopwatch()..start();
          try {
            await key(tester, shortcut, cmd: true, shift: name == 'switch_tab');
          } finally {
            watch.stop();
            debugOnRebuildDirtyWidget = null;
          }
          if (sample == -5) firstMicros = watch.elapsedMicroseconds;
          // The rebuild instrumentation is reported separately from timings.
          if (sample > 0) times.add(watch.elapsedMicroseconds);
          if (name == 'cmd_n') {
            expect(find.byType(NewHarnessBox), findsOneWidget);
          } else if (name == 'cmd_o') {
            expect(
              find.byKey(const ValueKey('swarm-search-input')),
              findsOneWidget,
            );
          } else if (name == 'cmd_t') {
            expect(app.swarms.length, tabCount + 1);
            expect(app.activeSwarmId, isNot(before));
            expect(app.panes, isEmpty);
            expect(
              find.byKey(const ValueKey('workspace-welcome')),
              findsOneWidget,
            );
          } else {
            expect(app.activeSwarmId, isNot(before));
            expect(find.byType(TerminalPanel), findsNWidgets(4));
          }
          expect(tester.takeException(), isNull);
          if (name == 'cmd_n' || name == 'cmd_o') {
            await key(tester, LogicalKeyboardKey.escape);
          } else if (name == 'cmd_t') {
            await key(tester, LogicalKeyboardKey.keyW, cmd: true);
            expect(app.swarms.length, tabCount);
            app.selectSwarm(before);
          }
          await tester.pumpAndSettle();
        }
        if (profile != null) {
          await tester.runAsync(
            () => profile.save('$profilePath-$terminals-$name.json'),
          );
        }
        final mostRebuilt = rebuilds.entries.toList()
          ..sort((a, b) => b.value.compareTo(a.value));
        debugPrint(
          'PRIMARY_WORKFLOW_BENCH ${jsonEncode({'kind': 'headless_debug_widget_elapsed', 'operation': name, 'terminals': terminals, 'discoveredAgents': agents, 'scrollbackRowsPerTerminal': 1000, 'firstAfterFixtureWarmupMs': firstMicros / 1000, 'shortcutAndFirstFrame': distribution(times), 'rebuilds': rebuilds.values.fold(0, (sum, count) => sum + count), 'mostRebuiltWidgets': Map.fromEntries(mostRebuilt.take(12))})}',
        );
      }
      expect(connection.unexpected, isEmpty);
      expect(terminalInputs, 0);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      map.dispose();
    });
  }
}
