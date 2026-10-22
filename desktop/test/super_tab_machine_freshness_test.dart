import 'dart:async';
import 'dart:ui' show PointerDeviceKind;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/machine_resources.dart';
import 'package:harness/core/models.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/super_tab_fixture.dart';

/// The Machines list as the human approved it (https://claude.ai/artifact/3b4f1ZqbxwSDqL7QKq39S2): a status dot
/// before each name, the age at the end of the metrics line, a tooltip and a label for the row, a pill by the
/// heading, old numbers kept and dimmed — and the readings behind them: how old each is, what the Swarm not being
/// readable does to them, and what this computer reads itself.
void main() {
  final base = DateTime.utc(2026, 10, 22, 12);
  DateTime now = base;
  setUp(() => now = base);

  Map<String, dynamic> contributed(
    String id,
    Duration age, {
    String name = 'Studio Mac',
    DateTime? at,
  }) => {
    'machineId': id,
    'name': name,
    'contributorId': 'owner',
    'observation': {
      'receivedAt': (at ?? base).subtract(age).millisecondsSinceEpoch,
      'resources': {
        'cpuPercent': 20,
        'memoryTotalBytes': 32000000000,
        'memoryUsedBytes': 16000000000,
        'diskTotalBytes': 1000000000000,
        'diskFreeBytes': 500000000000,
      },
      'quotas': [
        {
          'engine': 'codex',
          'known': true,
          'windows': [
            {'name': '5-hour', 'usedPercent': 10},
          ],
        },
      ],
    },
  };

  Future<void> show(
    WidgetTester tester,
    SuperTabController controller, {
    AppNotifier? app,
    Future<MachineResources?> Function(String)? readLocal,
    bool reduceMotion = false,
  }) => tester.pumpWidget(
    MaterialApp(
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: reduceMotion),
        child: child!,
      ),
      home: Scaffold(
        body: SizedBox(
          width: 300,
          height: 600,
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

  Finder rowOf(String id) => find.byKey(ValueKey('super-machine-$id'));
  Finder inRow(String id, Finder finder) =>
      find.descendant(of: rowOf(id), matching: finder);
  SuperTabMachineStatus statusOf(WidgetTester tester, String id) => tester
      .widget<SuperTabMachineDot>(inRow(id, find.byType(SuperTabMachineDot)))
      .status;
  String ageOf(WidgetTester tester, String id) =>
      tester.widget<Text>(find.byKey(ValueKey('super-machine-age-$id'))).data!;
  TextStyle ageStyleOf(WidgetTester tester, String id) =>
      tester.widget<Text>(find.byKey(ValueKey('super-machine-age-$id'))).style!;
  Color? nameInkOf(WidgetTester tester, String id, String name) =>
      tester.widget<Text>(inRow(id, find.text(name))).style?.color;

  /// What a screen reader is told of the row, first: the label, then the row's own words (owner, numbers, allowance).
  String labelOf(WidgetTester tester, String id) =>
      tester.getSemantics(rowOf(id)).label.split('\n').first;
  double dimmest(WidgetTester tester, String id) => tester
      .widgetList<Opacity>(inRow(id, find.byType(Opacity)))
      .map((o) => o.opacity)
      .fold(1.0, (a, b) => a < b ? a : b);
  Finder pill(String text) => find.descendant(
    of: find.byType(SuperTabMachinesPill),
    matching: find.text(text),
  );

  group('the words and the rules', () {
    test('how long ago, as the end of the metrics line says it', () {
      String ago(Duration age) => superTabAgo(age);
      expect(ago(Duration.zero), 'just now');
      expect(ago(const Duration(milliseconds: 900)), 'just now');
      expect(ago(const Duration(seconds: 1)), '1s ago');
      expect(ago(const Duration(seconds: 4)), '4s ago');
      expect(ago(const Duration(seconds: 28)), '28s ago');
      expect(ago(const Duration(seconds: 59)), '59s ago');
      expect(ago(const Duration(seconds: 60)), '1 min ago');
      expect(ago(const Duration(minutes: 3)), '3 min ago');
      expect(ago(const Duration(minutes: 59, seconds: 59)), '59 min ago');
      expect(ago(const Duration(hours: 2)), '2 h ago');
      expect(ago(const Duration(days: 3)), '3 d ago');
    });

    test('and shortest, for the heading pill', () {
      expect(superTabAgoShort(const Duration(seconds: 6)), '6s');
      expect(superTabAgoShort(const Duration(seconds: 70)), '1m');
      expect(superTabAgoShort(const Duration(minutes: 59)), '59m');
      expect(superTabAgoShort(const Duration(hours: 2)), '2h');
      expect(superTabAgoShort(const Duration(days: 3)), '3d');
    });

    test(
      'live under 20 s, late to 35 s, then offline: two named thresholds',
      () {
        expect(kSuperTabMachineLateAfter, const Duration(seconds: 20));
        expect(kSuperTabMachineOfflineAfter, const Duration(seconds: 35));
        SuperTabMachineStatus of(int seconds) =>
            superTabMachineStatus(age: Duration(seconds: seconds));
        expect(of(0), SuperTabMachineStatus.live);
        expect(of(19), SuperTabMachineStatus.live);
        expect(of(20), SuperTabMachineStatus.late);
        expect(of(34), SuperTabMachineStatus.late);
        expect(of(35), SuperTabMachineStatus.offline);
        expect(of(600), SuperTabMachineStatus.offline);
        expect(superTabMachineStatus(age: null), SuperTabMachineStatus.offline);
      },
    );

    test(
      'unknown is not offline, and refreshing waits for the new reading',
      () {
        const old = Duration(minutes: 3);
        expect(
          superTabMachineStatus(age: old, unreachable: true),
          SuperTabMachineStatus.unknown,
        );
        expect(
          superTabMachineStatus(age: null, unreachable: true),
          SuperTabMachineStatus.unknown,
        );
        expect(
          superTabMachineStatus(age: old, refreshing: true),
          SuperTabMachineStatus.refreshing,
        );
        // The Swarm failing is the better news of the two: it answers what the refresh is waiting for.
        expect(
          superTabMachineStatus(age: old, refreshing: true, unreachable: true),
          SuperTabMachineStatus.unknown,
        );
      },
    );

    test('a computer this Desktop is connected to is late, not offline, for an old reading', () {
      const old = Duration(minutes: 3);
      expect(
        superTabMachineStatus(age: old, connected: true),
        SuperTabMachineStatus.late,
      );
      expect(
        superTabMachineStatus(age: Duration.zero, connected: false),
        SuperTabMachineStatus.offline,
      );
      expect(
        superTabMachineStatus(age: const Duration(seconds: 3), connected: true),
        SuperTabMachineStatus.live,
      );
    });

    test('hover and focus say each state in its own words', () {
      String tip(SuperTabMachineStatus s, [Duration? age]) =>
          superTabMachineTip(s, age);
      expect(
        tip(SuperTabMachineStatus.live, const Duration(seconds: 4)),
        'Updated 4s ago',
      );
      expect(
        tip(SuperTabMachineStatus.late, const Duration(seconds: 28)),
        'Updated 28s ago',
      );
      expect(
        tip(SuperTabMachineStatus.offline, const Duration(minutes: 3)),
        'Offline · last seen 3 min ago',
      );
      expect(
        tip(SuperTabMachineStatus.unknown, const Duration(minutes: 1)),
        "Can't reach Harness · data from 1 min ago",
      );
      expect(tip(SuperTabMachineStatus.refreshing), 'Refreshing…');
      expect(tip(SuperTabMachineStatus.offline), 'Offline');
      expect(
        superTabMachineStateLabel(SuperTabMachineStatus.unknown),
        'Status unknown',
      );
    });
  });

  group('a machine that contributes', () {
    testWidgets(
      'live: a green dot, "4s ago", and a tooltip and label that say so',
      (tester) async {
        final server = ConversationServer();
        server.state['machines'] = [
          contributed('m', const Duration(seconds: 4)),
        ];
        final c = server.controller();
        await c.refresh();
        final semantics = tester.ensureSemantics();
        await show(tester, c);

        expect(statusOf(tester, 'm'), SuperTabMachineStatus.live);
        expect(
          find.byKey(const ValueKey('super-machine-state-m-live')),
          findsOneWidget,
        );
        expect(ageOf(tester, 'm'), '4s ago');
        expect(ageStyleOf(tester, 'm').color, isNot(grid.AppPalette.warn));
        // The age is in the metrics line, at its end.
        final age = tester.getRect(
          find.byKey(const ValueKey('super-machine-age-m')),
        );
        final cpu = tester.getRect(inRow('m', find.text('CPU 80%')));
        expect(age.left, greaterThan(cpu.right));
        expect(age.right, tester.getRect(rowOf('m')).right - 16);
        expect(
          ageStyleOf(tester, 'm').fontFeatures,
          contains(const FontFeature.tabularFigures()),
        );
        expect(find.byTooltip('Updated 4s ago'), findsOneWidget);
        expect(labelOf(tester, 'm'), 'Studio Mac, Live, Updated 4s ago');
        expect(dimmest(tester, 'm'), 1);
        expect(
          nameInkOf(tester, 'm', 'Studio Mac'),
          isNot(DesktopChrome.muted),
        );
        expect(pill('Live'), findsOneWidget);

        semantics.dispose();
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets('late: an amber dot and an amber "28s ago"', (tester) async {
      final server = ConversationServer();
      server.state['machines'] = [
        contributed('m', const Duration(seconds: 28)),
      ];
      final c = server.controller();
      await c.refresh();
      final semantics = tester.ensureSemantics();
      await show(tester, c);

      expect(statusOf(tester, 'm'), SuperTabMachineStatus.late);
      expect(ageOf(tester, 'm'), '28s ago');
      expect(ageStyleOf(tester, 'm').color, grid.AppPalette.warn);
      expect(ageStyleOf(tester, 'm').fontWeight, FontWeight.w500);
      expect(find.byTooltip('Updated 28s ago'), findsOneWidget);
      expect(labelOf(tester, 'm'), 'Studio Mac, Late, Updated 28s ago');
      expect(dimmest(tester, 'm'), 1);

      semantics.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets(
      'moves from live to late to offline at 20 s and at the named 35 s, not before',
      (tester) async {
        final server = ConversationServer();
        server.state['machines'] = [contributed('m', Duration.zero)];
        final c = server.controller();
        await c.refresh();
        for (final (seconds, status) in [
          (0, SuperTabMachineStatus.live),
          (19, SuperTabMachineStatus.live),
          (20, SuperTabMachineStatus.late),
          (34, SuperTabMachineStatus.late),
          (35, SuperTabMachineStatus.offline),
          (44, SuperTabMachineStatus.offline),
        ]) {
          now = base.add(Duration(seconds: seconds));
          await show(tester, c);
          expect(statusOf(tester, 'm'), status, reason: '$seconds s');
        }
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets(
      'offline: a hollow ring, a muted name, "3 min ago", and the old numbers kept, dimmed',
      (tester) async {
        final server = ConversationServer();
        server.state['machines'] = [
          contributed('m', const Duration(minutes: 3)),
        ];
        final c = server.controller();
        await c.refresh();
        final semantics = tester.ensureSemantics();
        await show(tester, c);

        expect(statusOf(tester, 'm'), SuperTabMachineStatus.offline);
        expect(ageOf(tester, 'm'), '3 min ago');
        expect(nameInkOf(tester, 'm', 'Studio Mac'), DesktopChrome.muted);
        expect(find.byTooltip('Offline · last seen 3 min ago'), findsOneWidget);
        expect(
          labelOf(tester, 'm'),
          'Studio Mac, Offline, Offline · last seen 3 min ago',
        );
        // Never blanked: the numbers and the allowance are there, at 55%, the age is not.
        expect(inRow('m', find.text('CPU 80%')), findsOneWidget);
        expect(inRow('m', find.text('RAM 16 GB')), findsOneWidget);
        expect(dimmest(tester, 'm'), .55);
        expect(
          find.ancestor(
            of: find.byKey(const ValueKey('super-machine-age-m')),
            matching: find.byType(Opacity),
          ),
          findsNothing,
        );
        expect(pill('Live'), findsOneWidget);

        semantics.dispose();
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets(
      'unknown while the Swarm cannot be read: not offline, its data from a minute ago kept, dimmed',
      (tester) async {
        final server = ConversationServer();
        server.state['machines'] = [
          contributed('m', const Duration(minutes: 1)),
        ];
        final c = server.controller();
        await c.refresh();
        server.failReads = true;
        await c.refresh();
        expect(c.backendUnreachable, isTrue);
        final semantics = tester.ensureSemantics();
        await show(tester, c);

        expect(statusOf(tester, 'm'), SuperTabMachineStatus.unknown);
        expect(
          find.byKey(const ValueKey('super-machine-state-m-unknown')),
          findsOneWidget,
        );
        expect(ageOf(tester, 'm'), '1 min ago');
        expect(nameInkOf(tester, 'm', 'Studio Mac'), DesktopChrome.muted);
        expect(
          find.byTooltip("Can't reach Harness · data from 1 min ago"),
          findsOneWidget,
        );
        expect(find.byTooltip('Offline · last seen 1 min ago'), findsNothing);
        expect(
          labelOf(tester, 'm'),
          "Studio Mac, Status unknown, Can't reach Harness · data from 1 min ago",
        );
        expect(inRow('m', find.text('CPU 80%')), findsOneWidget);
        expect(dimmest(tester, 'm'), .55);

        // Read again, what the machine reports decides again: this one was silent.
        server.failReads = false;
        await c.refresh();
        await show(tester, c);
        expect(statusOf(tester, 'm'), SuperTabMachineStatus.offline);

        semantics.dispose();
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets(
      'a machine that was fresh is unknown, not offline, however long the Swarm stays unreadable',
      (tester) async {
        final server = ConversationServer();
        server.state['machines'] = [
          contributed('m', const Duration(seconds: 3)),
        ];
        final c = server.controller();
        await c.refresh();
        server.failReads = true;
        await c.refresh();
        now = base.add(const Duration(minutes: 10));
        await show(tester, c);
        expect(statusOf(tester, 'm'), SuperTabMachineStatus.unknown);
        expect(ageOf(tester, 'm'), '10 min ago');
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets(
      'refreshing back from the background: grey, "refreshing…", the old numbers dimmed — until the Swarm is read',
      (tester) async {
        final f = SuperTabLaunchFixture();
        f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
        f.connection.server.state['machines'] = [
          contributed('far', const Duration(seconds: 10), name: 'Far Mac'),
        ];
        Completer<void>? gate;
        final c = SuperTabController(
          tabId: tabId,
          accountId: 'owner',
          request: (method, path, {body}) async {
            await gate?.future;
            return f.connection.server.request(method, path, body: body);
          },
          save: f.connection.server.save,
          pollInterval: Duration.zero,
        );
        await c.refresh();
        final semantics = tester.ensureSemantics();
        await show(tester, c, app: f.app, readLocal: (_) async => null);
        expect(statusOf(tester, 'far'), SuperTabMachineStatus.live);

        gate = Completer<void>();
        f.app.foreground.value = false;
        await tester.pump();
        f.app.foreground.value = true;
        await tester.pump();
        await show(tester, c, app: f.app, readLocal: (_) async => null);
        expect(statusOf(tester, 'far'), SuperTabMachineStatus.refreshing);
        expect(ageOf(tester, 'far'), 'refreshing…');
        expect(ageStyleOf(tester, 'far').fontStyle, FontStyle.italic);
        expect(find.byTooltip('Refreshing…'), findsOneWidget);
        expect(labelOf(tester, 'far'), 'Far Mac, Refreshing, Refreshing…');
        expect(inRow('far', find.text('CPU 80%')), findsOneWidget);
        expect(dimmest(tester, 'far'), .55);

        gate.complete();
        await landed(tester);
        await show(tester, c, app: f.app, readLocal: (_) async => null);
        expect(statusOf(tester, 'far'), SuperTabMachineStatus.live);
        expect(ageOf(tester, 'far'), '10s ago');

        semantics.dispose();
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
        f.app.superTabs.dispose();
        await tester.pump();
      },
    );
  });

  group('the heading pill', () {
    testWidgets(
      'says Live while the Swarm is read, and Reconnecting with how long when it is not',
      (tester) async {
        final server = ConversationServer();
        server.state['machines'] = [
          contributed('m', Duration.zero, at: DateTime.now()),
        ];
        final c = server.controller();
        await c.refresh();
        await show(tester, c);
        expect(pill('Live'), findsOneWidget);
        expect(find.byType(SuperTabMachinesPill), findsOneWidget);

        server.failReads = true;
        await c.refresh();
        expect(c.unreachableSince, isNotNull);
        now = c.unreachableSince!.add(const Duration(seconds: 70));
        await show(tester, c);
        expect(pill('Reconnecting · 1m'), findsOneWidget);
        expect(pill('Live'), findsNothing);
        now = c.unreachableSince!.add(const Duration(seconds: 6));
        await show(tester, c);
        expect(pill('Reconnecting · 6s'), findsOneWidget);

        server.failReads = false;
        await c.refresh();
        expect(c.unreachableSince, isNull);
        await show(tester, c);
        expect(pill('Live'), findsOneWidget);
        await tester.pumpWidget(const SizedBox());
      },
    );
  });

  group('how the row asks to be read', () {
    testWidgets('hovering it shows its tooltip', (tester) async {
      final server = ConversationServer();
      server.state['machines'] = [contributed('m', const Duration(seconds: 4))];
      final c = server.controller();
      await c.refresh();
      await show(tester, c);
      expect(find.text('Updated 4s ago'), findsNothing);
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      await mouse.moveTo(tester.getCenter(rowOf('m')));
      await tester.pump(const Duration(milliseconds: 800));
      expect(find.text('Updated 4s ago'), findsOneWidget);
      await mouse.removePointer();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('so does keyboard focus on it', (tester) async {
      final server = ConversationServer();
      server.state['machines'] = [contributed('m', const Duration(minutes: 3))];
      final c = server.controller();
      await c.refresh();
      await show(tester, c);
      expect(find.text('Offline · last seen 3 min ago'), findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 800));
      expect(find.text('Offline · last seen 3 min ago'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('the dot moves, unless the platform asks it not to', () {
    testWidgets('a live dot pings once when a newer reading arrives', (
      tester,
    ) async {
      final server = ConversationServer();
      server.state['machines'] = [
        contributed('m', const Duration(seconds: 10)),
      ];
      final c = server.controller();
      await c.refresh();
      await show(tester, c);
      await tester.pump();
      expect(tester.hasRunningAnimations, isFalse);

      server.state['machines'] = [contributed('m', const Duration(seconds: 2))];
      await c.refresh();
      await show(tester, c);
      expect(tester.hasRunningAnimations, isTrue);
      await tester.pump(const Duration(milliseconds: 1300));
      expect(tester.hasRunningAnimations, isFalse);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('and not with reduced motion', (tester) async {
      final server = ConversationServer();
      server.state['machines'] = [
        contributed('m', const Duration(seconds: 10)),
      ];
      final c = server.controller();
      await c.refresh();
      await show(tester, c, reduceMotion: true);
      server.state['machines'] = [contributed('m', const Duration(seconds: 2))];
      await c.refresh();
      await show(tester, c, reduceMotion: true);
      expect(tester.hasRunningAnimations, isFalse);
      await tester.pumpWidget(const SizedBox());
    });

    for (final reduceMotion in [false, true]) {
      testWidgets(
        'a refreshing dot ${reduceMotion ? 'stays still with reduced motion' : 'breathes'}',
        (tester) async {
          final f = SuperTabLaunchFixture();
          f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
          f.connection.server.state['agents'] = [
            {
              'id': 'agent-m',
              'name': 'Builder',
              'machineId': 'm',
              'harnessId': 'native-m',
              'contributorId': 'owner',
              'configuration': {'engine': 'codex'},
            },
          ];
          final c = await f.app.superTabs.open(tabId);
          await c.refresh();
          final reads = <Completer<MachineResources?>>[];
          Future<MachineResources?> read(String id) {
            final answer = Completer<MachineResources?>();
            reads.add(answer);
            return answer.future;
          }

          await show(
            tester,
            c,
            app: f.app,
            readLocal: read,
            reduceMotion: reduceMotion,
          );
          reads.single.complete(const MachineResources(cpuPercent: 30));
          await landed(tester);
          f.app.foreground.value = false;
          await tester.pump();
          f.app.foreground.value = true;
          await tester.pump();
          expect(statusOf(tester, 'm'), SuperTabMachineStatus.refreshing);
          await tester.pump(const Duration(milliseconds: 100));
          expect(tester.hasRunningAnimations, !reduceMotion);

          reads.last.complete(const MachineResources(cpuPercent: 30));
          await landed(tester);
          await tester.pumpWidget(const SizedBox());
          await c.flush();
          f.app.superTabs.dispose();
          await tester.pump();
        },
      );
    }
  });

  group('the computer this Desktop reads itself', () {
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

    Future<void> done(
      WidgetTester tester,
      SuperTabLaunchFixture f,
      SuperTabController c,
    ) async {
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    }

    testWidgets(
      'keeps its last sample on coming back, as refreshing and dimmed, until the new read lands',
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
        expect(inRow('m', find.text('CPU 70%')), findsOneWidget);
        expect(statusOf(tester, 'm'), SuperTabMachineStatus.live);
        expect(ageOf(tester, 'm'), 'just now');

        // Away for a while, then back: the numbers stay, dimmed, and the row says it is refreshing.
        now = base.add(const Duration(seconds: 50));
        f.app.foreground.value = false;
        await tester.pump();
        f.app.foreground.value = true;
        await tester.pump();
        expect(reads, hasLength(2));
        expect(statusOf(tester, 'm'), SuperTabMachineStatus.refreshing);
        expect(ageOf(tester, 'm'), 'refreshing…');
        expect(inRow('m', find.text('CPU 70%')), findsOneWidget);
        expect(dimmest(tester, 'm'), .55);

        reads.last.complete(cpu(90));
        await landed(tester);
        expect(inRow('m', find.text('CPU 10%')), findsOneWidget);
        expect(inRow('m', find.text('CPU 70%')), findsNothing);
        expect(statusOf(tester, 'm'), SuperTabMachineStatus.live);
        expect(ageOf(tester, 'm'), 'just now');
        expect(dimmest(tester, 'm'), 1);

        await done(tester, f, c);
      },
    );

    testWidgets('keeps its last sample, ageing, when a read finds nothing', (
      tester,
    ) async {
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
      now = base.add(const Duration(seconds: 25));
      f.app.foreground.value = false;
      f.app.foreground.value = true;
      await tester.pump();
      reads.last.complete(null);
      await landed(tester);
      // Connected, so late rather than offline; the old number stays, and so does the age.
      expect(inRow('m', find.text('CPU 70%')), findsOneWidget);
      expect(statusOf(tester, 'm'), SuperTabMachineStatus.late);
      expect(ageOf(tester, 'm'), '25s ago');
      now = base.add(const Duration(minutes: 5));
      await show(tester, c, app: f.app, readLocal: read);
      expect(statusOf(tester, 'm'), SuperTabMachineStatus.late);

      await done(tester, f, c);
    });

    testWidgets(
      'is offline, with its numbers dimmed, when its connection is down',
      (tester) async {
        final (f, c) = await local(['m']);
        Future<MachineResources?> read(String id) async => cpu(30);
        await show(tester, c, app: f.app, readLocal: read);
        await landed(tester);
        expect(statusOf(tester, 'm'), SuperTabMachineStatus.live);

        f.app.stateOf('m')!.connectionStatus = ConnectionStatus.disconnected;
        await show(tester, c, app: f.app, readLocal: read);
        expect(statusOf(tester, 'm'), SuperTabMachineStatus.offline);
        expect(inRow('m', find.text('CPU 70%')), findsOneWidget);
        expect(dimmest(tester, 'm'), .55);

        await done(tester, f, c);
      },
    );

    testWidgets('shows each machine as its sample arrives, not when all have', (
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
      expect(inRow('m', find.text('CPU 70%')), findsOneWidget);
      expect(inRow('second', find.textContaining('CPU')), findsNothing);

      reads['second']!.complete(cpu(60));
      await landed(tester);
      expect(inRow('second', find.text('CPU 40%')), findsOneWidget);

      await done(tester, f, c);
    });

    testWidgets(
      'stays live from its own samples while the Swarm cannot be read, when it contributes too',
      (tester) async {
        final f = SuperTabLaunchFixture();
        f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
        f.connection.server.state['machines'] = [
          contributed('m', const Duration(seconds: 80), name: 'This one'),
          contributed('far', const Duration(seconds: 80), name: 'Far Mac'),
        ];
        final c = await f.app.superTabs.open(tabId);
        await c.refresh();
        Future<MachineResources?> read(String id) async => cpu(30);
        f.connection.server.failReads = true;
        await c.refresh();
        expect(c.backendUnreachable, isTrue);

        await show(tester, c, app: f.app, readLocal: read);
        await landed(tester);
        // This computer is read directly: live, and not dimmed. The other is only known through the Swarm.
        expect(statusOf(tester, 'm'), SuperTabMachineStatus.live);
        expect(ageOf(tester, 'm'), 'just now');
        expect(inRow('m', find.text('CPU 70%')), findsOneWidget);
        expect(dimmest(tester, 'm'), 1);
        expect(statusOf(tester, 'far'), SuperTabMachineStatus.unknown);
        expect(find.byType(SuperTabMachinesPill), findsOneWidget);
        expect(pill('Live'), findsNothing);

        await done(tester, f, c);
      },
    );
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
      expect(c.stateReads, 0);
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
