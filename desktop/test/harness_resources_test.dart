import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/harness_resources.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/harness_monitor.dart';
import 'package:harness/state/app_state.dart' show MachineState;
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp;

class _Connection extends WsConn {
  _Connection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final calls = <Map<String, dynamic>>[];
  Completer<Map<String, dynamic>>? pending;
  Map<String, dynamic> reply = {
    'harnesses': {
      'sampledAt': '2026-09-30T12:00:00Z',
      'agents': [
        {
          'agentId': 'a0',
          'memoryBytes': 1400000000,
          'cpuPercent': 125.5,
          'processCount': 3,
        },
      ],
    },
  };
  @override
  bool get isReady => true;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    calls.add({'type': type, ...payload});
    return pending?.future ?? reply;
  }
}

void main() {
  test('readings preserve unknown, zero, and multi-core CPU without guessing GPU or disk', () {
    final empty = HarnessResources.fromJson({});
    expect(empty.memoryBytes, isNull);
    expect(empty.cpuPercent, isNull);
    expect(
      HarnessResources.fromJson({'cpuPercent': 125, 'memoryBytes': 0})
          .cpuPercent,
      125,
    );
    expect(formatHarnessMemory(0), '0 MB');
    expect(formatHarnessMemory(1400000000), '1.4 GB');
    for (final invalid in [-1, double.nan, double.infinity, '100']) {
      expect(
        HarnessResources.fromJson({
          'cpuPercent': invalid,
          'memoryBytes': invalid,
        }).memoryBytes,
        isNull,
      );
      expect(
        HarnessResources.fromJson({'cpuPercent': invalid}).cpuPercent,
        isNull,
      );
    }
    expect(MachineHarnessResources.parse({}), isNull);
    expect(
      MachineHarnessResources.parse({'sampledAt': 'bad', 'agents': []}),
      isNull,
    );
  });

  test('shared-server resources contribute once to totals and disappear with their last live session', () async {
    final connection = _Connection();
    final app = createApp(
      connected: true,
      connectionForTest: (_) => connection,
    );
    final monitor = HarnessMonitor(app);
    addTearDown(monitor.dispose);
    addTearDown(app.dispose);
    app.machineStates['m']!.agents = [
      const Agent(id: 'a0', name: 'Work', terminalAvailable: true),
    ];
    (connection.reply['harnesses'] as Map)['shared'] = [
      {
        'kind': 'codex',
        'agentIds': ['a0', 'another-session'],
        'memoryBytes': 600000000,
        'cpuPercent': 4.5,
        'processCount': 2,
      },
    ];
    await monitor.refresh();
    expect(monitor.label, 'Harnesses 1');
    expect(monitor.sharedLabel, 'Shared Codex servers · 600 MB RAM');
    expect(monitor.summary.detail, contains('included once'));
    ((connection.reply['harnesses'] as Map)['shared'] as List).first.remove(
      'memoryBytes',
    );
    await monitor.refresh();
    expect(monitor.sharedLabel, 'Shared Codex servers · — RAM');
    expect(monitor.label, 'Harnesses 1');
    app.machineStates['m']!.agents = [];
    expect(monitor.label, 'Harnesses 0');
    expect(monitor.sharedLabel, isNull);
  });

  test('footer totals round bytes, include shared servers once, and deduplicate storage', () async {
    final connection = _Connection();
    final app = createApp(connected: true, connectionForTest: (_) => connection);
    final monitor = HarnessMonitor(app);
    addTearDown(monitor.dispose);
    addTearDown(app.dispose);
    app.machineStates['m']!.agents = [
      const Agent(id: 'a0', name: 'First', terminalAvailable: true),
      const Agent(id: 'b', name: 'Second', terminalAvailable: true),
    ];
    final data = connection.reply['harnesses'] as Map;
    data['agents'] = [
      {'agentId': 'a0', 'memoryBytes': 10.4e9, 'cpuPercent': 125.5,
       'gpuPercent': 24.4, 'workspaceBytes': 1.4e9, 'workspacePath': '/project'},
      {'agentId': 'b', 'memoryBytes': 0.2e9, 'cpuPercent': 0,
       'gpuPercent': 0, 'workspaceBytes': 0.4e9, 'workspacePath': '/project/child'},
    ];
    data['shared'] = [
      {'kind': 'codex', 'agentIds': ['a0', 'b'], 'memoryBytes': 0.4e9,
       'cpuPercent': 4.5, 'gpuPercent': 0},
    ];
    await monitor.refresh();
    expect(monitor.metricsLabel(), 'CPU 130%   RAM 11 GB   GPU 24%   SSD 1 GB');
    app.machineStates['m']!.agents.add(
      const Agent(id: 'unknown', name: 'Unknown', terminalAvailable: true));
    expect(monitor.metricsLabel(), 'CPU 130%   RAM 11 GB   GPU 24%   SSD 1 GB');
    expect(monitor.resourceDetail, contains('Files remain after stopping'));
  });

  test('footer counts only open owned harnesses and never uses whole-machine totals', () async {
    final connection = _Connection();
    final app = createApp(
      connected: true,
      connectionForTest: (_) => connection,
    );
    final monitor = HarnessMonitor(app);
    addTearDown(monitor.dispose);
    addTearDown(app.dispose);
    app.machineStates['m']!.agents = [
      const Agent(id: 'a0', name: 'Idle', terminalAvailable: true),
      const Agent(id: 'starting', name: 'Starting', launchState: 'starting'),
      const Agent(
        id: 'saved',
        name: 'Saved',
        status: 'stopped',
        terminalAvailable: true,
      ),
      const Agent(id: 'gone', name: 'Exited'),
    ];
    for (final id in ['offline', 'shared']) {
      app.machineStates[id] =
          MachineState(
              Machine(
                machineId: id,
                authMode: MachineAuthMode.remote,
                isShared: id == 'shared',
              ),
            )
            ..nodeOnline = id != 'offline'
            ..connectionStatus = ConnectionStatus.connected
            ..agents = [
              const Agent(id: 'a0', name: 'Elsewhere', terminalAvailable: true),
            ];
    }
    connection.reply = {
      'cpuPercent': 99,
      'memoryBytes': 64e9,
      'gpuPercent': 98,
      'workspaceBytes': 900e9,
      'harnesses': {
        'sampledAt': '2026-10-02T12:00:00Z',
        'agents': [
          {
            'agentId': 'a0',
            'cpuPercent': 5,
            'memoryBytes': 1e9,
            'workspaceBytes': 2e9,
            'workspacePath': '/work',
          },
          for (final id in ['saved', 'gone', 'unregistered'])
            {
              'agentId': id,
              'cpuPercent': 900,
              'memoryBytes': 80e9,
              'gpuPercent': 95,
              'workspaceBytes': 700e9,
              'workspacePath': '/other',
            },
        ],
        'shared': [
          {
            'kind': 'codex',
            'agentIds': ['a0'],
            'cpuPercent': 2,
            'memoryBytes': 0.4e9,
          },
          {
            'kind': 'codex',
            'agentIds': ['saved'],
            'cpuPercent': 900,
            'memoryBytes': 80e9,
            'gpuPercent': 95,
          },
        ],
      },
    };
    await monitor.refresh();
    expect(monitor.live.map((r) => r.agent.id), ['a0', 'starting']);
    expect(monitor.label, 'Harnesses 2');
    expect(monitor.metricsLabel(), 'CPU 7%   RAM 1 GB   GPU —   SSD 2 GB');
    expect(
      monitor.resourceDetail,
      contains('Totals cover these harnesses only'),
    );
    expect(monitor.resourceDetail, contains('supported macOS and Linux NVIDIA'));
    expect(connection.calls, [
      {'type': 'machine_resources', 'harnesses': true, 'storage': true},
    ]);

    app.machineStates['m']!.agents = [
      const Agent(id: 'a0', name: 'Closed', status: 'stopped'),
    ];
    expect(monitor.label, 'Harnesses 0');
    expect(monitor.metricsLabel(), 'CPU 0%   RAM 0 MB   GPU 0%   SSD 0 MB');
    expect(monitor.sharedReadings, isEmpty);

    app.machineStates['m']!.agents = [
      const Agent(id: 'a0', name: 'Reopened', terminalAvailable: true),
    ];
    connection.reply.remove('harnesses');
    await monitor.refresh();
    expect(monitor.metricsLabel(), 'CPU —   RAM —   GPU —   SSD —');
  });

  testWidgets(
    'uses one machine request for every session; tokens are existing data',
    (tester) async {
      final connection = _Connection();
      final app = createApp(
        connected: true,
        connectionForTest: (_) => connection,
      );
      final monitor = HarnessMonitor(app);
      addTearDown(monitor.dispose);
      addTearDown(app.dispose);
      app.machineStates['m']!.agents = [
        const Agent(
          id: 'a0',
          name: 'Known work',
          terminalAvailable: true,
          tokensUsed: 9200,
        ),
        const Agent(
          id: 'hidden',
          name: 'Background work',
          terminalAvailable: true,
        ),
      ];
      expect(connection.calls, isEmpty);
      expect(
        monitor.live.length,
        2,
      ); // Inventory appears without starting or opening anything.
      await monitor.refresh();
      expect(connection.calls, [
        {'type': 'machine_resources', 'harnesses': true, 'storage': true},
      ]);
      expect(monitor.label, 'Harnesses 2');
      expect(monitor.reading(monitor.live.first)!.processCount, 3);
      expect(app.allPanes, isEmpty);
      connection.reply = {};
      await monitor.refresh();
      expect(monitor.label, 'Harnesses 2');
    },
  );

  testWidgets(
    'samples harness resources for the visible footer and stops while the app is hidden',
    (tester) async {
      final connection = _Connection();
      final app = createApp(
        connected: true,
        connectionForTest: (_) => connection,
      );
      final monitor = HarnessMonitor(app);
      app.machineStates['m']!.agents = [
        const Agent(id: 'a0', name: 'Work', terminalAvailable: true),
      ];
      monitor.start();
      await tester.pump();
      expect(connection.calls, hasLength(1));
      await tester.pump(const Duration(seconds: 15));
      expect(connection.calls, hasLength(2));
      app.appLifecycleChanged(AppLifecycleState.hidden);
      expect(monitor.metricsLabel(), 'CPU —   RAM —   GPU —   SSD —');
      await tester.pump(const Duration(minutes: 2));
      expect(connection.calls, hasLength(2));
      app.appLifecycleChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(connection.calls, hasLength(3));
      await tester.pump(const Duration(seconds: 15));
      expect(connection.calls, hasLength(4));
      monitor.dispose();
      await tester.pump(const Duration(minutes: 2));
      expect(connection.calls, hasLength(4));
      app.dispose();
    },
  );

  testWidgets(
    'late readings cannot populate a replacement or disconnected machine',
    (tester) async {
      final connection = _Connection()..pending = Completer();
      final app = createApp(
        connected: true,
        connectionForTest: (_) => connection,
      );
      final monitor = HarnessMonitor(app);
      addTearDown(monitor.dispose);
      addTearDown(app.dispose);
      final original = app.machineStates['m']!;
      original.agents = [
        const Agent(id: 'a0', name: 'Old', terminalAvailable: true),
      ];
      final pending = monitor.refresh();
      app.machineStates['m'] = MachineState(original.machine)
        ..connectionStatus = ConnectionStatus.connected
        ..agents = [
          const Agent(id: 'a0', name: 'New', terminalAvailable: true),
        ];
      connection.pending!.complete(connection.reply);
      await pending;
      expect(monitor.label, 'Harnesses 1');
      app.machineStates['m']!.connectionStatus = ConnectionStatus.disconnected;
      final before = connection.calls.length;
      await monitor.refresh();
      expect(connection.calls.length, before);
      expect(monitor.label, 'Harnesses 0');
    },
  );
}
