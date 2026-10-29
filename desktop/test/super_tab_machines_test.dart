import 'dart:io';
import 'dart:ui' show PointerDeviceKind;

import 'package:flutter/gestures.dart' show kSecondaryMouseButton;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/machine_resources.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/status_line_style.dart';
import 'package:harness/state/harness_activity.dart';
import 'package:harness/widgets/harness_activity_mark.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/super_tabs/controller.dart' show SuperTabFailure;
import 'package:harness/super_tabs/detail_dialog.dart';
import 'package:harness/super_tabs/machine_details.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_icon_button.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/engine_identity.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

/// Model total and free memory separately so a suggestion cannot use free RAM.
MachineResources _reading({required double freeGiB, double totalGiB = 32}) =>
    MachineResources(
      memoryTotalBytes: totalGiB * 1024 * 1024 * 1024,
      memoryUsedBytes: (totalGiB - freeGiB) * 1024 * 1024 * 1024,
    );

/// The machine card's own way into the same form: open the card, then Configure.
Future<void> _openConfigureDialog(
  WidgetTester tester,
  SuperTabLaunchFixture f,
  dynamic c, {
  Future<MachineResources?> Function(String)? readLocal,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 300,
          height: 400,
          child: SuperTabMachines(
            controller: c,
            app: f.app,
            onAddAgent: (_) {},
            readLocal: readLocal,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  final card = find.byKey(const ValueKey('super-machine-m'));
  await openMachineDetails(tester, card);
  await tester.pumpAndSettle();
  await tester.tap(find.widgetWithText(TextButton, 'Configure'));
  await tester.pumpAndSettle();
}

final _picker = find.byKey(const ValueKey('swarm-machine-picker'));

class _RemovalServer extends ConversationServer {
  Map<String, dynamic> preview = {
    'blockedBy': null,
    'agents': <dynamic>[],
    'soleSourceProjects': <dynamic>[],
  };
  final previewReads = <String>[];
  bool failPreview = false;

  @override
  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (method == 'GET' && path.endsWith('/machines/studio/removal')) {
      previewReads.add(path);
      if (failPreview) {
        throw const SuperTabFailure(
          'PREVIEW_UNAVAILABLE',
          'Could not check this machine.',
          statusCode: 503,
        );
      }
      return preview;
    }
    if (method == 'POST' &&
        body?['command'] is Map &&
        (body!['command'] as Map)['type'] == 'machine.remove' &&
        !reject &&
        refuse == null) {
      final row = (state['machines'] as List)
          .cast<Map<String, dynamic>>()
          .singleWhere((machine) => machine['machineId'] == 'studio');
      row['removal'] = {
        'id': 'removal-1',
        'state': 'cleaning',
        'requestedAt': '2026-10-23T00:00:00Z',
      };
      revision++;
    }
    return super.request(method, path, body: body);
  }
}

/// What hovering or focusing a machine row says.
String _tipOf(WidgetTester tester, Finder row) => tester
    .widget<Tooltip>(
      find.ancestor(of: row, matching: find.byType(Tooltip)).first,
    )
    .message!;

/// The words on a machine's line: its name, and its owner's when the name is shared.
String _lineOf(WidgetTester tester, String id) =>
    tester.widget<Text>(find.byKey(ValueKey('super-machine-name-$id'))).data!;

/// Which Agents choice machine settings hold: `memory` or `atMost`.
String? _agentsChoice(WidgetTester tester) => tester
    .widget<RadioGroup<String>>(find.byKey(const ValueKey('machine-agents')))
    .groupValue;

/// The number beside At most in machine settings.
String? _limit(WidgetTester tester) =>
    tester.widget<Text>(find.byKey(const ValueKey('agent-limit-value'))).data;

Finder _limitStep(String direction) =>
    find.byKey(ValueKey('agent-limit-$direction'));

AppIconButton _limitButton(WidgetTester tester, String direction) =>
    tester.widget<AppIconButton>(_limitStep(direction));

/// Saving reads preparation more than once: a new operation answers `preparing`
/// and is only ready from a later read, a second apart — what the real daemon
/// does (`cli/src/superTabs/contribution.ts`), and the fixture with it.
Future<void> _settleSave(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
  }
}

/// A machine's details are in its right-click menu; a click expands it (Dee, 2026-10-27).
Future<void> openMachineDetails(WidgetTester tester, Finder row) async {
  await tester.tap(row, buttons: kSecondaryMouseButton);
  await tester.pumpAndSettle();
  await tester.tap(find.text('Details').last);
  await tester.pumpAndSettle();
}

void main() {
  test('an allowance\'s note names its tightest window and its reset, in either detail format', () {
    // Another machine's reading: the tightest window first.
    expect(
      superMachineAllowanceNote([
        '5-hour: 44% remaining · resets in 2h 10m',
        'Weekly: 80% remaining',
      ]),
      '5-hour limit · resets in 2h 10m',
    );
    // This computer's: the limiting window named, then each window.
    expect(
      superMachineAllowanceNote([
        'Limiting window: Weekly',
        'Read 3 min ago',
        '5-hour — 90% remaining · resets in 1h',
        'Weekly — 62% remaining · resets in 4d',
      ]),
      'Weekly limit · resets in 4d',
    );
    expect(
      superMachineAllowanceNote(['Weekly: 62% remaining']),
      'Weekly limit',
    );
    expect(superMachineAllowanceNote(['Usage unavailable']), isNull);
    expect(superMachineAllowanceNote(const []), isNull);
  });

  final capture = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];
  setUpAll(() => loadCaptureFonts(capture));
  test('a computer is shown by its real hostname without ".local", and a name a person chose stays as it is', () {
    for (final (hostname, shown) in [
      ('MacBookPro2021.local', 'MacBookPro2021'),
      ('MacBooks-MacBook-Pro-19.local', 'MacBooks-MacBook-Pro-19'),
      ('MacbookPro.local', 'MacbookPro'),
      ('Mac-mini.local', 'Mac-mini'),
      ('build-server.LOCAL', 'build-server'),
    ]) {
      expect(superTabMachineName(hostname), shown);
    }
    for (final name in [
      'Ada’s Mac',
      'M2',
      'MacBook Pro lab',
      'Build server',
      'locally.local.test',
      '.local',
    ]) {
      expect(superTabMachineName(name), name);
    }
  });
  testWidgets(
    'machine rows disclose readings separately from details, and offline rows stay visible without stale data',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(280, 700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = ConversationServer();
      final now = DateTime.now().millisecondsSinceEpoch;
      server.state['machines'] = [
        for (final live in [true, false])
          {
            'machineId': live ? 'online' : 'offline',
            'name': live ? 'Studio Mac' : 'M2',
            'contributorId': 'owner',
            'observation': {
              'receivedAt': now - (live ? 0 : 60000),
              'resources': {
                'cpuPercent': 0,
                'memoryTotalBytes': 32000000000,
                'memoryUsedBytes': 32000000000,
                'diskTotalBytes': 1000000000000,
                'diskFreeBytes': 141000000000,
              },
              'quotas': [
                {'engine': 'claude', 'known': false, 'windows': []},
                {
                  'engine': 'codex',
                  'known': true,
                  'windows': [
                    {'name': '5-hour', 'usedPercent': 0},
                  ],
                },
              ],
            },
          },
      ];
      final c = server.controller();
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SuperTabMachines(controller: c, onAddAgent: (_) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final offline = find.byKey(const ValueKey('super-machine-offline'));
      final online = find.byKey(const ValueKey('super-machine-online'));
      expect(find.textContaining('CPU'), findsNothing);
      expect(find.textContaining('GB'), findsNothing);
      expect(find.textContaining('ago'), findsNothing);
      expect(offline, findsOneWidget);
      expect(find.text('Offline · 1'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('super-machine-online')));
      await tester.pumpAndSettle();
      expect(find.byType(SuperTabDetailDialog), findsNothing);
      expect(_hw(tester, 'online', 'CPU'), '0%');
      expect(_hw(tester, 'online', 'RAM'), '0 GB');
      expect(_hw(tester, 'online', 'SSD'), '141 GB');
      expect(
        find.byKey(const ValueKey('super-machine-allowance-online-codex')),
        findsOneWidget,
      );
      expect(
        _tipOf(tester, online),
        'Owned by owner · CPU 100% free · RAM 0 GB free · SSD 141 GB free',
      );
      expect(tester.getSize(online).height, 36);
      // Offline: its state in words, never when it was last seen, and no allowance chip.
      expect(_tipOf(tester, offline), 'Offline · Owned by owner');
      expect(
        find.descendant(of: offline, matching: find.byType(EngineMark)),
        findsNothing,
      );
      expect(
        tester.getTopLeft(offline).dy,
        greaterThan(tester.getTopLeft(online).dy),
      );
      // The entire row expands, from the keyboard too; its details are in the
      // right-click menu.
      Focus.of(tester.element(find.text('Studio Mac'))).requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(c.isMachineExpanded('online'), isFalse);
      await openMachineDetails(tester, online);
      expect(find.text('Available capacity'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(SuperTabMachineDetails),
          matching: find.text('CPU'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byType(SuperTabMachineDetails),
          matching: find.text('100%'),
        ),
        findsOneWidget,
      );
      expect(find.text('0 GB of 32 GB'), findsOneWidget);
      expect(find.text('141 GB of 1000 GB'), findsOneWidget);
      expect(find.textContaining('GPU'), findsNothing);
      expect(find.text('—'), findsNothing);
      expect(find.text('100% left'), findsOneWidget);
      expect(
        tester
            .widget<EngineMark>(
              find.descendant(
                of: find.byType(SuperTabDetailDialog),
                matching: find.byType(EngineMark),
              ),
            )
            .engine,
        'codex',
      );
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      await openMachineDetails(tester, offline);
      await tester.pumpAndSettle();
      expect(find.byType(SuperTabDetailDialog), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(DesktopDialogHeader),
          matching: find.text('M2'),
        ),
        findsOneWidget,
      );
      expect(find.text('Available capacity'), findsNothing);
      expect(find.text('Model allowances'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );

  testWidgets(
    'online machines sort first, offline rows remain direct, and expansion survives reopening',
    (tester) async {
      final server = ConversationServer();
      final now = DateTime.now().millisecondsSinceEpoch;
      Map<String, dynamic> machine(String id, String name, int ageMs) => {
        'machineId': id,
        'name': name,
        'contributorId': 'owner',
        'observation': {'receivedAt': now - ageMs},
      };
      server.state['machines'] = [
        machine('z', 'Zed Mac', 0),
        machine('g', 'Gamma', 600000),
        machine('a', 'alpha Mac', 25000),
        machine('b', 'Beta', 600000),
      ];
      final c = server.controller();
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabMachines(
              controller: c,
              embedded: true,
              onAddAgent: (_) {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      double y(String id) =>
          tester.getTopLeft(find.byKey(ValueKey('super-machine-$id'))).dy;
      expect(y('a'), lessThan(y('z')));
      expect(y('z'), lessThan(y('b')));
      expect(y('b'), lessThan(y('g')));
      expect(
        find.byKey(const ValueKey('super-machines-offline')),
        findsNothing,
      );
      expect(c.isMachineExpanded('a'), isFalse);
      await tester.tap(find.byKey(const ValueKey('super-machine-a')));
      await tester.pumpAndSettle();
      expect(c.isMachineExpanded('a'), isTrue);
      expect(find.text('No agents yet'), findsOneWidget);
      await c.flush();
      final reopened = server.controller(initial: server.saved!);
      expect(reopened.isMachineExpanded('a'), isTrue);
      expect(reopened.isMachineExpanded('b'), isFalse);
      reopened.dispose();
      await tester.tap(find.byKey(const ValueKey('super-machine-a')));
      await tester.pumpAndSettle();
      expect(find.text('No agents yet'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );

  testWidgets(
    'two machines of one model keep their names, and each has its owner avatar and tooltip',
    (tester) async {
      final server = ConversationServer();
      final now = DateTime.now().millisecondsSinceEpoch;
      server.state['people'] = [
        {'id': 'tony', 'email': 'tony@example.com', 'role': 'owner'},
        {'id': 'dee', 'email': 'dee@example.com', 'role': 'collaborator'},
      ];
      Map<String, dynamic> machine(String id, String name, String owner) => {
        'machineId': id,
        'name': name,
        'contributorId': owner,
        'observation': {'receivedAt': now},
      };
      server.state['machines'] = [
        machine('t', 'MacBooks-MacBook-Pro-9.local', 'tony'),
        machine('d', 'MacBook Pro', 'dee'),
      ];
      final c = server.controller();
      await c.refresh();
      final semantics = tester.ensureSemantics();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabMachines(controller: c, onAddAgent: (_) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
      // Two MacBook Pros keep their real names, never a model name or an owner.
      expect(_lineOf(tester, 't'), 'MacBooks-MacBook-Pro-9');
      expect(_lineOf(tester, 'd'), 'MacBook Pro');
      expect(find.textContaining('tony'), findsNothing);
      expect(find.textContaining('dee'), findsNothing);
      final row = find.byKey(const ValueKey('super-machine-t'));
      expect(_tipOf(tester, row), 'Owned by tony');
      expect(
        tester.getSemantics(row).label,
        startsWith('MacBooks-MacBook-Pro-9, Live, Owned by tony'),
      );
      semantics.dispose();
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );

  group('an expanded machine shows its agents as one count', () {
    Future<dynamic> mount(
      WidgetTester tester,
      int agents, {
      int buddies = 0,
    }) async {
      final server = ConversationServer();
      server.state['agents'] = [
        for (var i = 0; i < agents + buddies; i++)
          {
            'id': 'a$i',
            'name': 'Agent $i',
            'displayName': 'Agent $i',
            'machineId': 'm',
            'harnessId': 'native-a$i',
            'contributorId': 'owner',
            'configuration': {'engine': 'codex'},
            if (i >= agents)
              'buddyOf': {
                'personId': ['owner', 'maya', 'sam'][(i - agents) % 3],
                'generation': 'fixture',
              },
          },
      ];
      server.state['machines'] = [
        {
          'machineId': 'm',
          'name': 'Studio Mac',
          'contributorId': 'owner',
          'observation': {
            'receivedAt': DateTime.now().millisecondsSinceEpoch,
            'resources': {'cpuPercent': 12},
          },
        },
      ];
      final c = server.controller();
      await c.refresh();
      c.toggleMachineExpanded('m');
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabMachines(controller: c, onAddAgent: (_) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return c;
    }

    Future<void> unmount(WidgetTester tester, dynamic c) async {
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    }

    final line = find.byKey(const ValueKey('super-machine-agents-m'));
    final entry = find.byKey(const ValueKey('super-machine-entry-m'));
    // The machine row keeps its owner's avatar; no agent has one here.
    final agentAvatar = find.byWidgetPredicate(
      (w) => w is SuperTabAvatar && w.identity.startsWith('agent:'),
    );

    testWidgets('none: no count line, and the machine says it has none', (
      tester,
    ) async {
      final c = await mount(tester, 0);
      expect(line, findsNothing);
      expect(find.text('No agents yet'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('super-machine-readings-m')),
        findsOneWidget,
      );
      await unmount(tester, c);
    });

    testWidgets('one: "1 agent" with a chevron, no avatar and no agent row', (
      tester,
    ) async {
      final c = await mount(tester, 1);
      expect(
        find.descendant(of: line, matching: find.text('1 agent')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: line, matching: find.byIcon(AppIcons.chevronRight)),
        findsOneWidget,
      );
      expect(find.descendant(of: entry, matching: agentAvatar), findsNothing);
      expect(find.text('Agent 0'), findsNothing);
      expect(find.text('No agents yet'), findsNothing);
      expect(
        find.byKey(const ValueKey('super-machine-readings-m')),
        findsOneWidget,
      );
      await unmount(tester, c);
    });

    testWidgets(
      'Buddies are personal: three running on the machine add nothing to its count or list',
      (tester) async {
        final c = await mount(tester, 2, buddies: 3);
        expect(
          find.descendant(of: line, matching: find.text('2 agents')),
          findsOneWidget,
        );
        await tester.tap(line);
        await tester.pumpAndSettle();
        for (final id in ['a0', 'a1']) {
          expect(
            find.byKey(ValueKey('super-machine-agent-m-$id')),
            findsOneWidget,
          );
        }
        for (final id in ['a2', 'a3', 'a4']) {
          expect(
            find.byKey(ValueKey('super-machine-agent-m-$id')),
            findsNothing,
          );
        }
        await unmount(tester, c);
      },
    );

    testWidgets('twenty: one "20 agents" line, not twenty rows', (
      tester,
    ) async {
      final c = await mount(tester, 20);
      expect(line, findsOneWidget);
      expect(
        find.descendant(of: line, matching: find.text('20 agents')),
        findsOneWidget,
      );
      for (var i = 0; i < 20; i++) {
        expect(find.byKey(ValueKey('super-machine-agent-m-a$i')), findsNothing);
      }
      expect(find.descendant(of: entry, matching: agentAvatar), findsNothing);
      await unmount(tester, c);
    });

    testWidgets('twenty: the list scrolls to the last agent', (tester) async {
      final c = await mount(tester, 20);
      await tester.tap(line);
      await tester.pumpAndSettle();
      final last = find.byKey(const ValueKey('super-machine-agent-m-a19'));
      await tester.ensureVisible(last);
      await tester.pumpAndSettle();
      expect(last.hitTestable(), findsOneWidget);
      await unmount(tester, c);
    });

    testWidgets(
      'tapping the line lists every agent, Working, Waiting, then Idle, with name, role and status',
      (tester) async {
        final f = SuperTabLaunchFixture();
        f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
        final server = f.connection.server;
        Map<String, dynamic> agent(String id, String name) => {
          'id': id,
          'name': name,
          'displayName': name,
          'machineId': 'm',
          'harnessId': 'native-$id',
          'contributorId': 'owner',
          'configuration': {'engine': 'codex'},
        };
        server.state['agents'] = [
          agent('pm', 'Quinn'),
          agent('dev', 'Nova'),
          agent('rev', 'Sage'),
          agent('idle', 'Iris'),
        ];
        (server.state['agents'] as List)[2]['role'] = 'reviewer';
        (server.state['conversations'] as List)[0]
          ..['leadId'] = 'pm'
          ..['agentIds'] = ['pm', 'dev', 'rev', 'idle']
          ..['assignment'] = {'agentId': 'rev', 'status': 'needs_human'};
        f.app.machineStates['m']!
          ..agents = [
            for (final id in ['pm', 'dev', 'rev', 'idle'])
              Agent.fromJson({
                'id': 'native-$id',
                'name': id,
                'engine': 'codex',
              }),
          ]
          ..processingAgentIds.addAll(['native-pm', 'native-dev']);
        final c = await f.app.superTabs.open(tabId);
        await c.refresh();
        c.toggleMachineExpanded('m');
        final opened = <String>[];
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SuperTabMachines(
                controller: c,
                app: f.app,
                onAddAgent: (_) {},
                onOpenAgent: (agent) => opened.add(agent.id),
              ),
            ),
          ),
        );
        await tester.pump();
        expect(
          find.descendant(of: line, matching: find.text('4 agents')),
          findsOneWidget,
        );
        expect(find.text('Nova'), findsNothing);

        await tester.tap(line);
        await tester.pump();
        await tester.pump();
        final list = find.byKey(const ValueKey('super-machine-agent-list-m'));
        expect(list, findsOneWidget);
        double top(Finder finder) => tester.getTopLeft(finder).dy;
        final headings = [
          for (final group in ['Working', 'Waiting', 'Idle'])
            find.descendant(of: list, matching: find.text(group)),
        ];
        for (final heading in headings) {
          expect(heading, findsOneWidget);
        }
        Finder row(String id) =>
            find.byKey(ValueKey('super-machine-agent-m-$id'));
        // Working: Nova and Quinn, by name; Waiting: Sage; Idle: Iris.
        final order = [
          headings[0],
          row('dev'),
          row('pm'),
          headings[1],
          row('rev'),
          headings[2],
          row('idle'),
        ];
        for (var i = 1; i < order.length; i++) {
          expect(top(order[i]), greaterThan(top(order[i - 1])));
        }
        for (final (id, name, badge, activity) in [
          ('pm', 'Quinn', 'PM', HarnessActivity.working),
          ('dev', 'Nova', 'Dev', HarnessActivity.working),
          ('rev', 'Sage', 'Rev', HarnessActivity.needsInput),
          ('idle', 'Iris', 'Dev', HarnessActivity.idle),
        ]) {
          expect(
            find.descendant(of: row(id), matching: find.text(name)),
            findsOneWidget,
          );
          expect(
            find.descendant(of: row(id), matching: find.text(badge)),
            findsOneWidget,
          );
          expect(
            tester
                .widget<ActivityMark>(
                  find.descendant(
                    of: row(id),
                    matching: find.byType(ActivityMark),
                  ),
                )
                .activity,
            activity,
          );
        }
        expect(find.descendant(of: list, matching: agentAvatar), findsNothing);

        await tester.tap(row('rev'));
        await tester.pump();
        await tester.pump();
        expect(opened, ['rev']);
        expect(list, findsNothing);
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        f.app.superTabs.dispose();
      },
    );
  });

  testWidgets(
    'expanded agents keep roster identities, roles and lifecycle status and open the selected agent',
    (tester) async {
      final server = ConversationServer();
      final at = DateTime.now().millisecondsSinceEpoch;
      server.state['agents'] = [
        for (final (id, name) in [('pm', 'Quinn'), ('dev', 'Nova')])
          {
            'id': id,
            'name': name,
            'displayName': name,
            'machineId': 'm',
            'harnessId': 'native-$id',
            'contributorId': 'owner',
            'configuration': {'engine': 'codex'},
          },
      ];
      (server.state['conversations'] as List)[0]
        ..['leadId'] = 'pm'
        ..['agentIds'] = ['pm', 'dev']
        ..['assignment'] = {'agentId': 'dev', 'status': 'needs_human'};
      server.state['machines'] = [
        {
          'machineId': 'm',
          'name': 'Studio Mac',
          'contributorId': 'owner',
          'observation': {'receivedAt': at},
        },
      ];
      final c = server.controller();
      await c.refresh();
      final opened = <String>[];
      Future<void> show() => tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabMachines(
              controller: c,
              embedded: true,
              onAddAgent: (_) {},
              onOpenAgent: (agent) => opened.add(agent.id),
            ),
          ),
        ),
      );
      await show();
      await tester.pumpAndSettle();
      expect(find.text('Quinn'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('super-machine-m')));
      await tester.pumpAndSettle();
      final count = find.byKey(const ValueKey('super-machine-agents-m'));
      await tester.tap(count);
      await tester.pumpAndSettle();
      final pm = find.byKey(const ValueKey('super-machine-agent-m-pm'));
      final dev = find.byKey(const ValueKey('super-machine-agent-m-dev'));
      expect(
        find.descendant(of: pm, matching: find.text('PM')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: dev, matching: find.text('Dev')),
        findsOneWidget,
      );
      server.state['projects'] = [
        {
          ...projectFixture('lead', 'Pilot', 'lead'),
          'skillSet': 'custom',
          'roles': [
            {
              'id': 'lead',
              'name': 'Product Manager',
              'kind': 'lead',
              'version': 'v1',
            },
            {
              'id': 'research',
              'name': 'Research Engineer',
              'kind': 'builder',
              'version': 'v1',
            },
          ],
        },
      ];
      (server.state['agents'] as List)[1]['roleId'] = 'research';
      await c.refresh();
      await show();
      await tester.pumpAndSettle();
      expect(
        find.descendant(of: dev, matching: find.text('Research Engineer')),
        findsOneWidget,
      );
      expect(
        tester
            .widget<ActivityMark>(
              find.descendant(of: dev, matching: find.byType(ActivityMark)),
            )
            .activity,
        HarnessActivity.needsInput,
      );
      await tester.tap(dev);
      await tester.pumpAndSettle();
      expect(opened, ['dev']);
      expect(find.byType(SuperTabDetailDialog), findsNothing);
      (server.state['machines'] as List)[0]['observation']['receivedAt'] =
          at - 600000;
      await c.refresh();
      await show();
      await tester.pumpAndSettle();
      await tester.tap(count);
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<ActivityMark>(
              find.descendant(of: dev, matching: find.byType(ActivityMark)),
            )
            .activity,
        HarnessActivity.offline,
      );
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );

  testWidgets(
    'a live agent keeps its observed status before the first machine capacity sample',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['agents'] = [
        {
          'id': 'dev',
          'name': 'Nova',
          'displayName': 'Nova',
          'machineId': 'm',
          'harnessId': 'native-dev',
          'contributorId': 'owner',
          'configuration': {'engine': 'codex'},
        },
      ];
      f.app.machineStates['m']!
        ..agents = [
          Agent.fromJson({
            'id': 'native-dev',
            'name': 'Nova',
            'engine': 'codex',
          }),
        ]
        ..processingAgentIds.add('native-dev');
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      c.toggleMachineExpanded('m');
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabMachines(
              controller: c,
              app: f.app,
              onAddAgent: (_) {},
              onOpenAgent: (_) {},
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('super-machine-agents-m')));
      await tester.pump();
      await tester.pump();
      final row = find.byKey(const ValueKey('super-machine-agent-m-dev'));
      expect(
        tester
            .widget<ActivityMark>(
              find.descendant(of: row, matching: find.byType(ActivityMark)),
            )
            .activity,
        HarnessActivity.working,
      );
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
    },
  );

  testWidgets(
    'each known, unexpired allowance is a chip, Claude first: amber under 20%, red under 10%, its windows on hover',
    (tester) async {
      final server = ConversationServer();
      final now = DateTime.now();
      final at = now.millisecondsSinceEpoch;
      Map<String, dynamic> quota(
        String engine,
        int used, {
        bool known = true,
        DateTime? resetsAt,
      }) => {
        'engine': engine,
        'known': known,
        'windows': [
          {
            'name': '5-hour',
            'usedPercent': used,
            'resetsAt': (resetsAt ?? now.add(const Duration(hours: 2)))
                .millisecondsSinceEpoch,
          },
        ],
      };
      Map<String, dynamic> machine(
        String id,
        List<Map<String, dynamic>> quotas, {
        int age = 0,
      }) => {
        'machineId': id,
        'name': id,
        'contributorId': 'owner',
        'observation': {'receivedAt': at - age, 'quotas': quotas},
      };
      server.state['machines'] = [
        // Listed Codex first; shown Claude first.
        machine('both', [quota('codex', 95), quota('claude', 85)]),
        machine('fine', [quota('claude', 50)]),
        machine('expired', [
          quota(
            'codex',
            10,
            resetsAt: now.subtract(const Duration(minutes: 1)),
          ),
        ]),
        machine('unknown', [quota('claude', 10, known: false)]),
        // An old reading's allowance is not shown as now.
        machine('gone', [quota('claude', 50)], age: 600000),
      ];
      final c = server.controller();
      await c.refresh();
      for (final id in ['both', 'fine', 'expired', 'unknown', 'gone']) {
        c.toggleMachineExpanded(id);
      }
      final semantics = tester.ensureSemantics();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabMachines(controller: c, onAddAgent: (_) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Finder chip(String id, String engine) =>
          find.byKey(ValueKey('super-machine-allowance-$id-$engine'));
      Color? ink(Finder chip, String figure) => tester
          .widget<Text>(find.descendant(of: chip, matching: find.text(figure)))
          .style
          ?.color;

      expect(
        tester.getTopLeft(chip('both', 'claude')).dx,
        lessThan(tester.getTopLeft(chip('both', 'codex')).dx),
      );
      expect(
        tester
            .widget<EngineMark>(
              find.descendant(
                of: chip('both', 'claude'),
                matching: find.byType(EngineMark),
              ),
            )
            .size,
        14,
      );
      final surface = DesktopChrome.surface;
      expect(
        ink(chip('both', 'claude'), '15%'),
        statusLineInkOnSurface(grid.AppPalette.usageLow, surface),
      );
      expect(
        ink(chip('both', 'codex'), '5%'),
        statusLineInkOnSurface(grid.AppPalette.usageCritical, surface),
      );
      expect(
        ink(chip('fine', 'claude'), '50%'),
        statusLineInkOnSurface(DesktopChrome.foreground, surface),
      );
      expect(
        tester
            .widget<Text>(
              find.descendant(
                of: chip('fine', 'claude'),
                matching: find.text('50%'),
              ),
            )
            .style
            ?.fontFeatures,
        contains(const FontFeature.tabularFigures()),
      );
      // Each chip says its windows on hover, and its share in words to a screen reader.
      final claudeTip = tester
          .widget<Tooltip>(
            find
                .ancestor(
                  of: chip('both', 'claude'),
                  matching: find.byType(Tooltip),
                )
                .first,
          )
          .message!;
      expect(
        claudeTip,
        startsWith('Claude Code\n5-hour: 15% remaining · resets in '),
      );
      // Under the figure, the window that stops work first and when it resets.
      expect(
        find.descendant(
          of: chip('both', 'claude'),
          matching: find.textContaining(
            RegExp(r'^5-hour limit · resets in \d'),
          ),
        ),
        findsOneWidget,
      );
      expect(
        find.bySemanticsLabel(RegExp('Claude Code 15% remaining')),
        findsOneWidget,
      );
      expect(
        find.bySemanticsLabel(RegExp('Codex 5% remaining')),
        findsOneWidget,
      );
      // No chip for an expired or unknown allowance, nor for an offline machine; no warning icon anywhere.
      expect(find.byKey(const ValueKey('super-machine-gone')), findsOneWidget);
      for (final id in ['expired', 'unknown', 'gone']) {
        expect(
          find.descendant(
            of: find.byKey(ValueKey('super-machine-$id')),
            matching: find.byType(EngineMark),
          ),
          findsNothing,
          reason: id,
        );
      }
      expect(find.byIcon(AppIcons.triangleAlert), findsNothing);
      semantics.dispose();
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );

  testWidgets(
    'main rows and expanded readings retain their controls at narrow widths and larger text',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(900, 1800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = ConversationServer();
      final now = DateTime.now().millisecondsSinceEpoch;
      server.state['agents'] = [
        {
          'id': 'dev',
          'name': 'A long engineer name',
          'displayName': 'A long engineer name',
          'machineId': 'm',
          'harnessId': 'native',
          'contributorId': 'owner',
          'configuration': {'engine': 'codex'},
        },
      ];
      server.state['machines'] = [
        {
          'machineId': 'm',
          'name': 'A long machine name.local',
          'contributorId': 'owner',
          'observation': {
            'receivedAt': now,
            'resources': {
              'cpuPercent': 71,
              'gpuPercent': 100,
              'memoryTotalBytes': 32000000000,
              'memoryUsedBytes': 15000000000,
              'diskTotalBytes': 1000000000000,
              'diskFreeBytes': 207000000000,
            },
            'quotas': [
              for (final engine in ['claude', 'codex'])
                {
                  'engine': engine,
                  'known': true,
                  'windows': [
                    {'name': '5-hour', 'usedPercent': 0},
                  ],
                },
            ],
          },
        },
      ];
      final c = server.controller();
      await c.refresh();
      c.toggleMachineExpanded('m');
      for (final width in [164.0, 188.0, 224.0, 284.0, 420.0]) {
        for (final scale in [1.0, 2.0]) {
          await tester.pumpWidget(
            MaterialApp(
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(scale)),
                child: child!,
              ),
              home: Scaffold(
                body: Align(
                  alignment: Alignment.topLeft,
                  child: SizedBox(
                    width: width,
                    child: SuperTabMachines(
                      controller: c,
                      embedded: true,
                      onAddAgent: (_) {},
                      onOpenAgent: (_) {},
                    ),
                  ),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          final reason = 'width $width, scale $scale';
          expect(tester.takeException(), isNull, reason: reason);
          final row = tester.getRect(
            find.byKey(const ValueKey('super-machine-m')),
          );
          final dot = tester.getRect(
            find.byKey(const ValueKey('super-machine-state-m-live')),
          );
          expect(row.width, width, reason: reason);
          // No chevron: the status takes the last 32 px column, as on project rows.
          expect(dot.center.dx, closeTo(row.right - 16, .01), reason: reason);
          expect(
            tester
                .getTopLeft(find.byKey(const ValueKey('super-machine-name-m')))
                .dx,
            row.left + 36,
            reason: reason,
          );
          expect(_hw(tester, 'm', 'CPU'), '71%', reason: reason);
          expect(_hw(tester, 'm', 'GPU'), '100%', reason: reason);
          expect(_hw(tester, 'm', 'RAM'), '17 GB', reason: reason);
          expect(_hw(tester, 'm', 'SSD'), '207 GB', reason: reason);
          expect(
            find.byKey(const ValueKey('super-machine-allowance-m-claude')),
            findsOneWidget,
            reason: reason,
          );
          expect(
            find.byKey(const ValueKey('super-machine-allowance-m-codex')),
            findsOneWidget,
            reason: reason,
          );
        }
      }
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );

  testWidgets(
    'an offline machine opens directly and its details still attach a running agent',
    (tester) async {
      final server = ConversationServer();
      server.state['machines'] = [
        {
          'machineId': 'gone',
          'name': 'Old Mini',
          'contributorId': 'owner',
          'observation': {
            'receivedAt': DateTime.now()
                .subtract(const Duration(minutes: 10))
                .millisecondsSinceEpoch,
          },
        },
      ];
      final c = server.controller();
      await c.refresh();
      final attached = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabMachines(
              controller: c,
              onAddAgent: (group) => attached.add(group.id),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final row = find.byKey(const ValueKey('super-machine-gone'));
      expect(row, findsOneWidget);
      await openMachineDetails(tester, row);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Attach running agent'));
      await tester.pumpAndSettle();
      expect(attached, [c.selected!.id]);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );

  group('Local models', () {
    const swarmGrid = 'swarm-0123456789ab';
    Map<String, dynamic> machine({
      List<Map<String, dynamic>> served = const [],
    }) => {
      'machineId': 'studio',
      'name': 'Studio',
      'contributorId': 'owner',
      'observation': {
        'receivedAt': DateTime.now().millisecondsSinceEpoch,
        'localModels': served,
      },
    };
    Future<void> mount(WidgetTester tester, dynamic c) async {
      await tester.pumpWidget(
        MaterialApp(
          // As the sidebar does: the section is rebuilt whenever the Swarm changes.
          home: Scaffold(
            body: ListenableBuilder(
              listenable: c,
              builder: (context, _) =>
                  SuperTabMachines(controller: c, onAddAgent: (_) {}),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets(
      'a machine\'s details say what it runs for the Swarm, and offer nothing to do there',
      (tester) async {
        final server = ConversationServer();
        server.state['localModels'] = {
          'grid': swarmGrid,
          'enabled': true,
          'ready': true,
        };
        server.state['machines'] = [
          machine(
            served: [
              {'grid': swarmGrid, 'model': 'qwen3', 'name': 'Qwen 3'},
              // Run here, not yet listed by the Swarm's grid: shown as starting.
              {
                'grid': swarmGrid,
                'model': 'qwen36',
                'name': 'Qwen 3.6',
                'starting': true,
              },
              {'grid': 'swarm-ffffffffffff', 'model': 'other'},
              {
                'grid': swarmGrid,
                'model': 'deepseek/deepseek-v4.1-flash',
                'name': 'deepseek/deepseek-v4.1-flash · OpenRouter',
                'kind': 'api',
              },
              {'grid': 'team', 'model': 'muse', 'kind': 'shared'},
            ],
          ),
        ];
        final c = server.controller();
        await c.refresh();
        await mount(tester, c);
        // Local models live in the sidebar now, not the Machines heading.
        expect(find.byKey(const ValueKey('super-local-models')), findsNothing);
        // Its expanded readings list what it offers, under labels; a model shared with its owner stays hidden.
        await tester.tap(find.byKey(const ValueKey('super-machine-studio')));
        await tester.pumpAndSettle();
        expect(find.text('Local'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('super-machine-local-studio-Qwen 3')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('super-machine-local-studio-Qwen 3.6')),
          findsOneWidget,
        );
        expect(find.text('starting…'), findsOneWidget);
        expect(find.text('API'), findsOneWidget);
        expect(
          find.byKey(
            const ValueKey('super-machine-api-studio-deepseek-v4.1-flash'),
          ),
          findsOneWidget,
        );
        expect(find.text('muse'), findsNothing);
        await openMachineDetails(
          tester,
          find.byKey(const ValueKey('super-machine-studio')),
        );
        await tester.pumpAndSettle();
        expect(find.text('Models for this Swarm'), findsOneWidget);
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('super-machine-local-models-studio')),
            matching: find.text('Qwen 3'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('super-machine-local-models-studio')),
            matching: find.text('deepseek-v4.1-flash'),
          ),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('super-machine-local-models-run')),
          findsNothing,
        );
        await tester.tap(find.byTooltip('Close'));
        await tester.pumpAndSettle();
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      },
    );

    test(
      'a reading serves models on the Swarm grid only while it is fresh',
      () {
        final now = DateTime.fromMillisecondsSinceEpoch(1000000);
        Map<String, dynamic> pool(int at) => {
          'observation': {
            'receivedAt': at,
            'localModels': [
              {'grid': swarmGrid, 'model': 'qwen3'},
              {'grid': swarmGrid, 'model': 7},
              'junk',
            ],
          },
        };
        expect(superTabServedModels(pool(990000), swarmGrid, now: now), [
          (model: 'qwen3', name: 'qwen3'),
        ]);
        expect(
          superTabServedModels(pool(900000), swarmGrid, now: now),
          isEmpty,
        );
        expect(superTabServedModels(null, swarmGrid, now: now), isEmpty);
        expect(SuperTabLocalModels.read({'enabled': true}), isNull);
        expect(
          SuperTabLocalModels.read({
            'grid': swarmGrid,
            'enabled': true,
            'ready': false,
            'error': 'plan limit',
          })!.error,
          'plan limit',
        );
      },
    );
  });

  group('Remove from Swarm', () {
    Map<String, dynamic> machine(String contributorId) => {
      'machineId': 'studio',
      'name': 'Studio',
      'contributorId': contributorId,
      'observation': {'receivedAt': DateTime.now().millisecondsSinceEpoch},
    };
    Map<String, dynamic> agent(String id, String contributorId) => {
      'id': id,
      'name': id,
      'displayName': id == 'a1' ? 'Mira' : 'River',
      'machineId': 'studio',
      'harnessId': 'h-$id',
      'contributorId': contributorId,
      'machineOwnerId': contributorId,
      'configuration': <String, dynamic>{'engine': 'claude'},
    };
    Future<void> mount(WidgetTester tester, dynamic c) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabMachines(controller: c, onAddAgent: (_) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets(
      'the owner removes a machine and its agents after a yes, from its details',
      (tester) async {
        final server = _RemovalServer();
        server.state['machines'] = [machine('owner')];
        server.state['agents'] = [agent('a1', 'owner'), agent('a2', 'owner')];
        server.preview = {
          'blockedBy': null,
          'agents': [
            {
              'id': 'a1',
              'name': 'Mira',
              'projectName': 'Pilot',
              'task': 'Review the onboarding flow',
            },
            {'id': 'a2', 'name': 'River', 'projectName': 'Beacon'},
          ],
          'soleSourceProjects': [
            {'id': 'beacon', 'name': 'Beacon'},
          ],
        };
        final c = server.controller();
        await c.refresh();
        await mount(tester, c);
        await openMachineDetails(
          tester,
          find.byKey(const ValueKey('super-machine-studio')),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('super-machine-remove')));
        await tester.pumpAndSettle();
        expect(find.text('Remove Studio from this Swarm?'), findsOneWidget);
        expect(server.previewReads, [
          '/api/super-tabs/tab/machines/studio/removal',
        ]);
        expect(find.textContaining('Mira'), findsWidgets);
        expect(find.textContaining('River'), findsWidgets);
        expect(find.textContaining('Pilot'), findsWidgets);
        expect(find.textContaining('Beacon'), findsWidgets);
        expect(
          find.textContaining('Review the onboarding flow'),
          findsOneWidget,
        );
        expect(find.textContaining('Product Manager'), findsWidgets);
        expect(find.textContaining('only on this machine'), findsOneWidget);
        expect(find.textContaining('Swarm folders'), findsOneWidget);
        if (capture != null) {
          await captureWindow(tester, capture, 'machine-remove-confirm');
        }
        // Cancel sends nothing.
        await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
        await tester.pumpAndSettle();
        expect(
          server.posts.where(
            (p) => (p['command'] as Map?)?['type'] == 'machine.remove',
          ),
          isEmpty,
        );

        await openMachineDetails(
          tester,
          find.byKey(const ValueKey('super-machine-studio')),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('super-machine-remove')));
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('super-machine-remove-confirm')),
        );
        await tester.pumpAndSettle();
        expect(
          server.posts
              .map((p) => p['command'])
              .where((cmd) => (cmd as Map)['type'] == 'machine.remove')
              .single,
          {'type': 'machine.remove', 'machineId': 'studio'},
        );
        expect(find.text('Remove Studio from this Swarm?'), findsNothing);
        expect(find.text('Cleaning up'), findsOneWidget);
        if (capture != null) {
          await captureWindow(tester, capture, 'machine-removal-cleaning');
        }
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      },
    );

    testWidgets('a right-click offers it to whoever may remove the machine', (
      tester,
    ) async {
      final server = _RemovalServer();
      server.state['machines'] = [machine('owner')];
      final c = server.controller();
      await c.refresh();
      await mount(tester, c);
      await tester.tap(
        find.byKey(const ValueKey('super-machine-studio')),
        buttons: kSecondaryMouseButton,
      );
      await tester.pumpAndSettle();
      expect(find.text('Details'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('super-machine-menu-remove')));
      await tester.pumpAndSettle();
      expect(find.text('Remove Studio from this Swarm?'), findsOneWidget);
      expect(find.textContaining('Swarm folders'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    });

    testWidgets('machine with a Product Manager cannot be removed', (
      tester,
    ) async {
      final server = ConversationServer();
      server.state['machines'] = [machine('owner')];
      server.state['agents'] = [agent('a1', 'owner')];
      (server.state['conversations'] as List)[0]['leadId'] = 'a1';
      final c = server.controller();
      await c.refresh();
      await mount(tester, c);
      await openMachineDetails(
        tester,
        find.byKey(const ValueKey('super-machine-studio')),
      );
      await tester.pumpAndSettle();
      final remove = find.byKey(const ValueKey('super-machine-remove'));
      expect(remove, findsOneWidget);
      // Why, on the unavailable control itself, not as a sentence under the title (Ken, 2026-10-28).
      const why =
          'Mira is the Product Manager of project Pilot. Delete the project first.';
      expect(find.text(why), findsNothing);
      expect(find.byTooltip(why), findsOneWidget);
      expect(server.posts, isEmpty);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    });

    testWidgets('the removal preview can refuse a Product Manager machine', (
      tester,
    ) async {
      final server = _RemovalServer();
      server.state['machines'] = [machine('owner')];
      server.preview = {
        'blockedBy': {'projectId': 'hidden', 'projectName': 'Hidden Pilot'},
        'agents': <dynamic>[],
        'soleSourceProjects': <dynamic>[],
      };
      final c = server.controller();
      await c.refresh();
      await mount(tester, c);
      await openMachineDetails(
        tester,
        find.byKey(const ValueKey('super-machine-studio')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-machine-remove')));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Product Manager of project Hidden Pilot'),
        findsOneWidget,
      );
      expect(
        tester
            .widget<FilledButton>(
              find.byKey(const ValueKey('super-machine-remove-confirm')),
            )
            .onPressed,
        isNull,
      );
      expect(server.posts, isEmpty);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    });

    testWidgets('a failed preview cannot confirm machine removal', (
      tester,
    ) async {
      final server = _RemovalServer()..failPreview = true;
      server.state['machines'] = [machine('owner')];
      final c = server.controller();
      await c.refresh();
      await mount(tester, c);
      await openMachineDetails(
        tester,
        find.byKey(const ValueKey('super-machine-studio')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-machine-remove')));
      await tester.pumpAndSettle();
      expect(find.text('Could not check this machine.'), findsOneWidget);
      expect(
        tester
            .widget<FilledButton>(
              find.byKey(const ValueKey('super-machine-remove-confirm')),
            )
            .onPressed,
        isNull,
      );
      expect(server.posts, isEmpty);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    });

    testWidgets('a pending machine removal stays visible as Cleaning up', (
      tester,
    ) async {
      final server = ConversationServer();
      server.state['machines'] = [
        {
          ...machine('owner'),
          'removal': {
            'id': 'removal-1',
            'state': 'cleaning',
            'requestedAt': '2026-10-23T00:00:00Z',
          },
        },
      ];
      final c = server.controller();
      await c.refresh();
      await mount(tester, c);
      expect(find.text('Cleaning up'), findsOneWidget);
      await openMachineDetails(
        tester,
        find.byKey(const ValueKey('super-machine-studio')),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-machine-remove')), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    });

    testWidgets(
      'machine details disable Remove when its agent becomes Product Manager',
      (tester) async {
        final server = ConversationServer();
        server.state['machines'] = [machine('owner')];
        server.state['agents'] = [agent('a1', 'owner')];
        final c = server.controller();
        await c.refresh();
        await mount(tester, c);
        await openMachineDetails(
          tester,
          find.byKey(const ValueKey('super-machine-studio')),
        );
        await tester.pumpAndSettle();
        (server.state['conversations'] as List)[0]['leadId'] = 'a1';
        await c.refresh();
        await tester.pumpAndSettle();
        expect(
          find.byTooltip(
            'Mira is the Product Manager of project Pilot. Delete the project first.',
          ),
          findsOneWidget,
        );
        final remove = tester.widget<AppIconButton>(
          find.byKey(const ValueKey('super-machine-remove')),
        );
        expect(remove.onPressed, isNull);
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      },
    );

    testWidgets('only the machine owner sees Remove from Swarm', (
      tester,
    ) async {
      final server = ConversationServer();
      (server.state['people'] as List).add({
        'id': 'peer',
        'email': 'peer@example.com',
        'role': 'collaborator',
      });
      // Swarm ownership does not grant removal of another person's machine.
      server.state['machines'] = [machine('peer')];
      server.state['agents'] = [agent('a1', 'owner')];
      final owner = server.controller();
      await owner.refresh();
      await mount(tester, owner);
      await openMachineDetails(
        tester,
        find.byKey(const ValueKey('super-machine-studio')),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-machine-remove')), findsNothing);
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      await owner.flush();
      owner.dispose();

      // The machine owner can remove it even when another person placed an
      // ordinary agent there; the preview names what will stop.
      final c = server.controller(account: 'peer');
      await c.refresh();
      await mount(tester, c);
      await tester.pumpAndSettle();
      await openMachineDetails(
        tester,
        find.byKey(const ValueKey('super-machine-studio')),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('super-machine-remove')),
        findsOneWidget,
      );
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    });
  });

  for (final brightness in [Brightness.dark, Brightness.light]) {
    for (final textScale in [1.0, 2.0]) {
      for (final width in [280.0, 380.0]) {
        testWidgets(
          'machine identity, full-row target and details fit ${brightness.name} ${textScale}x at $width',
          (tester) async {
            await tester.binding.setSurfaceSize(const Size(900, 850));
            addTearDown(() => tester.binding.setSurfaceSize(null));
            final previousBrightness = grid.AppTheme.brightness.value;
            grid.AppTheme.brightness.value = brightness;
            addTearDown(
              () => grid.AppTheme.brightness.value = previousBrightness,
            );
            final server = ConversationServer();
            server.state['people'] = [
              {'id': 'owner', 'email': 'dee@example.com', 'role': 'owner'},
            ];
            server.state['agents'] = [
              for (var i = 0; i < 8; i++)
                {
                  'id': 'agent-$i',
                  'name': 'Harness $i',
                  'displayName': i == 0 ? 'Atlas' : 'Engineer $i',
                  'machineId': 'm',
                  'harnessId': 'native-$i',
                  'contributorId': 'owner',
                  'configuration': {'engine': 'codex'},
                },
            ];
            (server.state['conversations'] as List)[0]
              ..['leadId'] = 'agent-0'
              ..['agentIds'] = ['agent-0'];
            server.state['machines'] = [
              {
                'machineId': 'm',
                'name': 'M2',
                'contributorId': 'owner',
                'paused': true,
                'engines': ['claude', 'codex'],
                'cwd': '/work/a-very-long-project-folder-without-spaces/checked-out-project',
                'observation': {
                  'receivedAt': DateTime.now().millisecondsSinceEpoch,
                  'resources': {
                    'deviceType': 'MacBook Pro',
                    'chip': 'Apple M2 Max',
                    'os': 'macOS',
                    'cpuPercent': 27,
                    'gpuPercent': 7,
                    'memoryTotalBytes': 64000000000,
                    'memoryUsedBytes': 36000000000,
                    'diskTotalBytes': 1000000000000,
                    'diskFreeBytes': 141000000000,
                  },
                  'quotas': [
                    {'engine': 'claude', 'known': false, 'windows': []},
                    {
                      'engine': 'codex',
                      'known': true,
                      'windows': [
                        {
                          'name': '5-hour',
                          'usedPercent': 30,
                          'resetsAt': DateTime.now()
                              .add(const Duration(hours: 2))
                              .millisecondsSinceEpoch,
                        },
                        {
                          'name': 'Weekly',
                          'usedPercent': 10,
                          'resetsAt': DateTime.now()
                              .add(const Duration(days: 3))
                              .millisecondsSinceEpoch,
                        },
                      ],
                    },
                  ],
                },
              },
            ];
            final c = server.controller();
            await c.refresh();
            final machineBoundary = GlobalKey();
            await tester.pumpWidget(
              MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: grid.buildAppTheme(brightness: brightness),
                builder: (context, child) => MediaQuery(
                  data: MediaQuery.of(context)
                      .copyWith(textScaler: TextScaler.linear(textScale)),
                  child: child!,
                ),
                home: Scaffold(
                  body: Align(
                    alignment: Alignment.topLeft,
                    child: RepaintBoundary(
                      key: machineBoundary,
                      child: Material(
                        color: grid.AppDesktop.surface,
                        child: SizedBox(
                          width: width,
                          child: SuperTabMachines(
                            controller: c,
                            embedded: true,
                            onAddAgent: (_) {},
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            );
            await tester.pumpAndSettle();
            final row = find.byKey(const ValueKey('super-machine-m'));
            final rowRect = tester.getRect(row);
            expect(rowRect.width, width);
            // One line at a project row's height and on its columns.
            if (textScale == 1) expect(rowRect.height, 36);
            final dot = tester.getRect(
              find.descendant(
                of: row,
                matching: find.byType(SuperTabMachineDot),
              ),
            );
            // No chevron: the status takes the last 32 px column, as on project rows.
            expect(dot.center.dx, closeTo(rowRect.right - 16, .01));
            expect(dot.center.dy, closeTo(rowRect.center.dy, .5));
            expect(
              tester
                  .getTopLeft(
                    find.byKey(const ValueKey('super-machine-name-m')),
                  )
                  .dx,
              rowRect.left + 36,
            );
            final owner = tester.widget<SuperTabAvatar>(
              find.descendant(of: row, matching: find.byType(SuperTabAvatar)),
            );
            expect(owner.identity, 'person:owner');
            expect(owner.name, 'dee');
            expect(find.text('Atlas'), findsNothing);
            // The owner, paused and the numbers are in the row's tooltip, not on the line, and never an age.
            expect(
              _tipOf(tester, row),
              'Owned by dee · New work paused · CPU 73% free · GPU 93% free · RAM 28 GB free · SSD 141 GB free',
            );
            expect(find.byIcon(AppIcons.pause), findsNothing);
            for (final value in ['CPU', 'GPU', 'RAM', 'SSD', 'dee', 'ago']) {
              expect(find.textContaining(value), findsNothing);
            }
            // Codex's tightest window, when the line has room for it; Claude's allowance is unknown.
            final codex = find.byKey(
              const ValueKey('super-machine-allowance-m-codex'),
            );
            if (codex.evaluate().isNotEmpty) {
              expect(
                find.descendant(of: codex, matching: find.text('70%')),
                findsOneWidget,
              );
            }
            expect(
              find.byKey(const ValueKey('super-machine-allowance-m-claude')),
              findsNothing,
            );
            final ink = find.descendant(
              of: row,
              matching: find.byType(InkWell),
              matchRoot: true,
            );
            expect(tester.getRect(ink.first), rowRect);
            expect(tester.takeException(), isNull);

            if (capture != null && textScale == 1) {
              await tester.tap(find.byKey(const ValueKey('super-machine-m')));
              await tester.pumpAndSettle();
              await tester.runAsync(
                () => precacheImage(
                  AssetImage(engineIdentity('codex').asset!),
                  tester.element(find.byType(EngineMark).first),
                ).timeout(const Duration(seconds: 10)),
              );
              await tester.pumpAndSettle();
              await captureBoundary(
                tester,
                machineBoundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary,
                capture,
                'machine-expanded-${brightness.name}-${width.toInt()}',
              );
              await tester.tap(find.byKey(const ValueKey('super-machine-m')));
              await tester.pumpAndSettle();
            }
            // The full row owns hover; its details are in its right-click menu.
            final mouse = await tester.createGesture(
              kind: PointerDeviceKind.mouse,
            );
            await mouse.addPointer(
              location: Offset(rowRect.right + 20, rowRect.center.dy),
            );
            await tester.pump();
            await mouse.moveTo(Offset(rowRect.right - 2, rowRect.center.dy));
            await tester.pumpAndSettle();
            final captureName =
                '${brightness.name}-${textScale}x-${width.toInt()}';
            await captureBoundary(
              tester,
              machineBoundary.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary,
              capture,
              'machine-hover-$captureName',
            );
            await mouse.removePointer();
            await openMachineDetails(
              tester,
              find.byKey(const ValueKey('super-machine-m')),
            );
            if (capture != null) {
              // A frame can settle before asynchronous bitmap decoding has
              // finished. Wait for the real asset before photographing it.
              await tester.runAsync(
                () => precacheImage(
                  AssetImage(engineIdentity('codex').asset!),
                  tester.element(find.byType(EngineMark).first),
                ).timeout(const Duration(seconds: 10)),
              );
              await tester.pumpAndSettle();
            }
            final dialog = find.byType(SuperTabDetailDialog);
            final details = find.byType(SuperTabMachineDetails);
            expect(dialog, findsOneWidget);
            expect(details, findsOneWidget);
            expect(
              find.descendant(
                of: details,
                matching: find.text('28 GB of 64 GB'),
              ),
              findsOneWidget,
            );
            expect(
              find.descendant(
                of: details,
                matching: find.text('141 GB of 1000 GB'),
              ),
              findsOneWidget,
            );
            expect(
              find.descendant(
                of: details,
                matching: find.textContaining('70% left · resets in '),
              ),
              findsOneWidget,
            );
            expect(
              find.descendant(
                of: details,
                matching: find.textContaining('90% left · resets in '),
              ),
              findsOneWidget,
            );
            expect(
              find.descendant(of: details, matching: find.text('—')),
              findsNothing,
            );
            expect(tester.takeException(), isNull);
            await captureWindow(
              tester,
              capture,
              'machine-details-$captureName',
            );
            if (capture != null && textScale > 1) {
              await Scrollable.ensureVisible(
                tester.element(find.text('Model allowances')),
                alignment: 0,
              );
              await tester.pumpAndSettle();
              await captureWindow(
                tester,
                capture,
                'machine-details-more-$captureName',
              );
            }
            await tester.tap(find.byTooltip('Close'));
            await tester.pumpAndSettle();
            expect(tester.takeException(), isNull);
            await tester.pumpWidget(const SizedBox());
            await c.flush();
            c.dispose();
          },
        );
      }
    }
  }

  test('shared repository metadata excludes embedded credentials', () {
    expect(
      superTabRepositoryUrl('https://token@github.com/example/project'),
      isNull,
    );
    expect(
      superTabRepositoryUrl('ssh://git:secret@github.com/example/project'),
      isNull,
    );
    expect(
      superTabRepositoryUrl('git@github.com:example/project.git'),
      'git@github.com:example/project.git',
    );
    expect(
      superTabRepositoryUrl('https://github.com/example/project'),
      'https://github.com/example/project',
    );
  });
  test('a daemon\'s canonical remote is shared as an HTTPS repository', () {
    // The CLI daemon reports `origin` as host/owner/repo, without a scheme.
    expect(
      superTabRepositoryUrl('github.com/autonomous-ai/openharness'),
      'https://github.com/autonomous-ai/openharness',
    );
    expect(
      superTabRepositoryUrl('gitlab.example.co.uk/team/group/project'),
      'https://gitlab.example.co.uk/team/group/project',
    );
    // A canonical port may be SSH's; it is not guessed as HTTPS.
    expect(superTabRepositoryUrl('git.example.com:2222/team/project'), isNull);
    // Local and relative remotes are not shareable repositories.
    expect(superTabRepositoryUrl('../project'), isNull);
    expect(superTabRepositoryUrl('/Users/me/project.git'), isNull);
    expect(superTabRepositoryUrl('github.com'), isNull);
  });
  testWidgets('Machine details omit unknown subscription allowances', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    f.connection.server.state['machines'] = [
      {
        'machineId': 'm',
        'contributorId': 'owner',
        'engines': ['opencode'],
        'observation': {
          'receivedAt': DateTime.now().millisecondsSinceEpoch,
          'quotas': [
            for (final engine in ['claude', 'codex', 'opencode', 'cursor'])
              {
                'engine': engine,
                'known': engine == 'claude',
                'windows': [
                  {'name': '5-hour', 'usedPercent': 40},
                ],
              },
          ],
        },
      },
    ];
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 300,
            height: 400,
            child: SuperTabMachines(
              controller: c,
              app: f.app,
              onAddAgent: (_) {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('super-machine-m')));
    await tester.pumpAndSettle();
    // Only the known allowance of the two the list shows, Claude's, has a chip; so do the details.
    expect(
      tester
          .widgetList<EngineMark>(find.byType(EngineMark))
          .map((mark) => mark.engine),
      ['claude'],
    );
    await openMachineDetails(
      tester,
      find.byKey(const ValueKey('super-machine-m')),
    );
    await tester.pumpAndSettle();
    expect(find.text('OpenCode'), findsNothing);
    expect(
      tester
          .widgetList<EngineMark>(find.byType(EngineMark))
          .map((mark) => mark.engine)
          .toSet(),
      {'claude'},
    );

    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  });

  testWidgets(
    'machine settings show its name, Agents as memory allows, and Remove from this Swarm',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.maxAvailableAgents = 8;
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner', 'maxAgents': 8},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openConfigureDialog(
        tester,
        f,
        c,
        readLocal: (_) async => _reading(totalGiB: 16, freeGiB: 1),
      );

      final name = superTabMachineName(f.app.stateOf('m')!.machine.displayName);
      expect(
        find.descendant(
          of: find.byType(SuperTabDetailDialog),
          matching: find.text(name),
        ),
        findsOneWidget,
      );
      expect(find.text('Configure machine'), findsNothing);
      // One machine's settings: no picker to switch to another.
      expect(_picker, findsNothing);
      expect(find.text('Agents'), findsOneWidget);
      // Stored at the machine's maximum: that is "as memory allows".
      expect(_agentsChoice(tester), 'memory');
      expect(find.text('As memory allows'), findsOneWidget);
      expect(find.text('At most'), findsOneWidget);
      expect(
        find.widgetWithText(TextButton, 'Remove from this Swarm'),
        findsOneWidget,
      );
      expect(find.widgetWithText(FilledButton, 'Save'), findsOneWidget);

      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await _settleSave(tester);
      expect(find.byType(SuperTabDetailDialog), findsNothing);
      expect(f.connection.server.posts.single['command'], {
        'type': 'machine.contribute',
        'machineId': 'm',
        'name': f.app.stateOf('m')!.machine.displayName,
        'cwd': '/work/project',
        'scope': 'swarm',
        'engines': ['claude', 'codex'],
        'maxAgents': 8,
      });
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'machine settings keep a stored limit below the maximum as At most, and save the new number',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner', 'maxAgents': 2},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openConfigureDialog(
        tester,
        f,
        c,
        readLocal: (_) async => _reading(freeGiB: 16),
      );

      // The machine's own 2, not the 16 its memory allows: an owner who opens
      // this form and saves it keeps what they had chosen.
      expect(_agentsChoice(tester), 'atMost');
      expect(_limit(tester), '2');
      await tester.tap(_limitStep('more'));
      await tester.pumpAndSettle();
      await tester.tap(_limitStep('more'));
      await tester.pumpAndSettle();
      expect(_limit(tester), '4');

      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await _settleSave(tester);
      expect(find.byType(SuperTabDetailDialog), findsNothing);
      expect(f.connection.server.posts.single['command']!['maxAgents'], 4);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'choosing As memory allows saves the machine’s maximum: 96 for 192 GiB',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.maxAvailableAgents = 96;
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner', 'maxAgents': 16},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openConfigureDialog(
        tester,
        f,
        c,
        readLocal: (_) async => _reading(totalGiB: 192, freeGiB: 100),
      );

      expect(_agentsChoice(tester), 'atMost');
      expect(_limit(tester), '16');
      await tester.tap(find.byKey(const ValueKey('machine-agents-memory')));
      await tester.pumpAndSettle();
      expect(_agentsChoice(tester), 'memory');

      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await _settleSave(tester);
      expect(f.connection.server.posts.single['command']!['maxAgents'], 96);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets('changing the At most number chooses At most', (tester) async {
    final f = SuperTabLaunchFixture();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    f.connection.maxAvailableAgents = 16;
    f.connection.server.state['machines'] = [
      {'machineId': 'm', 'contributorId': 'owner', 'maxAgents': 16},
    ];
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    await _openConfigureDialog(
      tester,
      f,
      c,
      readLocal: (_) async => _reading(totalGiB: 32, freeGiB: 1),
    );

    expect(_agentsChoice(tester), 'memory');
    // At the maximum there is nothing above it: the number starts at what
    // the machine's memory alone would suggest, half of it.
    expect(_limit(tester), '8');
    await tester.tap(_limitStep('fewer'));
    await tester.pumpAndSettle();
    expect(_agentsChoice(tester), 'atMost');
    expect(_limit(tester), '7');

    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await _settleSave(tester);
    expect(f.connection.server.posts.single['command']!['maxAgents'], 7);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  });

  testWidgets(
    'a stored limit above what memory allows opens as As memory allows and saves the maximum',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.maxAvailableAgents = 8;
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner', 'maxAgents': 12},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openConfigureDialog(
        tester,
        f,
        c,
        readLocal: (_) async => _reading(totalGiB: 16, freeGiB: 1),
      );

      expect(_agentsChoice(tester), 'memory');
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await _settleSave(tester);
      expect(f.connection.server.posts.single['command']!['maxAgents'], 8);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'machine settings keep the owner’s number when memory cannot be read',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner', 'maxAgents': 12},
      ];
      // Setup will say this machine allows only 8, but only after Save is
      // pressed: what the owner saw, At most 12, is what saves.
      f.connection.maxAvailableAgents = 8;
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openConfigureDialog(tester, f, c, readLocal: (_) async => null);

      // Nothing says how much this machine's memory allows, so its own 12 is
      // the most the field can offer, and it is kept.
      expect(_agentsChoice(tester), 'atMost');
      expect(_limit(tester), '12');
      expect(_limitButton(tester, 'more').onPressed, isNull);
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await _settleSave(tester);
      expect(f.connection.server.posts.single['command']!['maxAgents'], 12);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'machine settings read the memory the machine reported to the Swarm',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.maxAvailableAgents = 8;
      f.connection.server.state['machines'] = [
        {
          'machineId': 'm',
          'contributorId': 'owner',
          'maxAgents': 8,
          'observation': {
            'receivedAt': DateTime.now().millisecondsSinceEpoch,
            'resources': {
              'memoryUsedBytes': 4 * 1024 * 1024 * 1024,
              'memoryTotalBytes': 16 * 1024 * 1024 * 1024,
            },
          },
        },
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      // This Desktop's own reading does not answer; the Swarm's does.
      await _openConfigureDialog(tester, f, c, readLocal: (_) async => null);

      expect(_agentsChoice(tester), 'memory');
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'an unconfirmed save is checked first, then the number on screen saves',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner', 'maxAgents': 4},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openConfigureDialog(
        tester,
        f,
        c,
        readLocal: (_) async => _reading(totalGiB: 16, freeGiB: 8),
      );
      // The first attempt reaches the server and its reply is lost, which
      // leaves that attempt holding its own receipt — the state the next press
      // finds.
      f.connection.server.loseReply = true;
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await _settleSave(tester);
      expect(find.byType(SuperTabDetailDialog), findsOneWidget);
      expect(f.connection.server.posts.single['command']!['maxAgents'], 4);

      // The owner changes their mind before trying again.
      await tester.tap(_limitStep('more'));
      await tester.pumpAndSettle();
      await tester.tap(_limitStep('more'));
      await tester.pumpAndSettle();
      expect(_limit(tester), '6');

      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await _settleSave(tester);
      expect(find.byType(SuperTabDetailDialog), findsNothing);
      // The stored attempt is settled first, and then the six on screen — the
      // four it was built with is not what the machine ends up with.
      expect(f.connection.server.posts.last['command']!['maxAgents'], 6);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Remove from this Swarm in machine settings asks the removal question',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner', 'maxAgents': 4},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openConfigureDialog(tester, f, c, readLocal: (_) async => null);

      await tester.tap(
        find.widgetWithText(TextButton, 'Remove from this Swarm'),
      );
      await tester.pumpAndSettle();
      final name = superTabMachineName(f.app.stateOf('m')!.machine.displayName);
      expect(find.text('Remove $name from this Swarm?'), findsOneWidget);
      expect(find.byKey(const ValueKey('machine-agents')), findsNothing);
      // Asking sends nothing.
      expect(f.connection.server.posts, isEmpty);

      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets('only the machine’s owner sees its settings', (tester) async {
    final f = SuperTabLaunchFixture();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    f.connection.server.state['machines'] = [
      {'machineId': 'm', 'contributorId': 'teammate', 'maxAgents': 4},
    ];
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 300,
            height: 400,
            child: SuperTabMachines(
              controller: c,
              app: f.app,
              onAddAgent: (_) {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await openMachineDetails(
      tester,
      find.byKey(const ValueKey('super-machine-m')),
    );
    expect(find.widgetWithText(TextButton, 'Configure'), findsNothing);

    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  });

  testWidgets(
    'the Agents choice is one Tab stop, and Up selects As memory allows',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner', 'maxAgents': 2},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openConfigureDialog(
        tester,
        f,
        c,
        readLocal: (_) async => _reading(freeGiB: 16),
      );
      expect(_agentsChoice(tester), 'atMost');

      /// The choice keyboard focus is on, or null.
      String? focusedChoice() => FocusManager.instance.primaryFocus?.context
          ?.findAncestorWidgetOfExactType<RadioListTile<String>>()
          ?.value;

      // A full trip round the dialog stops on the choice once.
      final stops = <String?>[];
      FocusNode? first;
      for (var i = 0; i < 30; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump();
        final node = FocusManager.instance.primaryFocus;
        if (first == null) {
          first = node;
        } else if (identical(node, first)) {
          break;
        }
        stops.add(focusedChoice());
      }
      expect(stops.whereType<String>().toList(), ['atMost']);

      // On it, Up moves the choice.
      while (focusedChoice() == null) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump();
      }
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
      await tester.pumpAndSettle();
      expect(_agentsChoice(tester), 'memory');

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'a screen reader can change the At most number apart from the choice',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner', 'maxAgents': 2},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openConfigureDialog(
        tester,
        f,
        c,
        readLocal: (_) async => _reading(freeGiB: 16),
      );

      // The number is its own adjustable control, not part of the At most
      // choice's single tap target.
      final number = find.bySemanticsLabel('Most agents');
      expect(
        tester.getSemantics(number),
        isSemantics(
          value: '2',
          increasedValue: '3',
          decreasedValue: '1',
          hasIncreaseAction: true,
          hasDecreaseAction: true,
        ),
      );
      final more = tester.getSemantics(find.byTooltip('More agents'));
      expect(
        more,
        isSemantics(isButton: true, hasTapAction: true, tooltip: 'More agents'),
      );
      expect(
        more.id,
        isNot(
          tester
              .getSemantics(
                find.byKey(const ValueKey('machine-agents-at-most')),
              )
              .id,
        ),
      );
      tester.semantics.increase(find.semantics.byLabel('Most agents'));
      await tester.pumpAndSettle();
      expect(_limit(tester), '3');
      expect(_agentsChoice(tester), 'atMost');
      semantics.dispose();

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'a machine with no stored number opens at At most its suggested number',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner'},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      // 32 GiB: sixteen allowed, eight suggested.
      await _openConfigureDialog(
        tester,
        f,
        c,
        readLocal: (_) async => _reading(totalGiB: 32, freeGiB: 1),
      );

      expect(_agentsChoice(tester), 'atMost');
      expect(_limit(tester), '8');
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await _settleSave(tester);
      expect(f.connection.server.posts.single['command']!['maxAgents'], 8);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'with no stored number and no reading, At most opens at four and saves four',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner'},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openConfigureDialog(tester, f, c, readLocal: (_) async => null);

      // Every machine may offer four, whatever its memory.
      expect(_agentsChoice(tester), 'atMost');
      expect(_limit(tester), '4');
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await _settleSave(tester);
      expect(f.connection.server.posts.single['command']!['maxAgents'], 4);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'an offline machine’s settings say why Save is off, in settings’ words',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner', 'maxAgents': 4},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      f.app.machineStates['m']!.nodeOnline = false;
      await _openConfigureDialog(tester, f, c, readLocal: (_) async => null);

      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, 'Save'))
            .onPressed,
        isNull,
      );
      expect(
        // The machine by name: "this computer" is the one you're on.
        find.text('Offline. Open Harness on Test host to change its settings.'),
        findsOneWidget,
      );
      expect(find.textContaining('to add it'), findsNothing);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'settings of a machine this computer does not list say why Save is off',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {
          'machineId': 'elsewhere',
          'name': 'Studio',
          'contributorId': 'owner',
          'maxAgents': 4,
        },
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 300,
              height: 400,
              child: SuperTabMachines(
                controller: c,
                app: f.app,
                onAddAgent: (_) {},
                readLocal: (_) async => null,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await openMachineDetails(
        tester,
        find.byKey(const ValueKey('super-machine-elsewhere')),
      );
      await tester.tap(find.widgetWithText(TextButton, 'Configure'));
      await tester.pumpAndSettle();

      expect(find.text('Studio'), findsWidgets);
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, 'Save'))
            .onPressed,
        isNull,
      );
      expect(
        find.text(
          'This computer can’t reach that machine. Sign in to Harness there with this account to change its settings.',
        ),
        findsOneWidget,
      );

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'At most stops at 1 and at the machine’s eight-agent memory limit',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner', 'maxAgents': 3},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openConfigureDialog(
        tester,
        f,
        c,
        readLocal: (_) async => _reading(totalGiB: 16, freeGiB: 1),
      );

      expect(_limit(tester), '3');
      for (var i = 0; i < 5; i++) {
        await tester.tap(_limitStep('more'));
        await tester.pumpAndSettle();
      }
      expect(_limit(tester), '8');
      // Neither end is a press that lands and does nothing: the button is dead.
      expect(_limitButton(tester, 'more').onPressed, isNull);
      expect(_limitButton(tester, 'fewer').onPressed, isNotNull);

      for (var i = 0; i < 7; i++) {
        await tester.tap(_limitStep('fewer'));
        await tester.pumpAndSettle();
      }
      expect(_limit(tester), '1');
      expect(_limitButton(tester, 'fewer').onPressed, isNull);
      expect(_limitButton(tester, 'more').onPressed, isNotNull);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  // Ken, 2026-10-28: work kept landing on engines that could not run on a machine. The only visible change: an engine that
  // is out of quota or suspended there has its name struck through in the machine's Subscriptions, with why on hover.
  testWidgets(
    'strikes through an engine out of quota or suspended on a machine, with why on hover',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(900, 1400));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = ConversationServer();
      const suspended =
          'Claude Code is suspended on this machine for new work: its last 2 starts there failed. It is offered again within 6 hours, or once its owner resumes it.';
      server.state['machines'] = [
        {
          'machineId': 'm',
          'name': 'Studio',
          'contributorId': 'owner',
          'suspendedEngines': {'claude': suspended},
          'observation': {
            'receivedAt': DateTime.now().millisecondsSinceEpoch,
            'resources': {'cpuPercent': 10},
            'quotas': [
              {'engine': 'claude', 'known': false, 'windows': []},
              {
                'engine': 'codex',
                'known': true,
                'windows': [
                  {'name': 'weekly', 'usedPercent': 100},
                ],
              },
            ],
          },
        },
      ];
      final c = server.controller();
      await c.refresh();
      c.toggleMachineExpanded('m');
      await tester.pumpWidget(
        MaterialApp(
          // As the sidebar does: the section is rebuilt whenever the Swarm changes.
          home: Scaffold(
            body: ListenableBuilder(
              listenable: c,
              builder: (context, _) => SuperTabMachines(
                controller: c,
                embedded: true,
                onAddAgent: (_) {},
                onOpenAgent: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      TextDecoration? decoration(String engine, String name) => tester
          .widget<Text>(
            find.descendant(
              of: find.byKey(ValueKey('super-machine-allowance-m-$engine')),
              matching: find.text(name),
            ),
          )
          .style
          ?.decoration;
      String tip(String engine) => tester
          .widget<Tooltip>(
            find
                .ancestor(
                  of: find.byKey(ValueKey('super-machine-allowance-m-$engine')),
                  matching: find.byType(Tooltip),
                )
                .first,
          )
          .message!;
      // Suspended with its allowance unknown: a card all the same, with a dash for the figure.
      expect(decoration('claude', 'Claude Code'), TextDecoration.lineThrough);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('super-machine-allowance-m-claude')),
          matching: find.text('—'),
        ),
        findsOneWidget,
      );
      expect(tip('claude'), startsWith(suspended));
      // Out of quota: struck, its figure kept.
      expect(decoration('codex', 'Codex'), TextDecoration.lineThrough);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('super-machine-allowance-m-codex')),
          matching: find.text('0%'),
        ),
        findsOneWidget,
      );
      expect(
        tip('codex'),
        startsWith(
          'Not used for new work here: no quota left until it resets.',
        ),
      );
      expect(tester.takeException(), isNull);

      // Once neither holds, nothing is struck.
      server.state['machines'] = [
        {
          'machineId': 'm',
          'name': 'Studio',
          'contributorId': 'owner',
          'observation': {
            'receivedAt': DateTime.now().millisecondsSinceEpoch,
            'resources': {'cpuPercent': 10},
            'quotas': [
              for (final engine in ['claude', 'codex'])
                {
                  'engine': engine,
                  'known': true,
                  'windows': [
                    {'name': 'weekly', 'usedPercent': 40},
                  ],
                },
            ],
          },
        },
      ];
      await c.refresh();
      await tester.pumpAndSettle();
      expect(
        decoration('claude', 'Claude Code'),
        isNot(TextDecoration.lineThrough),
      );
      expect(decoration('codex', 'Codex'), isNot(TextDecoration.lineThrough));
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );
}

/// A hardware reading's value in a machine's expanded readings.
String? _hw(WidgetTester tester, String id, String name) => tester
    .widget<Text>(find.byKey(ValueKey('super-machine-hw-$id-$name')))
    .data;
