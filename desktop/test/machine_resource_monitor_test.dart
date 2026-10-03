import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/machine_resources.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/machine_resource_monitor.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/widgets/workspace_machine_resources.dart';

import 'support/real_fonts.dart';

class _App extends AppNotifier {
  _App()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    for (final (id, name) in [
      ('m', 'M2'),
      ('o', 'office'),
      ('r', '4090 Rig'),
    ]) {
      machineStates[id] =
          MachineState(
              Machine(
                machineId: id,
                name: name,
                authMode: MachineAuthMode.remote,
              ),
            )
            ..nodeOnline = true
            ..connectionStatus = ConnectionStatus.connected;
    }
    machineStates['shared'] = MachineState(
      const Machine(
        machineId: 'shared',
        name: 'Shared',
        isShared: true,
        authMode: MachineAuthMode.remote,
      ),
    )..connectionStatus = ConnectionStatus.connected;
    selectedMachineId = 'm';
    machineStates['m']!.localOnly = true;
  }
  final calls = <String>[];
  final values = <String, MachineResources?>{
    'm': const MachineResources(
      cpuPercent: 20,
      memoryUsedBytes: 16000000000,
      memoryTotalBytes: 32000000000,
      memoryPressure: 'normal',
      swapUsedBytes: 0,
      diskFreeBytes: 320000000000,
      diskTotalBytes: 500000000000,
      gpus: [
        MachineGpu(id: 'apple', name: 'Apple GPU', utilizationPercent: 10),
      ],
    ),
    'o': const MachineResources(
      cpuPercent: 35,
      memoryUsedBytes: 48000000000,
      memoryTotalBytes: 64000000000,
    ),
    'r': const MachineResources(
      cpuPercent: 40,
      memoryUsedBytes: 32000000000,
      memoryTotalBytes: 64000000000,
      gpus: [
        MachineGpu(id: 'a', name: 'RTX 4090 #1', utilizationPercent: 80),
        MachineGpu(id: 'b', name: 'RTX 4090 #2', utilizationPercent: 60),
      ],
    ),
  };
  Completer<MachineResources?>? pending;
  @override
  Future<MachineResources?> readMachineResources(String machineId) async {
    calls.add(machineId);
    return pending?.future ?? values[machineId];
  }

  void changed() => notifyListeners();
}

void main() {
  setUpAll(() async {
    if (Platform.environment['HARNESS_WORKSPACE_CONTROLS_CAPTURE_DIR'] !=
        null) {
      await loadRealFonts();
    }
  });

  testWidgets(
    'local hardware stays fixed when focus and selection move to remote harnesses',
    (tester) async {
      final app = _App();
      final monitor = MachineResourceMonitor(app);
      app.activeSwarm.panes.addAll([
        TerminalPane(id: 1, machineId: 'm', agentId: 'a'),
        TerminalPane(id: 2, machineId: 'o', agentId: 'b'),
        TerminalPane(id: 3, machineId: 'r', agentId: 'c'),
      ]);
      app.focusedPaneId = 2;
      monitor.start();
      await tester.pump();
      expect(monitor.scopeName, 'M2');
      expect(monitor.label, 'CPU 20%   RAM 50%   GPU 10%');
      expect(monitor.detail, startsWith('M2  CPU 20%'));
      app.focusedPaneId = 2;
      app.selectedMachineId = 'o';
      app.changed();
      await tester.pump();
      expect(monitor.scopeName, 'M2');
      expect(monitor.label, 'CPU 20%   RAM 50%   GPU 10%');
      app.focusedPaneId = 3;
      app.changed();
      await tester.pump();
      expect(
        monitor.reading(monitor.localMachine)!.busiestGpu!.utilizationPercent,
        10,
      );
      expect(app.focusedPaneId, 3);
      app.focusedPaneId = 1;
      app.changed();
      await tester.pump();
      expect(monitor.scopeName, 'M2');
      expect(app.calls, ['m']);
      expect(app.allPanes, hasLength(3));
      app.machineStates.remove('m');
      app.changed();
      await tester.pump();
      expect(monitor.localMachine, isNull);
      expect(monitor.label, 'CPU -   RAM -   GPU -');
      monitor.dispose();
      app.dispose();
    },
  );

  testWidgets(
    'polls only the local host every 15 seconds and stops while hidden',
    (tester) async {
      final app = _App();
      final monitor = MachineResourceMonitor(app)..start();
      await tester.pump();
      expect(app.calls, ['m']);
      await tester.pump(const Duration(seconds: 14));
      expect(app.calls, ['m']);
      await tester.pump(const Duration(seconds: 1));
      expect(app.calls, ['m', 'm']);
      await tester.pump(const Duration(seconds: 15));
      expect(app.calls, ['m', 'm', 'm']);
      app.appLifecycleChanged(AppLifecycleState.hidden);
      expect(monitor.reading(monitor.localMachine), isNull);
      await tester.pump(const Duration(minutes: 2));
      expect(app.calls, hasLength(3));
      app.appLifecycleChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(app.calls, ['m', 'm', 'm', 'm']);
      final count = app.calls.length;
      await tester.pump(const Duration(seconds: 3));
      expect(app.calls, hasLength(count));
      expect(app.allPanes, isEmpty);
      monitor.dispose();
      await tester.pump(const Duration(minutes: 1));
      expect(app.calls, hasLength(count));
      app.dispose();
    },
  );

  testWidgets(
    'offline, removed and replacement machines cannot retain a stale reading',
    (tester) async {
      final app = _App();
      final monitor = MachineResourceMonitor(app)..start();
      await tester.pump();
      expect(monitor.reading(monitor.localMachine), isNotNull);
      app.machineStates['m']!.connectionStatus = ConnectionStatus.disconnected;
      app.changed();
      await tester.pump();
      expect(monitor.scopeName, 'M2');
      expect(monitor.reading(monitor.localMachine), isNull);
      expect(monitor.detail, contains('Machine disconnected'));
      final before = app.calls.length;
      await monitor.refresh();
      expect(app.calls, hasLength(before));
      app.machineStates['m']!.connectionStatus = ConnectionStatus.connected;
      app.pending = Completer();
      app.changed();
      await tester.pump();
      app.machineStates['m'] = MachineState(app.machineStates['m']!.machine)
        ..localOnly = true
        ..connectionStatus = ConnectionStatus.connected;
      app.pending!.complete(const MachineResources(cpuPercent: 99));
      await tester.pump();
      expect(monitor.reading(monitor.localMachine), isNull);
      app.pending = null;
      app.machineStates.remove('m');
      app.changed();
      await tester.pump();
      expect(monitor.localMachine, isNull);
      monitor.dispose();
      app.dispose();
    },
  );

  testWidgets(
    'footer hides complete groups at narrow widths and retains full details in its tooltip',
    (tester) async {
      final app = _App();
      final monitor = MachineResourceMonitor(app);
      await monitor.refresh();
      addTearDown(monitor.dispose);
      addTearDown(app.dispose);
      for (final width in [500.0, 270.0, 120.0]) {
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Center(
                child: SizedBox(
                  width: width,
                  child: WorkspaceMachineResources(monitor: monitor),
                ),
              ),
            ),
          ),
        );
        await tester.pump();
        expect(tester.takeException(), isNull);
        expect(find.text('M2'), findsNothing);
        expect(
          tester.widget<Tooltip>(find.byType(Tooltip).first).message,
          contains('GPU 10%'),
        );
        final metricText = tester
            .widgetList<Text>(find.byType(Text))
            .map((w) => w.data ?? w.textSpan?.toPlainText() ?? '')
            .join();
        if (width == 500) expect(metricText, contains('GPU'));
        if (width == 120) expect(metricText, 'CPU 20%');
      }
      await tester.pumpWidget(const SizedBox());
    },
  );
}
