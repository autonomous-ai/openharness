import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/harness_resources.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_monitor.dart';
import 'package:harness/state/harness_sessions.dart';
import 'package:harness/widgets/workspace_harness_resources.dart';

class _App extends AppNotifier {
  _App()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
  final values = <String, MachineHarnessResources>{};
  final requests = <String>[];

  void machine(
    String id,
    List<Agent> agents, {
    bool shared = false,
    bool online = true,
  }) {
    machineStates[id] =
        MachineState(
            Machine(
              machineId: id,
              authMode: MachineAuthMode.remote,
              isShared: shared,
            ),
          )
          ..agents = agents
          ..nodeOnline = online
          ..connectionStatus = ConnectionStatus.connected;
  }

  @override
  Future<MachineHarnessResources?> readHarnessResources(String id) async {
    requests.add(id);
    return values[id];
  }

  void changed() => notifyListeners();
}

class _Monitor extends HarnessMonitor {
  _Monitor(super.app, {super.now});
  int inventoryReads = 0;
  @override
  List<HarnessSession> get sessions {
    inventoryReads++;
    return super.sessions;
  }
}

const _live = Agent(id: 'a', name: 'Work', terminalAvailable: true);
MachineHarnessResources _resources(
  Map<String, HarnessResources> agents, {
  List<(Set<String>, HarnessResources)> shared = const [],
}) => MachineHarnessResources(
  sampledAt: DateTime(2026, 10, 2),
  agents: agents,
  shared: shared,
);

void main() {
  test('the footer count never samples resources, including refresh and foreground updates', () async {
    final app = _App()..machine('m', [_live]);
    final monitor = HarnessMonitor(app, sampleResources: false)..start();
    addTearDown(monitor.dispose);
    addTearDown(app.dispose);
    await monitor.refresh();
    app.changed();
    expect(monitor.label, 'Harnesses 1');
    expect(monitor.detail, contains('Click to open Harness Monitor'));
    expect(app.requests, isEmpty);
  });
  test('one snapshot preserves partial totals, shared servers, machine scope and nested storage', () async {
    final app = _App();
    final monitor = _Monitor(app);
    addTearDown(monitor.dispose);
    addTearDown(app.dispose);
    app.machine('m', [
      _live,
      const Agent(id: 'b', name: 'Other', terminalAvailable: true),
      const Agent(id: 'starting', name: 'Starting', launchState: 'starting'),
      const Agent(id: 'saved', name: 'Saved', status: 'stopped'),
    ]);
    app.machine('r', [_live]);
    app.machine('shared', [_live], shared: true);
    app.machine('offline', [_live], online: false);
    app.values['m'] = _resources(
      {
        'a': const HarnessResources(
          memoryBytes: 1e9,
          cpuPercent: 125.5,
          gpuPercent: 20,
          workspaceBytes: 1.4e9,
          workspacePath: '/project',
        ),
        'b': const HarnessResources(
          memoryBytes: .2e9,
          cpuPercent: 0,
          gpuPercent: 0,
          workspaceBytes: .4e9,
          workspacePath: '/project/child',
        ),
        'starting': const HarnessResources(memoryBytes: 90e9, cpuPercent: 900),
        'saved': const HarnessResources(memoryBytes: 90e9, cpuPercent: 900),
      },
      shared: [
        (
          {'a', 'b'},
          const HarnessResources(memoryBytes: .4e9, cpuPercent: 4.5),
        ),
        ({'saved'}, const HarnessResources(memoryBytes: 90e9, cpuPercent: 900)),
      ],
    );
    app.values['r'] = _resources(
      {
        'a': const HarnessResources(
          memoryBytes: 3e9,
          cpuPercent: 0,
          gpuPercent: 5,
          workspaceBytes: 2e9,
          workspacePath: '/project',
        ),
      },
      shared: [
        ({'a'}, const HarnessResources()),
      ],
    );
    await monitor.refresh();
    expect(app.requests, ['m', 'r']);
    monitor.inventoryReads = 0;
    final summary = monitor.summary;
    expect(summary.label, 'Harnesses 4');
    expect(summary.metricsLabel(), 'CPU 130%   RAM 5 GB   GPU 25%   SSD 3 GB');
    expect(
      summary.metricsLabel(storage: false),
      'CPU 130%   RAM 5 GB   GPU 25%',
    );
    expect(
      summary.metricsLabel(gpu: false, storage: false),
      'CPU 130%   RAM 5 GB',
    );
    expect(
      summary.metricsLabel(ram: false, gpu: false, storage: false),
      'CPU 130%',
    );
    expect(summary.sharedLabel, 'Shared Codex servers · 400 MB+ RAM');
    expect(summary.detail, contains('400 MB+ RAM, included once'));
    expect(summary.resourceDetail, contains(summary.metricsLabel()));
    expect(monitor.inventoryReads, 1);
    expect(app.requests, ['m', 'r']);

    // A captured value is coherent, but the next update always reads current scope.
    app.machineStates['m']!.nodeOnline = false;
    app.machineStates['r']!.agents = [];
    expect(summary.label, 'Harnesses 4');
    final empty = monitor.summary;
    expect(empty.label, 'Harnesses 0');
    expect(empty.metricsLabel(), 'CPU 0%   RAM 0 MB   GPU 0%   SSD 0 MB');
    expect(empty.sharedLabel, isNull);
  });

  test(
    'expired and replaced-machine readings never enter a new summary',
    () async {
      var now = DateTime(2026, 10, 2, 12);
      final app = _App()..machine('m', [_live]);
      final monitor = _Monitor(app, now: () => now);
      addTearDown(monitor.dispose);
      addTearDown(app.dispose);
      app.values['m'] = _resources(
        {'a': const HarnessResources(memoryBytes: 1e9, cpuPercent: 2)},
        shared: [
          ({'a'}, const HarnessResources(memoryBytes: .4e9)),
        ],
      );
      await monitor.refresh();
      final original = monitor.summary;
      expect(original.metricsLabel(), 'CPU 2%   RAM 1 GB   GPU —   SSD —');
      now = now.add(const Duration(seconds: 46));
      final stale = monitor.summary;
      expect(stale.label, 'Harnesses 1');
      expect(stale.metricsLabel(), 'CPU —   RAM —   GPU —   SSD —');
      expect(stale.sharedLabel, isNull);
      expect(original.metricsLabel(), 'CPU 2%   RAM 1 GB   GPU —   SSD —');
      await monitor.refresh();
      expect(monitor.summary.sharedLabel, isNotNull);
      app.machine('m', [_live]);
      expect(monitor.summary.metricsLabel(), 'CPU —   RAM —   GPU —   SSD —');
      expect(monitor.summary.sharedLabel, isNull);
    },
  );

  testWidgets(
    'responsive footer reuses one summary and refreshes after stopping',
    (tester) async {
      final app = _App()..machine('m', [_live]);
      app.values['m'] = _resources({
        'a': const HarnessResources(memoryBytes: 1e9, cpuPercent: 2),
      });
      final monitor = _Monitor(app)..start();
      await tester.pump();
      for (final width in [600.0, 220.0, 100.0]) {
        monitor.inventoryReads = 0;
        await tester.pumpWidget(
          MaterialApp(
            home: Center(
              child: SizedBox(
                width: width,
                child: WorkspaceHarnessResources(monitor: monitor),
              ),
            ),
          ),
        );
        expect(tester.takeException(), isNull);
        expect(monitor.inventoryReads, 1);
        expect(find.byType(Tooltip), findsWidgets);
        final text = tester
            .widgetList<Text>(find.byType(Text))
            .map((t) => t.data ?? t.textSpan?.toPlainText() ?? '')
            .join();
        expect(text, startsWith('CPU 2%'));
      }
      app.machineStates['m']!.agents = [
        const Agent(id: 'a', name: 'Saved', status: 'stopped'),
      ];
      app.changed();
      await tester.pump();
      final text = tester
          .widgetList<Text>(find.byType(Text))
          .map((t) => t.data ?? t.textSpan?.toPlainText() ?? '')
          .join();
      expect(text, startsWith('CPU 0%'));
      expect(app.requests, ['m']);
      await tester.pumpWidget(const SizedBox());
      monitor.dispose();
      app.dispose();
    },
  );
}
