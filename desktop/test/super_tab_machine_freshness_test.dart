import 'dart:async';
import 'dart:ui' show PointerDeviceKind;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/machine_resources.dart';
import 'package:harness/core/models.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/super_tab_fixture.dart';

/// Machine connection freshness stays independent of disclosure state. Offline,
/// unknown and refreshing rows keep their identity but do not expose old readings.
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

  /// What hovering or focusing the row says: its state and age, then its numbers.
  String tipOf(WidgetTester tester, String id) => tester
      .widget<Tooltip>(
        find.ancestor(of: rowOf(id), matching: find.byType(Tooltip)).first,
      )
      .message!;
  Color? nameInkOf(WidgetTester tester, String id) => tester
      .widget<Text>(find.byKey(ValueKey('super-machine-name-$id')))
      .style
      ?.color;

  /// What a screen reader is told of the row, first: the label, then the row's own words (its agents).
  String labelOf(WidgetTester tester, String id) =>
      tester.getSemantics(rowOf(id)).label.split('\n').first;

  /// The list's own text, which never carries a number or an age.
  Iterable<String> textsOf(String id) => inRow(
    id,
    find.byType(Text),
  ).evaluate().map((e) => (e.widget as Text).data!);
  Finder pill(String text) => find.descendant(
    of: find.byType(SuperTabMachinesPill),
    matching: find.text(text),
  );

  group('the words and the rules', () {
    test('how long ago, as the tooltip of a row says it', () {
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

    test('hover and focus say a state that is not online in its own words, never an age', () {
      // Online says nothing: the dot does. No state says how old its reading is.
      expect(superTabMachineTip(SuperTabMachineStatus.live), isNull);
      expect(superTabMachineTip(SuperTabMachineStatus.late), isNull);
      expect(superTabMachineTip(SuperTabMachineStatus.offline), 'Offline');
      expect(
        superTabMachineTip(SuperTabMachineStatus.unknown),
        "Can't reach Harness",
      );
      expect(
        superTabMachineTip(SuperTabMachineStatus.refreshing),
        'Refreshing…',
      );
      expect(
        superTabMachineStateLabel(SuperTabMachineStatus.unknown),
        'Status unknown',
      );
    });
  });

  group('a machine that contributes', () {
    testWidgets('live: a green dot and current numbers in the tooltip', (
      tester,
    ) async {
      final server = ConversationServer();
      server.state['machines'] = [contributed('m', const Duration(seconds: 4))];
      final c = server.controller();
      await c.refresh();
      final semantics = tester.ensureSemantics();
      await show(tester, c);

      expect(statusOf(tester, 'm'), SuperTabMachineStatus.live);
      expect(
        find.byKey(const ValueKey('super-machine-state-m-live')),
        findsOneWidget,
      );
      const tip =
          'Owned by owner · CPU 80% free · RAM 16 GB free · SSD 500 GB free';
      expect(tipOf(tester, 'm'), tip);
      expect(labelOf(tester, 'm'), 'Studio Mac, Live, $tip');
      // Collapsed: name and owner avatar, with readings reserved for disclosure.
      expect(textsOf('m'), ['~', 'Studio Mac', 'O']);
      expect(nameInkOf(tester, 'm'), isNot(DesktopChrome.muted));
      expect(find.byType(SuperTabMachinesPill), findsNothing);

      semantics.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('late: an amber dot with current readings', (tester) async {
      final server = ConversationServer();
      server.state['machines'] = [
        contributed('m', const Duration(seconds: 28)),
      ];
      final c = server.controller();
      await c.refresh();
      final semantics = tester.ensureSemantics();
      await show(tester, c);

      expect(statusOf(tester, 'm'), SuperTabMachineStatus.late);
      expect(tipOf(tester, 'm'), startsWith('Owned by owner · CPU 80% free'));
      expect(
        labelOf(tester, 'm'),
        startsWith('Studio Mac, Late, Owned by owner'),
      );
      expect(textsOf('m'), ['~', 'Studio Mac', 'O']);

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
      'offline: a direct row with a hollow ring, muted name, and no stale readings',
      (tester) async {
        final server = ConversationServer();
        server.state['machines'] = [
          contributed('m', const Duration(minutes: 3)),
        ];
        final c = server.controller();
        await c.refresh();
        final semantics = tester.ensureSemantics();
        await show(tester, c);
        expect(rowOf('m'), findsOneWidget);
        await tester.tap(find.byKey(const ValueKey('super-machine-m')));
        await tester.pump();
        expect(
          find.byKey(const ValueKey('super-machine-readings-m')),
          findsNothing,
        );

        expect(statusOf(tester, 'm'), SuperTabMachineStatus.offline);
        expect(nameInkOf(tester, 'm'), DesktopChrome.muted);
        // Old capacity and allowances are absent while offline.
        const tip = 'Offline · Owned by owner';
        expect(tipOf(tester, 'm'), tip);
        expect(labelOf(tester, 'm'), 'Studio Mac, Offline, $tip');
        expect(textsOf('m'), ['~', 'Studio Mac', 'O']);
        expect(find.byType(SuperTabMachinesPill), findsNothing);

        // Opened, it stays open: saved with the Swarm's other sidebar state.
        await c.flush();
        final reopened = server.controller(initial: server.saved!);
        expect(reopened.isMachineExpanded('m'), isTrue);
        reopened.dispose();

        semantics.dispose();
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets(
      'unknown while the Swarm cannot be read: not offline, without stale capacity',
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
        expect(nameInkOf(tester, 'm'), DesktopChrome.muted);
        // Not offline, so not under the disclosure.
        expect(
          find.byKey(const ValueKey('super-machines-offline')),
          findsNothing,
        );
        const tip = "Can't reach Harness · Owned by owner";
        expect(tipOf(tester, 'm'), tip);
        expect(labelOf(tester, 'm'), 'Studio Mac, Status unknown, $tip');

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
        expect(
          tipOf(tester, 'm'),
          startsWith("Can't reach Harness · Owned by owner"),
        );
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets(
      'refreshing back from the background hides old numbers until the Swarm is read',
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
        const tip = 'Refreshing… · Owned by owner';
        expect(tipOf(tester, 'far'), tip);
        expect(labelOf(tester, 'far'), 'Far Mac, Refreshing, $tip');
        expect(textsOf('far'), ['~', 'Far Mac', 'O']);

        gate.complete();
        await landed(tester);
        await show(tester, c, app: f.app, readLocal: (_) async => null);
        expect(statusOf(tester, 'far'), SuperTabMachineStatus.live);
        expect(tipOf(tester, 'far'), startsWith('Owned by owner · '));

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
      'is absent while the Swarm is read, and says Reconnecting with how long when it is not',
      (tester) async {
        final server = ConversationServer();
        server.state['machines'] = [
          contributed('m', Duration.zero, at: DateTime.now()),
        ];
        final c = server.controller();
        await c.refresh();
        await show(tester, c);
        expect(find.byType(SuperTabMachinesPill), findsNothing);

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
        expect(find.byType(SuperTabMachinesPill), findsNothing);
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
      const tip =
          'Owned by owner · CPU 80% free · RAM 16 GB free · SSD 500 GB free';
      expect(find.text(tip), findsNothing);
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      await mouse.moveTo(tester.getCenter(rowOf('m')));
      await tester.pump(const Duration(milliseconds: 800));
      expect(find.text(tip), findsOneWidget);
      await mouse.removePointer();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('so does keyboard focus on it', (tester) async {
      final server = ConversationServer();
      server.state['machines'] = [contributed('m', const Duration(minutes: 3))];
      final c = server.controller();
      await c.refresh();
      await show(tester, c);
      const tip = 'Offline · Owned by owner';
      expect(find.text(tip), findsNothing);
      // Focus the machine name; the independent disclosure is next.
      Focus.of(
        tester.element(find.byKey(const ValueKey('super-machine-name-m'))),
      ).requestFocus();
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 800));
      expect(find.text(tip), findsOneWidget);
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
      'hides its last sample on coming back until the new read lands',
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
        expect(
          tipOf(tester, 'm'),
          'Owned by owner · CPU 70% free · RAM 0 MB free',
        );
        expect(statusOf(tester, 'm'), SuperTabMachineStatus.live);

        // Away for a while, then back: hide old numbers while the row is refreshing.
        now = base.add(const Duration(seconds: 50));
        f.app.foreground.value = false;
        await tester.pump();
        f.app.foreground.value = true;
        await tester.pump();
        expect(reads, hasLength(2));
        expect(statusOf(tester, 'm'), SuperTabMachineStatus.refreshing);
        expect(tipOf(tester, 'm'), 'Refreshing… · Owned by owner');

        reads.last.complete(cpu(90));
        await landed(tester);
        expect(statusOf(tester, 'm'), SuperTabMachineStatus.live);
        expect(
          tipOf(tester, 'm'),
          'Owned by owner · CPU 10% free · RAM 0 MB free',
        );

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
      expect(statusOf(tester, 'm'), SuperTabMachineStatus.late);
      expect(
        tipOf(tester, 'm'),
        'Owned by owner · CPU 70% free · RAM 0 MB free',
      );
      now = base.add(const Duration(minutes: 5));
      await show(tester, c, app: f.app, readLocal: read);
      expect(statusOf(tester, 'm'), SuperTabMachineStatus.late);

      await done(tester, f, c);
    });

    testWidgets(
      'is offline without stale numbers when its connection is down',
      (tester) async {
        final (f, c) = await local(['m']);
        Future<MachineResources?> read(String id) async => cpu(30);
        await show(tester, c, app: f.app, readLocal: read);
        await landed(tester);
        expect(statusOf(tester, 'm'), SuperTabMachineStatus.live);

        f.app.stateOf('m')!.connectionStatus = ConnectionStatus.disconnected;
        await show(tester, c, app: f.app, readLocal: read);
        expect(statusOf(tester, 'm'), SuperTabMachineStatus.offline);
        expect(tipOf(tester, 'm'), 'Offline · Owned by owner');

        await done(tester, f, c);
      },
    );

    testWidgets('shows each machine as its sample arrives, not when all have', (
      tester,
    ) async {
      final (f, c) = await local(['m', 'second']);
      // Each machine is visible before its own first sample arrives.
      final reads = <String, Completer<MachineResources?>>{};
      Future<MachineResources?> read(String id) =>
          (reads[id] = Completer<MachineResources?>()).future;

      await show(tester, c, app: f.app, readLocal: read);
      expect(reads.keys, unorderedEquals(['m', 'second']));
      reads['m']!.complete(cpu(30));
      await landed(tester);
      expect(tipOf(tester, 'm'), contains('CPU 70% free'));
      expect(statusOf(tester, 'second'), SuperTabMachineStatus.offline);

      reads['second']!.complete(cpu(60));
      await landed(tester);
      expect(tipOf(tester, 'second'), contains('CPU 40% free'));

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
        expect(tipOf(tester, 'm'), startsWith('Owned by owner · CPU 70% free'));
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
      'records how long a read took, its kind and last change, nothing it said',
      () async {
        final server = ConversationServer();
        server.state['name'] = 'PRIVATE_SWARM_NAME';
        final c = server.controller();
        await c.refresh();
        final read = log.lines.where((l) => l.startsWith('debug swarm')).single;
        expect(
          read,
          matches(
            RegExp(
              r'^debug swarm state read in \d+ ms '
              r'\((first load|changes), last changed \d+\)$',
            ),
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
