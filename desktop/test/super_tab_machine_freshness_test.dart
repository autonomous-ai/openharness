import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/machine_resources.dart';
import 'package:harness/core/models.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/machines.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/super_tab_fixture.dart';

/// How fresh the Swarm's Machines list is, and what it says when it cannot be: the age of each machine's
/// reading, the threshold after which a silent machine is offline, the Swarm's own backend being unreachable
/// (which is not a machine being offline), and the readings this computer takes itself.
void main() {
  final clock = DateTime.utc(2026, 10, 22, 12);
  DateTime now = clock;
  setUp(() => now = clock);

  Map<String, dynamic> contributed(String id, Duration age) => {
    'machineId': id,
    'name': 'Studio Mac',
    'contributorId': 'owner',
    'observation': {
      'receivedAt': clock.subtract(age).millisecondsSinceEpoch,
      'resources': {
        'cpuPercent': 20,
        'memoryTotalBytes': 32000000000,
        'memoryUsedBytes': 16000000000,
        'diskTotalBytes': 1000000000000,
        'diskFreeBytes': 500000000000,
      },
      'quotas': [],
    },
  };

  Future<void> show(
    WidgetTester tester,
    SuperTabController controller, {
    AppNotifier? app,
    Future<MachineResources?> Function(String)? readLocal,
  }) => tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 300,
          height: 500,
          child: SuperTabMachines(
            controller: controller,
            app: app,
            now: () => now,
            readLocal: readLocal,
            onAddAgent: (_) {},
          ),
        ),
      ),
    ),
  );

  /// A read has finished: its continuation runs in the first pump and the frame it asked for is drawn by the second.
  Future<void> landed(WidgetTester tester) async {
    await tester.pump();
    await tester.pump();
  }

  final row = find.byKey(const ValueKey('super-machine-m'));
  Finder inRow(Finder finder) => find.descendant(of: row, matching: finder);
  Finder inRowOf(String id, Finder finder) => find.descendant(
    of: find.byKey(ValueKey('super-machine-$id')),
    matching: finder,
  );

  group('how a reading is aged', () {
    test('says how long ago, in the unit that reads best', () {
      String ago(Duration age) => superTabUpdatedAgo(age);
      expect(ago(Duration.zero), 'Updated just now');
      expect(ago(const Duration(milliseconds: 900)), 'Updated just now');
      expect(ago(const Duration(seconds: 1)), 'Updated 1 s ago');
      expect(ago(const Duration(seconds: 12)), 'Updated 12 s ago');
      expect(ago(const Duration(seconds: 59)), 'Updated 59 s ago');
      expect(ago(const Duration(seconds: 60)), 'Updated 1 min ago');
      expect(
        ago(const Duration(minutes: 59, seconds: 59)),
        'Updated 59 min ago',
      );
      expect(ago(const Duration(hours: 3)), 'Updated 3 h ago');
      expect(ago(const Duration(days: 2)), 'Updated 2 d ago');
      expect(
        superTabUpdatedAgo(const Duration(seconds: 40), stale: true),
        'Updated 40 s ago · stale',
      );
    });

    test('offline is two missed 15 s beats and a margin, named once', () {
      expect(kSuperTabMachineOfflineAfter, const Duration(seconds: 35));
      expect(
        kSuperTabMachineOfflineAfter,
        greaterThan(const Duration(seconds: 30)),
      );
      expect(
        kSuperTabMachineOfflineAfter,
        lessThan(const Duration(seconds: 45)),
      );
    });
  });

  group('a machine that contributes', () {
    testWidgets('shows how old its reading is, and keeps counting', (
      tester,
    ) async {
      final server = ConversationServer();
      server.state['machines'] = [
        contributed('m', const Duration(seconds: 12)),
      ];
      final c = server.controller();
      await c.refresh();
      await show(tester, c);
      expect(inRow(find.text('Updated 12 s ago')), findsOneWidget);
      expect(inRow(find.text('CPU 80%')), findsOneWidget);

      now = clock.add(const Duration(seconds: 20));
      await show(tester, c);
      expect(inRow(find.text('Updated 32 s ago')), findsOneWidget);
      expect(inRow(find.text('CPU 80%')), findsOneWidget);
      expect(inRow(find.byTooltip('Offline')), findsNothing);

      await tester.pumpWidget(const SizedBox());
    });

    testWidgets(
      'is offline once its reading is as old as the named threshold, not before',
      (tester) async {
        final server = ConversationServer();
        final c = server.controller();
        for (final (age, online) in [
          (kSuperTabMachineOfflineAfter - const Duration(seconds: 1), true),
          (kSuperTabMachineOfflineAfter, false),
          (const Duration(seconds: 44), false),
        ]) {
          server.state['machines'] = [contributed('m', age)];
          await c.refresh();
          await show(tester, c);
          expect(
            inRow(find.byTooltip('Offline')),
            online ? findsNothing : findsOneWidget,
            reason: '$age',
          );
          expect(
            inRow(find.textContaining('CPU')),
            online ? findsOneWidget : findsNothing,
            reason: '$age',
          );
          // An offline machine still says when it last reported.
          expect(
            inRow(find.text(superTabUpdatedAgo(age))),
            findsOneWidget,
            reason: '$age',
          );
        }
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets('is not called offline when the Swarm itself cannot be read', (
      tester,
    ) async {
      final server = ConversationServer();
      server.state['machines'] = [
        contributed('m', const Duration(seconds: 80)),
      ];
      final c = server.controller();
      await c.refresh();
      expect(c.backendUnreachable, isFalse);
      await show(tester, c);
      expect(inRow(find.byTooltip('Offline')), findsOneWidget);
      expect(inRow(find.text('Backend unreachable')), findsNothing);

      // The same old reading, but now the Swarm cannot be fetched: the machine may well be fine.
      server.failReads = true;
      await c.refresh();
      expect(c.backendUnreachable, isTrue);
      await show(tester, c);
      await tester.pump();
      expect(inRow(find.text('Backend unreachable')), findsOneWidget);
      expect(inRow(find.byTooltip('Backend unreachable')), findsOneWidget);
      expect(inRow(find.byTooltip('Offline')), findsNothing);
      // The last reading stands, with its age, marked as one that cannot be refreshed.
      expect(inRow(find.text('Updated 1 min ago · stale')), findsOneWidget);
      expect(inRow(find.text('CPU 80%')), findsOneWidget);

      // And once the Swarm is read again, what the machines report decides.
      server.failReads = false;
      await c.refresh();
      expect(c.backendUnreachable, isFalse);
      await show(tester, c);
      await tester.pump();
      expect(inRow(find.byTooltip('Offline')), findsOneWidget);
      expect(inRow(find.text('Backend unreachable')), findsNothing);

      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a fresh machine stays online while the Swarm cannot be read', (
      tester,
    ) async {
      final server = ConversationServer();
      server.state['machines'] = [contributed('m', const Duration(seconds: 3))];
      final c = server.controller();
      await c.refresh();
      server.failReads = true;
      await c.refresh();
      await show(tester, c);
      expect(inRow(find.text('Backend unreachable')), findsOneWidget);
      expect(inRow(find.byTooltip('Offline')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('the readings this computer takes of a machine', () {
    MachineResources cpu(double used) => MachineResources(
      cpuPercent: used,
      memoryTotalBytes: 100,
      memoryUsedBytes: 50,
    );
    Map<String, dynamic> agentOn(String machineId) => {
      'id': 'agent-$machineId',
      'name': 'Builder',
      'machineId': machineId,
      'harnessId': 'native-$machineId',
      'contributorId': 'owner',
      'configuration': {'engine': 'codex'},
    };

    /// A Swarm with an agent on each of [machines], none of them contributed: this computer reads them.
    Future<(SuperTabLaunchFixture, SuperTabController)> local(
      List<String> machines,
    ) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      for (final id in machines.where((id) => id != 'm')) {
        final machine = Machine(
          machineId: id,
          authMode: MachineAuthMode.remote,
          name: 'Second Mac',
        );
        f.app.machines = [...f.app.machines, machine];
        f.app.machineStates[id] = MachineState(machine)
          ..nodeOnline = true
          ..connectionStatus = ConnectionStatus.connected
          ..agentLoadStatus = AgentLoadStatus.loaded;
      }
      f.connection.server.state['agents'] = [
        for (final id in machines) agentOn(id),
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      return (f, c);
    }

    testWidgets(
      'keep the last sample, marked stale, when the app comes back to the front',
      (tester) async {
        final (f, c) = await local(['m']);
        final reads = <Completer<MachineResources?>>[];
        Future<MachineResources?> read(String id) {
          final answer = Completer<MachineResources?>();
          reads.add(answer);
          return answer.future;
        }

        await show(tester, c, app: f.app, readLocal: read);
        reads.single.complete(cpu(30));
        await landed(tester);
        expect(inRow(find.text('CPU 70%')), findsOneWidget);
        expect(inRow(find.text('Updated just now')), findsOneWidget);

        // Away for a while, then back: the numbers stay up, and say they are old, until the new read lands.
        now = clock.add(const Duration(seconds: 50));
        f.app.foreground.value = false;
        await tester.pump();
        f.app.foreground.value = true;
        await tester.pump();
        expect(reads, hasLength(2));
        expect(inRow(find.text('CPU 70%')), findsOneWidget);
        expect(inRow(find.text('Updated 50 s ago · stale')), findsOneWidget);

        reads.last.complete(cpu(90));
        await landed(tester);
        expect(inRow(find.text('CPU 10%')), findsOneWidget);
        expect(inRow(find.text('CPU 70%')), findsNothing);
        expect(inRow(find.text('Updated just now')), findsOneWidget);

        await tester.pumpWidget(const SizedBox());
        await c.flush();
        f.app.superTabs.dispose();
        await tester.pump();
      },
    );

    testWidgets(
      'keep the last sample, marked stale, when a read finds nothing',
      (tester) async {
        final (f, c) = await local(['m']);
        final reads = <Completer<MachineResources?>>[];
        Future<MachineResources?> read(String id) {
          final answer = Completer<MachineResources?>();
          reads.add(answer);
          return answer.future;
        }

        await show(tester, c, app: f.app, readLocal: read);
        reads.single.complete(cpu(30));
        await landed(tester);
        now = clock.add(const Duration(seconds: 10));
        f.app.foreground.value = false;
        f.app.foreground.value = true;
        await tester.pump();
        reads.last.complete(null);
        await landed(tester);
        expect(inRow(find.text('CPU 70%')), findsOneWidget);
        expect(inRow(find.text('Updated 10 s ago · stale')), findsOneWidget);

        await tester.pumpWidget(const SizedBox());
        await c.flush();
        f.app.superTabs.dispose();
        await tester.pump();
      },
    );

    testWidgets('show each machine as its sample arrives, not when all have', (
      tester,
    ) async {
      final (f, c) = await local(['m', 'second']);
      final reads = <String, Completer<MachineResources?>>{};
      Future<MachineResources?> read(String id) =>
          (reads[id] = Completer<MachineResources?>()).future;

      await show(tester, c, app: f.app, readLocal: read);
      expect(reads.keys, unorderedEquals(['m', 'second']));
      reads['m']!.complete(cpu(30));
      await landed(tester);
      expect(inRowOf('m', find.text('CPU 70%')), findsOneWidget);
      expect(inRowOf('second', find.textContaining('CPU')), findsNothing);

      reads['second']!.complete(cpu(60));
      await landed(tester);
      expect(inRowOf('second', find.text('CPU 40%')), findsOneWidget);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    });
  });

  group('the log of each Swarm state read', () {
    late _Log log;
    setUp(() {
      log = _Log();
      final previous = appLog;
      appLog = log;
      addTearDown(() => appLog = previous);
    });

    test(
      'records how long a read took and its revision, nothing it said',
      () async {
        final server = ConversationServer();
        server.state['name'] = 'PRIVATE_SWARM_NAME';
        final c = server.controller();
        await c.refresh();
        final read = log.lines.where((l) => l.startsWith('debug swarm')).single;
        expect(
          read,
          matches(
            RegExp(r'^debug swarm state read in \d+ ms \(revision \d+\)$'),
          ),
        );
        expect(log.lines.join('\n'), isNot(contains('PRIVATE')));
      },
    );

    test('records a failure with how long it took and what kind, not what was said', () async {
      final server = ConversationServer();
      final c = server.controller();
      await c.refresh();
      log.lines.clear();
      server.failReads = true;
      await c.refresh();
      await c.refresh();
      final failures = log.lines
          .where((l) => l.startsWith('warn swarm'))
          .toList();
      expect(failures, hasLength(2));
      expect(
        failures.first,
        matches(
          RegExp(r'^warn swarm state read failed after \d+ ms: StateError$'),
        ),
      );
      expect(failures.join('\n'), isNot(contains('Offline')));
      expect(log.lines.where((l) => l.startsWith('debug swarm')), isEmpty);
    });

    test('names the code and status of a refusal, never its message', () async {
      final c = SuperTabController(
        tabId: tabId,
        accountId: 'owner',
        save: (_) async {},
        request: (method, path, {body}) async => throw const SuperTabFailure(
          'BACKEND_TIMEOUT',
          'PRIVATE refusal text',
          statusCode: 504,
        ),
      );
      addTearDown(c.dispose);
      await c.refresh();
      expect(
        log.lines.single,
        matches(
          RegExp(
            r'^warn swarm state read failed after \d+ ms: BACKEND_TIMEOUT \(status 504\)$',
          ),
        ),
      );
      expect(c.backendUnreachable, isTrue);
    });
  });
}

class _Log implements AppLog {
  final lines = <String>[];

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) => lines.add('${level.name} $category $message');
}
