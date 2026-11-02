import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/super_tabs/project_status_card.dart';
import 'package:harness/super_tabs/reading.dart';
import 'package:harness/super_tabs/roster.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

const _ids = ['m1', 'm2', 'm3', 'm4', 'm5'];

/// The chat, the roster, the Status card and the machines list on one screen,
/// over a Swarm of five machines, counting what each rebuilds.
class _Screen {
  _Screen(this.tester);
  final WidgetTester tester;
  final server = ConversationServer();
  late final SuperTabController c;
  final rebuilt = <Type, int>{};
  final rows = <String, int>{};
  int machineCalls = 0;
  ValueNotifier<bool>? collapsed;

  static int _at() => clock.now().millisecondsSinceEpoch;

  Map<String, dynamic> machine(String id) => (server.state['machines'] as List)
      .cast<Map<String, dynamic>>()
      .firstWhere((m) => m['machineId'] == id);

  Future<void> show({bool ticks = false, bool collapse = false}) async {
    server.append('Hello');
    server.state['machines'] = [
      for (final id in _ids)
        {
          'machineId': id,
          'name': id,
          'contributorId': 'owner',
          'maxAgents': 4,
          'observation': {
            'receivedAt': _at(),
            'resources': {'cpuPercent': 1},
          },
        },
    ];
    c = SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      request: server.request,
      save: server.save,
      reading: SuperTabReading.desktop,
    )..start();
    await tester.pump();
    await tester.pump();
    c.pushUntil = clock.now().add(kSwarmPushLease);
    collapsed = ValueNotifier(collapse);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: Row(
            children: [
              Expanded(
                child: SuperTabView(
                  controller: c,
                  onInvite: () {},
                  onAddAgent: (_) {},
                  onOpenTerminal: (_) {},
                  machineName: (_) => 'Team Mac',
                ),
              ),
              SizedBox(
                width: 300,
                child: Column(
                  children: [
                    Expanded(
                      child: SuperTabRoster(
                        controller: c,
                        onInvite: () {},
                        onAddAgent: (_) {},
                        onOpenAgent: (_) {},
                        onAnswer: (_) {},
                      ),
                    ),
                    SuperTabProjectStatusCard(
                      controller: c,
                      projectId: c.snapshot?.projects.firstOrNull?.id ?? 'p',
                    ),
                    Expanded(
                      child: ValueListenableBuilder(
                        valueListenable: collapsed!,
                        builder: (context, shut, _) => SuperTabMachines(
                          controller: c,
                          onAddAgent: (_) {},
                          collapsed: shut,
                          ticks: ticks,
                          now: () {
                            machineCalls++;
                            return clock.now();
                          },
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 3));
    debugOnRebuildDirtyWidget = _count;
    addTearDown(() => debugOnRebuildDirtyWidget = null);
    rebuilt.clear();
    rows.clear();
    machineCalls = 0;
  }

  void _count(Element element, bool _) {
    final key = element.widget.key;
    if (key is ValueKey<String> && key.value.startsWith('super-machine-row-')) {
      rows.update(key.value.substring(18), (n) => n + 1, ifAbsent: () => 1);
    }
    void bump(Type type) =>
        rebuilt.update(type, (n) => n + 1, ifAbsent: () => 1);
    for (final type in const [
      SuperTabView,
      SuperTabRoster,
      SuperTabProjectStatusCard,
      SuperTabMachines,
    ]) {
      if (element.widget.runtimeType == type) bump(type);
    }
    element.visitAncestorElements((up) {
      final type = up.widget.runtimeType;
      if (type == SuperTabView ||
          type == SuperTabRoster ||
          type == SuperTabProjectStatusCard ||
          type == SuperTabMachines) {
        bump(type);
        return false;
      }
      return true;
    });
  }

  Future<void> beat(String id) async {
    machine(id)['observation'] = {
      'receivedAt': _at(),
      'resources': {'cpuPercent': _at() % 97},
    };
    c.told(main: false, at: _at());
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
  }

  Future<void> close() async {
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  }
}

void main() {
  testWidgets(
    'a minute of heartbeats rebuilds no chat, roster or Status card',
    (tester) async {
      final s = _Screen(tester);
      await s.show();
      // What a minute with no report rebuilds anyway (the roster's own clock):
      // a heartbeat adds nothing to it.
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(seconds: 3));
      }
      final quiet = Map.of(s.rebuilt);
      s.rebuilt.clear();
      for (var i = 0; i < 20; i++) {
        await s.beat(_ids[i % 5]);
      }
      // ignore: avoid_print
      print(
        'COUNT rebuilt elements: quiet minute $quiet, heartbeats ${s.rebuilt}',
      );
      for (final type in const [
        SuperTabView,
        SuperTabRoster,
        SuperTabProjectStatusCard,
      ]) {
        expect(s.rebuilt[type] ?? 0, lessThanOrEqualTo(quiet[type] ?? 0));
      }
      await s.close();
    },
  );

  testWidgets('a machine\'s report redraws its own row alone', (tester) async {
    final s = _Screen(tester);
    await s.show();
    await s.beat('m2');
    expect(s.rows.keys, ['m2']);
    await s.close();
  });

  group('the machines list\'s one-second timer', () {
    testWidgets('runs while it shows, redrawing nothing if nothing changed', (
      tester,
    ) async {
      final s = _Screen(tester);
      await s.show(ticks: true);
      await tester.pump(const Duration(seconds: 5));
      expect(s.machineCalls, greaterThan(0));
      expect(s.rows, isEmpty);
      await s.close();
    });

    testWidgets('stops while the Swarm is away, and runs again on return', (
      tester,
    ) async {
      final s = _Screen(tester);
      await s.show(ticks: true);
      s.c.away = true;
      await tester.pump();
      s.machineCalls = 0;
      await tester.pump(const Duration(seconds: 5));
      expect(s.machineCalls, 0);
      s.c.away = false;
      await tester.pump(const Duration(seconds: 5));
      expect(s.machineCalls, greaterThan(0));
      await s.close();
    });

    testWidgets('stops while its group is collapsed', (tester) async {
      final s = _Screen(tester);
      await s.show(ticks: true, collapse: true);
      await tester.pump();
      s.machineCalls = 0;
      await tester.pump(const Duration(seconds: 5));
      expect(s.machineCalls, 0);
      await s.close();
    });
  });

  testWidgets('a row says what its machine last reported', (tester) async {
    final s = _Screen(tester);
    await s.show();
    s.machine('m1')['observation'] = <String, dynamic>{
      'receivedAt': clock.now().millisecondsSinceEpoch,
      'resources': {'cpuPercent': 7},
    };
    s.c.told(main: false, at: clock.now().millisecondsSinceEpoch);
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(s.c.snapshot!.pool('m1')!['observation']['resources'], {
      'cpuPercent': 7,
    });
    expect(s.rows['m1'], greaterThan(0));
    await s.close();
  });
}
