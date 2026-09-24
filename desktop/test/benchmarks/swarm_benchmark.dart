// Run explicitly: flutter test test/benchmarks/swarm_benchmark.dart --reporter expanded
// These are headless CPU measurements, not network or display latency claims.
// Optional dock CPU samples: set HARNESS_DOCK_CPU_PROFILE to a temporary file
// prefix and pass --enable-vmservice --name 'command dock widget benchmark'.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_panel.dart';

import '../swarm_screen_test.dart' show mount;
import '../swarm_state_test.dart' show createApp;
import '../keymap_host_test.dart' show key;
import '../support/cpu_profile.dart';

Map<String, num> distribution(List<int> microseconds) {
  microseconds.sort();
  return {
    'samples': microseconds.length,
    'medianMs': microseconds[microseconds.length ~/ 2] / 1000,
    'p95Ms': microseconds[(microseconds.length * 0.95).ceil() - 1] / 1000,
    'p99Ms': microseconds[(microseconds.length * 0.99).ceil() - 1] / 1000,
  };
}

Map<String, num> measure(void Function() operation, {void Function()? setup}) {
  for (var i = 0; i < 20; i++) {
    setup?.call();
    operation();
  }
  final times = <int>[];
  for (var i = 0; i < 100; i++) {
    setup?.call();
    final watch = Stopwatch()..start();
    operation();
    times.add(watch.elapsedMicroseconds);
  }
  return distribution(times);
}

void main() {
  for (final agentCount in [2000, 10000]) {
    testWidgets('command dock widget benchmark with $agentCount harnesses', (
      tester,
    ) async {
      var usedTransport = false;
      final app = createApp(
        connectionForTest: (_) {
          usedTransport = true;
          throw StateError('The offline benchmark must not contact a machine');
        },
      );
      app.machineStates['m']!.agents = [
        for (var i = 0; i < agentCount; i++)
          Agent(
            id: 'a$i',
            name: 'Harness Task $i',
            engine: 'codex',
            terminalAvailable: true,
            project: AgentProject(
              name: 'Project ${i % 50}',
              cwd: '/work/project-${i % 50}',
              branch: 'main',
            ),
          ),
      ];
      app.adoptSessionForTest(
        TerminalSession(
          machineId: 'm',
          agentId: 'a0',
          agentName: 'Harness Task 0',
          engineId: 'codex',
          send: (_, _) async => true,
          sendBinary: (_) async => true,
        )..status = TerminalSessionStatus.controlling,
      );
      await mount(tester, app);
      final field = find.byKey(const ValueKey('swarm-search-input'));
      final profilePath = Platform.environment['HARNESS_DOCK_CPU_PROFILE'];
      final profile = profilePath == null
          ? null
          : await tester.runAsync(BenchmarkCpuProfile.start);
      if (profile != null) {
        addTearDown(() => tester.runAsync(profile.close));
      }
      Future<Map<String, num>> timed(
        Future<void> Function() operation, {
        Future<void> Function()? setup,
      }) async {
        for (var i = 0; i < 8; i++) {
          await setup?.call();
          await operation();
        }
        final samples = <int>[];
        for (var i = 0; i < 50; i++) {
          await setup?.call();
          final watch = Stopwatch()..start();
          await operation();
          samples.add(watch.elapsedMicroseconds);
        }
        return distribution(samples);
      }

      Future<void> type(String query) async {
        await tester.enterText(field, query);
        await tester.pump();
      }

      final reopen = await timed(
        () async {
          await key(tester, LogicalKeyboardKey.keyP, cmd: true);
          await tester.pump();
          expect(field, findsOneWidget);
        },
        setup: () async {
          if (field.evaluate().isNotEmpty) {
            await key(tester, LogicalKeyboardKey.escape);
            await tester.pump();
          }
        },
      );
      final query = await timed(() => type('harness'), setup: () => type(''));
      final queryGrowth = await timed(
        () => type('harness'),
        setup: () => type('harnes'),
      );
      final narrow = await timed(
        () => type('harness 12'),
        setup: () => type('harness'),
      );
      await type('harness');
      final move = await timed(() async {
        await key(tester, LogicalKeyboardKey.arrowUp);
        await tester.pump();
      });
      final retarget = await timed(() async {
        await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
        await tester.pump();
        await key(tester, LogicalKeyboardKey.keyP, cmd: true);
        await tester.pump();
      });
      expect(tester.widget<TextField>(field).controller!.text, 'harness');
      expect(usedTransport, isFalse);
      expect(tester.takeException(), isNull);
      debugPrint(
        'SWARM_BENCH ${jsonEncode({'kind': 'headless_debug_widget_elapsed', 'operation': 'command_dock', 'agents': agentCount, 'reopen': reopen, 'broadQuery': query, 'queryGrowth': queryGrowth, 'narrowQuery': narrow, 'arrow': move, 'cmdShiftPThenCmdP': retarget})}',
      );
      if (profile != null) {
        await tester.runAsync(
          () => profile.save('$profilePath-$agentCount.json'),
        );
      }
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
  }

  for (final sampleText in ['abcd', '界 ']) {
    test(
      'terminal output CPU benchmark for ${sampleText == 'abcd' ? 'ASCII' : 'Unicode'}',
      () async {
        final session = TerminalSession(
          machineId: 'isolated-machine',
          agentId: 'isolated-agent',
          agentName: 'Benchmark',
          engineId: 'codex',
          send: (_, _) async => true,
          sendBinary: (_) async => true,
        )..streamId = 'isolated-stream';
        addTearDown(session.dispose);
        final content = List.filled(31, sampleText).join();
        // Repaint one row so scrollback growth does not change the workload.
        // Each packet is exactly 16 KiB in either case.
        final bytes = utf8.encode(List.filled(128, '\r$content\x1b[K').join());
        var sequence = 0;
        Future<void> output({bool keyframe = false}) => session.handleBinary(
          TerminalBinaryFrame(
            kind: keyframe
                ? TerminalBinaryKind.keyframe
                : TerminalBinaryKind.output,
            streamId: 'isolated-stream',
            seq: sequence++,
            bytes: bytes,
            cols: keyframe ? 160 : null,
            rows: keyframe ? 24 : null,
            compressed: false,
          ),
        );
        expect(bytes, hasLength(16 * 1024));
        await output(keyframe: true);
        for (var warmup = 0; warmup < 20; warmup++) {
          await output();
        }
        final times = <int>[];
        for (var sample = 0; sample < 100; sample++) {
          final watch = Stopwatch()..start();
          await output();
          times.add(watch.elapsedMicroseconds);
        }
        expect(session.status, TerminalSessionStatus.controlling);
        expect(
          session.terminal.buffer.getText(),
          startsWith(content.trimRight()),
        );
        debugPrint(
          'SWARM_BENCH ${jsonEncode({'kind': 'headless_debug_cpu', 'operation': 'terminal_output_decode_and_parse', 'content': sampleText == 'abcd' ? 'ASCII' : 'Unicode', 'bytesPerFrame': bytes.length, 'decodeAndParse': distribution(times)})}',
        );
      },
    );
  }

  test('large live catalog CPU benchmark', () async {
    final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession());
    addTearDown(app.dispose);
    for (var machine = 0; machine < 8; machine++) {
      final id = 'machine-$machine';
      app.machineStates[id] =
          MachineState(
              Machine(
                machineId: id,
                authMode: MachineAuthMode.remote,
                name: 'Machine $machine',
              ),
            )
            ..agents = [
              for (var agent = 0; agent < 250; agent++)
                Agent(
                  id: 'agent-$agent',
                  name: 'Agent $agent',
                  engine: 'codex',
                  terminalAvailable: true,
                  project: AgentProject(
                    name: 'Project ${agent % 50}',
                    cwd: '/work/project-${agent % 50}',
                    remote: 'example.invalid/team/project-${agent % 50}',
                    branch: 'main',
                  ),
                ),
            ];
    }
    expect(swarmAgents(app), hasLength(2000));
    expect(swarmProjects(app, const []), hasLength(50));
    final navigation = swarmDestinations(app);
    expect(navigation, hasLength(2001));
    debugPrint(
      'SWARM_BENCH ${jsonEncode({'kind': 'headless_debug_cpu', 'operation': 'jump_catalog', 'agents': 2000, 'build': measure(() {
        swarmDestinations(app);
      }), 'query': measure(() {
        rankSwarmDestinations(navigation, 'agent 12 machine 3');
      })})}',
    );
    debugPrint(
      'SWARM_BENCH ${jsonEncode({'kind': 'headless_debug_cpu', 'agents': 2000, 'machines': 8, 'search': measure(() {
        swarmAgents(app, 'Agent 12 Project 12');
      }), 'projectGrouping': measure(() {
        swarmProjects(app, const []);
      })})}',
    );
    // Exercise Add agent with all discovered project/machine metadata. Global
    // navigation is measured separately over exact, already-open locations.
    final cache = SwarmSearchCatalog();
    final entries = cache.read(app, const []);
    expect(entries, hasLength(2059));
    final controller = SwarmSearchController(app, const [], adding: true);
    addTearDown(controller.dispose);
    final queries = <String, Object>{};
    for (final query in [
      'agent',
      'agent 12 machine 3',
      'agn12',
      'project 12 main',
      'no-such-agent',
    ]) {
      final timing = measure(
        () => controller.setQuery(query),
        setup: () => controller.setQuery(''),
      );
      queries[query] = {...timing, 'results': controller.rows.length};
    }
    debugPrint(
      'SWARM_BENCH ${jsonEncode({'kind': 'headless_debug_cpu', 'operation': 'add_agent_search', 'agents': 2000, 'machines': 8, 'projects': 50, 'entries': entries.length, 'coldCatalog': measure(() {
        SwarmSearchCatalog().read(app, const []);
      }), 'unchangedCatalog': measure(() {
        cache.read(app, const []);
      }), 'openAndDisposeController': measure(() {
        SwarmSearchController(app, const [], adding: true).dispose();
      }), 'queries': queries})}',
    );
    for (var swarm = 0; swarm < 12; swarm++) {
      if (swarm != 0) app.newSwarm();
      for (var pane = 0; pane < 4; pane++) {
        app.adoptSessionForTest(
          TerminalSession(
            machineId: 'machine-${swarm % 8}',
            agentId: 'agent-${swarm * 4 + pane}',
            agentName: 'Agent ${swarm * 4 + pane}',
            engineId: 'codex',
            send: (_, _) async => true,
            sendBinary: (_) async => true,
          )..status = TerminalSessionStatus.controlling,
        );
      }
      if (swarm == 1 || swarm == 2) {
        await app.addAgentToSwarm('machine-0', 'agent-0');
      }
    }
    final locations = SwarmLocationCatalog();
    final open = locations.read(app, const []);
    expect(open, hasLength(62));
    expect(
      open.where((r) => r.agentId == 'agent-0' && r.machineId == 'machine-0'),
      hasLength(3),
    );
    final navigator = SwarmSearchController(app, const [], navigating: true);
    addTearDown(navigator.dispose);
    debugPrint(
      'SWARM_BENCH ${jsonEncode({'kind': 'headless_debug_cpu', 'operation': 'navigation_locations', 'discoveredAgents': 2000, 'swarms': 12, 'agentLocations': 50, 'entries': open.length, 'coldCatalog': measure(() {
        SwarmLocationCatalog().read(app, const []);
      }), 'unchangedCatalog': measure(() {
        locations.read(app, const []);
      }), 'openAndDisposeController': measure(() {
        SwarmSearchController(app, const [], navigating: true).dispose();
      }), 'query': measure(() {
        navigator.setQuery('agent 0 machine 0');
      }, setup: () => navigator.setQuery(''))})}',
    );
    final history = SwarmNavigationHistory();
    for (final swarm in app.swarms) {
      app.selectSwarm(swarm.id);
      for (final pane in swarm.panes) {
        app.focusPane(pane.id);
        history.record(app);
      }
    }
    expect(history.menuDestinations(app), hasLength(60));
    debugPrint(
      'SWARM_BENCH ${jsonEncode({'kind': 'headless_debug_cpu', 'operation': 'native_history_snapshot', 'discoveredAgents': 2000, 'swarms': 12, 'entries': 60, 'changedFocus': measure(() {
        history.menuDestinations(app);
      }, setup: () {
        app.focusPaneBy(1);
        history.record(app);
      }), 'unchanged': measure(() {
        history.menuDestinations(app);
      })})}',
    );
  });

  for (final scenario in [
    (swarms: 4, native: false),
    (swarms: 12, native: false),
    (swarms: 4, native: true),
    (swarms: 12, native: true),
  ]) {
    final swarmCount = scenario.swarms;
    final chrome = scenario.native ? 'native bridge' : 'Flutter tabs';
    testWidgets(
      'tab-switch CPU benchmark with $swarmCount retained swarms ($chrome)',
      (tester) async {
        final app = createApp();
        app.machineStates['m']!.nodeOnline = true;
        var nativeUpdates = 0;
        if (scenario.native) {
          // Exercise production History and bridge serialization without AppKit.
          // This is still a headless CPU test, not native input/display timing.
          const channel = MethodChannel('harness/swarm_tabs');
          final messenger = tester.binding.defaultBinaryMessenger;
          messenger.setMockMethodCallHandler(channel, (call) async {
            if (call.method == 'update') nativeUpdates++;
            return null;
          });
          addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
          app.machineStates['m']!.agents = [
            for (var i = 0; i < 2000; i++)
              Agent(
                id: 'a$i',
                name: 'Agent a$i',
                engine: 'codex',
                terminalAvailable: true,
                project: AgentProject(
                  name: 'Project ${i % 50}',
                  cwd: '/work/project-${i % 50}',
                  branch: 'main',
                ),
              ),
          ];
        }
        final first = app.activeSwarmId;
        for (var swarm = 0; swarm < swarmCount; swarm++) {
          if (swarm != 0) app.newSwarm();
          for (var pane = 0; pane < 4; pane++) {
            final id = 'a${swarm * 4 + pane}';
            final session =
                TerminalSession(
                    machineId: 'm',
                    agentId: id,
                    agentName: 'Agent $id',
                    engineId: 'codex',
                    send: (_, _) async => true,
                    sendBinary: (_) async => true,
                  )
                  ..status = TerminalSessionStatus.controlling
                  ..streamId = 'stream-$id';
            session.terminal.write(
              List.generate(
                1000,
                (line) =>
                    '\x1b[32m$line\x1b[0m  terminal output with project context\r\n',
              ).join(),
            );
            app.adoptSessionForTest(session);
          }
        }
        app.selectSwarm(first);
        await mount(tester, app, nativeTabs: scenario.native);
        for (var warmup = 0; warmup < swarmCount * 3; warmup++) {
          app.stepSwarm(1);
          await tester.pump();
        }
        final times = <int>[];
        for (var sample = 0; sample < 60; sample++) {
          final watch = Stopwatch()..start();
          app.stepSwarm(1);
          await tester.pump();
          times.add(watch.elapsedMicroseconds);
        }
        expect(find.byType(TerminalPanel), findsNWidgets(4));
        expect(
          find.byType(TerminalPanel, skipOffstage: false),
          findsNWidgets(swarmCount * 4),
        );
        final rebuilds = <String, int>{};
        debugOnRebuildDirtyWidget = (element, _) {
          final type = element.widget.runtimeType.toString();
          rebuilds.update(type, (count) => count + 1, ifAbsent: () => 1);
        };
        try {
          app.stepSwarm(1);
          await tester.pump();
        } finally {
          debugOnRebuildDirtyWidget = null;
        }
        final largest = rebuilds.entries.toList()
          ..sort((a, b) => b.value.compareTo(a.value));
        final focusTimes = <int>[];
        for (var sample = 0; sample < 60; sample++) {
          final watch = Stopwatch()..start();
          app.focusPaneBy(1);
          await tester.pump();
          focusTimes.add(watch.elapsedMicroseconds);
        }
        var focusRebuilds = 0;
        debugOnRebuildDirtyWidget = (_, _) => focusRebuilds++;
        try {
          app.focusPaneBy(1);
          await tester.pump();
        } finally {
          debugOnRebuildDirtyWidget = null;
        }
        if (scenario.native) expect(nativeUpdates, greaterThan(120));
        debugPrint(
          'SWARM_BENCH ${jsonEncode({'kind': 'headless_debug_cpu', 'chrome': scenario.native ? 'native_bridge_stubbed' : 'flutter_tabs', 'discoveredAgents': app.machineStates['m']!.agents.length, 'swarms': swarmCount, 'terminals': swarmCount * 4, 'scrollbackLinesPerTerminal': 1000, 'viewport': '1280x800', 'tabSwitchAndFrame': distribution(times), 'rebuildsPerSwitch': rebuilds.values.fold(0, (total, count) => total + count), 'focusAndFrame': distribution(focusTimes), 'rebuildsPerFocus': focusRebuilds, 'mostRebuiltWidgets': Map.fromEntries(largest.take(12))})}',
        );
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );
  }
}
