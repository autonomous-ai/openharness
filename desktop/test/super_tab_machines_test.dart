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
import 'package:harness/state/app_state.dart';
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

Future<void> _openAddMachineDialog(
  WidgetTester tester,
  SuperTabLaunchFixture f,
  dynamic c, {
  Brightness brightness = Brightness.dark,
  double textScale = 1,
  Future<MachineResources?> Function(String)? readLocal,
}) async {
  final previousBrightness = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previousBrightness);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(textScale)),
        child: child!,
      ),
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
  await tester.tap(find.byTooltip('Add machine'));
  await tester.pumpAndSettle();
}

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

Finder _option(String id) => find.byKey(ValueKey('swarm-machine-option-$id'));

/// The number the Agent slots stepper reads.
String? _agentSlots(WidgetTester tester) =>
    tester.widget<Text>(find.byKey(const ValueKey('agent-slots-value'))).data;

Finder _slotsStep(String direction) =>
    find.byKey(ValueKey('agent-slots-$direction'));

/// Both ends of the range are the controls going dead, not a press that lands
/// and does nothing.
AppIconButton _slotsButton(WidgetTester tester, String direction) =>
    tester.widget<AppIconButton>(_slotsStep(direction));

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
    Future<dynamic> mount(WidgetTester tester, int agents) async {
      final server = ConversationServer();
      server.state['agents'] = [
        for (var i = 0; i < agents; i++)
          {
            'id': 'a$i',
            'name': 'Agent $i',
            'displayName': 'Agent $i',
            'machineId': 'm',
            'harnessId': 'native-a$i',
            'contributorId': 'owner',
            'configuration': {'engine': 'codex'},
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
      await tester.tap(find.byKey(const ValueKey('super-detail-more')));
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
      expect(
        find.text(
          'Mira is the Product Manager of project Pilot. Delete the project first.',
        ),
        findsOneWidget,
      );
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
          find.textContaining('Product Manager of project Pilot'),
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
                matching: find.textContaining(
                  '70% left · resets in ',
                ),
              ),
              findsOneWidget,
            );
            expect(
              find.descendant(
                of: details,
                matching: find.textContaining(
                  '90% left · resets in ',
                ),
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
  testWidgets('Add machine shows a long hostname whole, over two lines if it must', (tester) async {
    final f = SuperTabLaunchFixture();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    const host = 'autonomous-code-vm-01.c.autonomous-code.internal';
    f.app.machineStates['m']!.machine = f.app.machineStates['m']!.machine.copyWith(name: host);
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SizedBox(
            width: 300,
            height: 400,
            child: SuperTabMachines(
              controller: c,
              app: f.app,
              onAddAgent: (_) {},
              readLocal: (_) async => _reading(freeGiB: 8),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Add machine'));
    await tester.pumpAndSettle();
    final label = find.descendant(of: _picker, matching: find.textContaining(host));
    expect(label, findsOneWidget);
    final paragraph = tester.renderObject<RenderParagraph>(label);
    expect(paragraph.didExceedMaxLines, isFalse, reason: 'the whole hostname is readable');
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  });

  testWidgets(
    'Add machine has one field and contributes the prepared project and installed engines',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['project'] = {
        'machineId': 'm',
        'cwd': '/work/project',
        'scope': 'swarm',
        'repositoryUrl': null,
      };
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
                readLocal: (_) async => _reading(freeGiB: 8),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Add machine'));
      await tester.pumpAndSettle();
      // One short paragraph instead of three (Ken, 2026-10-28).
      expect(
        find.text(
          "The Swarm's product managers can start agents here with this machine's signed-in accounts. "
          'They run without asking for permission, in projects cloned to ~/harnesses/swarms.',
        ),
        findsOneWidget,
      );
      expect(find.textContaining('Harness clones each project'), findsNothing);
      expect(_picker, findsOneWidget);
      expect(
        find.text('This Mac (${f.app.stateOf('m')!.machine.displayName})'),
        findsOneWidget,
      );
      expect(find.byType(Checkbox), findsNothing);
      expect(find.text('Choose project folder'), findsNothing);
      await tester.tap(find.widgetWithText(FilledButton, 'Add machine'));
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
      expect(f.connection.calls.where((c) => c.$1 == 'agent_create'), isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Add machine: the lead runs on This Mac but it is not contributed yet, so "+" still offers it',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['agents'] = [
        {
          'id': 'lead-agent',
          'name': 'Lead',
          'machineId': 'm',
          'harnessId': 'native-lead',
          'contributorId': 'owner',
          'configuration': {'engine': 'codex'},
        },
      ];
      (f.connection.server.state['conversations'] as List)[0]['leadId'] =
          'lead-agent';
      (f.connection.server.state['conversations'] as List)[0]['agentIds'] = [
        'lead-agent',
      ];
      f.connection.server.state['project'] = {
        'machineId': 'm',
        'cwd': '/work/project',
        'repositoryUrl': null,
      };
      // No 'machines' entry: an agent running on This Mac does not mean it
      // was ever contributed to this tab.
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);

      expect(_picker, findsOneWidget);
      expect(
        find.text('This Mac (${f.app.stateOf('m')!.machine.displayName})'),
        findsOneWidget,
      );
      final button = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Add machine'),
      );
      expect(button.onPressed, isNotNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Add machine: already-contributed machines remain visible but cannot be added again',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner'},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);

      expect(_picker, findsOneWidget);
      expect(find.text('Choose a machine'), findsOneWidget);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Add machine'),
            )
            .onPressed,
        isNull,
      );
      expect(find.textContaining('Already in this tab:'), findsNothing);
      await tester.tap(_picker);
      await tester.pumpAndSettle();
      expect(tester.widget<MenuItemButton>(_option('m')).onPressed, isNull);
      expect(find.byTooltip('Already in this Swarm'), findsOneWidget);
      await tester.tap(_option('m'));
      await tester.pumpAndSettle();
      expect(find.text('Choose a machine'), findsOneWidget);
      expect(f.connection.server.posts, isEmpty);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Add machine: an available owned machine is selected ahead of an already-contributed one',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner'},
      ];
      const other = Machine(
        machineId: 'm2',
        authMode: MachineAuthMode.remote,
        name: 'Other Mac',
      );
      f.app.machines = [...f.app.machines, other];
      f.app.machineStates['m2'] = MachineState(other)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded;
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);

      expect(_picker, findsOneWidget);
      expect(find.text('Other Mac'), findsOneWidget);
      expect(
        find.text('This Mac (${f.app.stateOf('m')!.machine.displayName})'),
        findsNothing,
      );
      expect(find.textContaining('Already in this tab:'), findsNothing);
      final button = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Add machine'),
      );
      expect(button.onPressed, isNotNull);
      await tester.tap(_picker);
      await tester.pumpAndSettle();
      expect(tester.widget<MenuItemButton>(_option('m')).onPressed, isNull);
      expect(tester.widget<MenuItemButton>(_option('m2')).onPressed, isNotNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Add machine: a Mac\'s Harness Team account in the Swarm is not offered beside its Mac; it joins and leaves with the Mac',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      // Its pool names the Mac (stamped by the backend); the account's machine itself is an ordinary one to the app.
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner'},
        {'machineId': 'm-team', 'contributorId': 'owner', 'hostMachineId': 'm'},
      ];
      const team = Machine(
        machineId: 'm-team',
        authMode: MachineAuthMode.remote,
        name: 'This Mac · Team',
      );
      f.app.machines = [...f.app.machines, team];
      f.app.machineStates['m-team'] = MachineState(team)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded;
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);

      await tester.tap(_picker);
      await tester.pumpAndSettle();
      expect(_option('m'), findsOneWidget);
      expect(_option('m-team'), findsNothing);
      expect(find.textContaining('This Mac · Team'), findsNothing);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Add machine: offline and unlinked owned machines are disabled with status tooltips; shared machines stay excluded',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      const offline = Machine(
        machineId: 'm3',
        authMode: MachineAuthMode.remote,
        name: 'macbok test local',
      );
      f.app.machines = [...f.app.machines, offline];
      f.app.machineStates['m3'] = MachineState(offline)
        ..nodeOnline = false
        ..connectionStatus = ConnectionStatus.disconnected
        ..agentLoadStatus = AgentLoadStatus.loaded;
      const unlinked = Machine(
        machineId: 'm4',
        authMode: MachineAuthMode.remote,
        name: 'Studio Mac',
      );
      const sharedHarness = Machine(
        machineId: 'm5',
        authMode: MachineAuthMode.remote,
        name: 'Another account’s harness',
        isShared: true,
      );
      const sharedMachine = Machine(
        machineId: 'm6',
        authMode: MachineAuthMode.remote,
        name: 'Another account’s computer',
        machineShare: MachineShare(
          ownerName: 'Another owner',
          ownerEmail: 'another@example.com',
          via: 'email',
          added: true,
        ),
      );
      for (final machine in [unlinked, sharedHarness, sharedMachine]) {
        f.app.machineStates[machine.machineId] = MachineState(machine)
          ..nodeOnline = true
          ..connectionStatus = ConnectionStatus.connected;
      }
      f.app.machineStates['m4']!.needsLink = true;
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);

      expect(_picker, findsOneWidget);
      expect(find.text('macbok test local'), findsNothing);
      expect(find.textContaining('Offline:'), findsNothing);
      expect(find.textContaining('Not linked:'), findsNothing);
      await tester.tap(_picker);
      await tester.pumpAndSettle();
      expect(tester.widget<MenuItemButton>(_option('m3')).onPressed, isNull);
      expect(tester.widget<MenuItemButton>(_option('m4')).onPressed, isNull);
      expect(_option('m5'), findsNothing);
      expect(_option('m6'), findsNothing);
      const offlineHint = 'Offline. Open Harness on this computer to add it.';
      expect(find.byTooltip(offlineHint), findsOneWidget);
      expect(
        find.byTooltip('Not linked. Link this computer from Machines.'),
        findsOneWidget,
      );
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      await mouse.moveTo(tester.getCenter(find.byTooltip(offlineHint)));
      await tester.pumpAndSettle(const Duration(milliseconds: 800));
      expect(find.text(offlineHint), findsOneWidget);
      await tester.tap(_option('m3'));
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: _picker,
          matching: find.text(
            'This Mac (${f.app.stateOf('m')!.machine.displayName})',
          ),
        ),
        findsOneWidget,
      );
      expect(f.connection.server.posts, isEmpty);
      await mouse.removePointer();

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Machine picker skips unavailable rows with the keyboard and returns focus to the field',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      for (final (id, name, online) in [
        ('m2', 'Offline Mac', false),
        ('m3', 'Studio Mac', true),
      ]) {
        final machine = Machine(
          machineId: id,
          authMode: MachineAuthMode.remote,
          name: name,
        );
        f.app.machineStates[id] = MachineState(machine)
          ..nodeOnline = online
          ..connectionStatus = online
              ? ConnectionStatus.connected
              : ConnectionStatus.disconnected;
      }
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);
      await tester.tap(_picker);
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(
        find.descendant(of: _picker, matching: find.text('Studio Mac')),
        findsOneWidget,
      );
      expect(f.connection.server.posts, isEmpty);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pumpAndSettle();
      expect(_option('m2'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byType(SuperTabDetailDialog), findsOneWidget);
      expect(_option('m2'), findsNothing);
      expect(tester.widget<TextButton>(_picker).focusNode!.hasFocus, isTrue);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'A machine that goes offline while the form is open cannot be submitted',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);
      f.app.machineStates['m']!.nodeOnline = false;
      await tester.tap(find.widgetWithText(FilledButton, 'Add machine'));
      await tester.pumpAndSettle();
      expect(f.connection.server.posts, isEmpty);
      expect(
        f.connection.calls.where(
          (call) =>
              call.$1 == 'super_tabs' &&
              call.$2['action'] == 'prepareContribution',
        ),
        isEmpty,
      );
      expect(find.byType(SuperTabDetailDialog), findsOneWidget);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  for (final brightness in Brightness.values) {
    testWidgets(
      'Machine picker handles unavailable long names at 2x text in ${brightness.name}',
      (tester) async {
        tester.view.physicalSize = const Size(540, 800);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final f = SuperTabLaunchFixture();
        f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
        f.app.machineStates['m']!.nodeOnline = false;
        const unlinked = Machine(
          machineId: 'studio',
          authMode: MachineAuthMode.remote,
          name: 'Design Studio’s MacBook Pro with a long custom machine name',
        );
        f.app.machineStates['studio'] = MachineState(unlinked)
          ..nodeOnline = true
          ..needsLink = true;
        final c = await f.app.superTabs.open(tabId);
        await c.refresh();
        await _openAddMachineDialog(
          tester,
          f,
          c,
          brightness: brightness,
          textScale: 2,
        );
        expect(
          tester
              .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'Add machine'),
              )
              .onPressed,
          isNull,
        );
        await tester.tap(_picker);
        await tester.pumpAndSettle();
        expect(tester.widget<MenuItemButton>(_option('m')).onPressed, isNull);
        expect(
          tester.widget<MenuItemButton>(_option('studio')).onPressed,
          isNull,
        );
        expect(tester.takeException(), isNull);

        await tester.pumpWidget(const SizedBox());
        await c.flush();
        f.app.superTabs.dispose();
        await tester.pump();
      },
    );
  }

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
    'Configure on a machine card reads as editing: title "Configure machine", button "Save"',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner'},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      // Never reported, so offline: under the disclosure.
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
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Configure'));
      await tester.pumpAndSettle();

      expect(find.text('Configure machine'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Save'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Add machine'), findsNothing);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Add machine starts at the suggested slots and contributes the number the owner picks',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['project'] = {
        'machineId': 'm',
        'cwd': '/work/project',
        'scope': 'swarm',
        'repositoryUrl': null,
      };
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      // 16 GiB total offers eight slots and suggests four, even with eight free.
      await _openAddMachineDialog(
        tester,
        f,
        c,
        readLocal: (_) async => _reading(totalGiB: 16, freeGiB: 8),
      );

      // Total memory suggests four, so the field opens there.
      expect(_agentSlots(tester), '4');
      expect(
        find.text('Each new agent still needs free memory when it starts.'),
        findsOneWidget,
      );
      // Opening the form sets nothing up on the machine — no project folder,
      // no engine probe, no setup slot — until the owner saves.
      expect(
        f.connection.calls.where(
          (call) =>
              call.$1 == 'super_tabs' &&
              call.$2['action'] == 'prepareContribution',
        ),
        isEmpty,
      );

      // What the owner picks is what goes out — the suggestion is only a start.
      // Stepped off it and back, so the number that saves is the one in the
      // field rather than the one the memory reading happened to offer.
      await tester.tap(_slotsStep('fewer'));
      await tester.pumpAndSettle();
      expect(_agentSlots(tester), '3');
      await tester.tap(_slotsStep('more'));
      await tester.pumpAndSettle();
      expect(_agentSlots(tester), '4');

      await tester.tap(find.widgetWithText(FilledButton, 'Add machine'));
      await _settleSave(tester);
      expect(find.byType(SuperTabDetailDialog), findsNothing);
      expect(f.connection.server.posts.single['command'], {
        'type': 'machine.contribute',
        'machineId': 'm',
        'name': f.app.stateOf('m')!.machine.displayName,
        'cwd': '/work/project',
        'scope': 'swarm',
        'engines': ['claude', 'codex'],
        'maxAgents': 4,
      });
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  // Every 2 GiB of total RAM may run an agent, and every machine may offer
  // four; the suggestion keeps its 16 (Ken, 2026-10-28).
  for (final (totalGiB, suggested, maximum) in [
    (32.0, 8, 16),
    (16.0, 4, 8),
    (64.0, 16, 32),
    (192.0, 16, 96),
    (8.0, 2, 4),
    (2.0, 1, 4),
  ]) {
    testWidgets(
      'Add machine with $totalGiB GiB total offers $suggested of $maximum slots',
      (tester) async {
        final f = SuperTabLaunchFixture();
        f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
        final c = await f.app.superTabs.open(tabId);
        await c.refresh();
        await _openAddMachineDialog(
          tester,
          f,
          c,
          readLocal: (_) async => _reading(totalGiB: totalGiB, freeGiB: 1),
        );

        expect(_agentSlots(tester), '$suggested');
        for (var slot = suggested; slot < maximum; slot++) {
          await tester.tap(_slotsStep('more'));
          await tester.pumpAndSettle();
        }
        expect(_agentSlots(tester), '$maximum');
        expect(_slotsButton(tester, 'more').onPressed, isNull);
        expect(tester.takeException(), isNull);

        await tester.pumpWidget(const SizedBox());
        await c.flush();
        f.app.superTabs.dispose();
        await tester.pump();
      },
    );
  }

  testWidgets('Configure lets a 192 GiB machine offer 96 agents', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
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

    expect(_agentSlots(tester), '16');
    for (var slot = 16; slot < 96; slot++) {
      await tester.tap(_slotsStep('more'));
      await tester.pump();
    }
    expect(_agentSlots(tester), '96');
    expect(_slotsButton(tester, 'more').onPressed, isNull);
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await _settleSave(tester);
    expect(f.connection.server.posts.single['command']!['maxAgents'], 96);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  });

  testWidgets(
    'Configure keeps the owner’s 12 slots even when total RAM offers eight',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
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

      expect(_agentSlots(tester), '12');
      expect(_slotsButton(tester, 'more').onPressed, isNull);
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

  testWidgets('Configure keeps the owner’s slots when RAM cannot be read', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    f.connection.server.state['machines'] = [
      {'machineId': 'm', 'contributorId': 'owner', 'maxAgents': 12},
    ];
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    await _openConfigureDialog(tester, f, c, readLocal: (_) async => null);

    expect(_agentSlots(tester), '12');
    expect(_slotsButton(tester, 'more').onPressed, isNull);
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await _settleSave(tester);
    expect(f.connection.server.posts.single['command']!['maxAgents'], 12);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  });

  testWidgets(
    'Configure starts at the machine’s own slots and saves the new number',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner', 'maxAgents': 2},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      // Sixteen gibibytes free would suggest 8: this machine's own 2 is what
      // the field shows, because its own number is not a suggestion.
      await _openConfigureDialog(
        tester,
        f,
        c,
        readLocal: (_) async => _reading(freeGiB: 16),
      );

      // The machine's own number — 2, not the 8 its memory would suggest: an
      // owner who opens this form and saves it keeps what they had chosen.
      expect(_agentSlots(tester), '2');
      await tester.tap(_slotsStep('more'));
      await tester.pumpAndSettle();
      await tester.tap(_slotsStep('more'));
      await tester.pumpAndSettle();
      expect(_agentSlots(tester), '4');

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
        'maxAgents': 4,
      });
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'an unconfirmed contribution is checked first, then the number on screen saves',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['project'] = {
        'machineId': 'm',
        'cwd': '/work/project',
        'scope': 'swarm',
        'repositoryUrl': null,
      };
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(
        tester,
        f,
        c,
        readLocal: (_) async => _reading(totalGiB: 16, freeGiB: 8),
      );
      // The first attempt reaches the server and its reply is lost, which
      // leaves that attempt holding its own receipt — the state the next press
      // finds.
      f.connection.server.loseReply = true;
      await tester.tap(find.widgetWithText(FilledButton, 'Add machine'));
      await _settleSave(tester);
      expect(find.byType(SuperTabDetailDialog), findsOneWidget);
      expect(f.connection.server.posts.single['command']!['maxAgents'], 4);

      // The owner changes their mind before trying again.
      await tester.tap(_slotsStep('more'));
      await tester.pumpAndSettle();
      await tester.tap(_slotsStep('more'));
      await tester.pumpAndSettle();
      expect(_agentSlots(tester), '6');

      await tester.tap(find.widgetWithText(FilledButton, 'Add machine'));
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
    'a new machine no reading answered for contributes what was suggested',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['project'] = {
        'machineId': 'm',
        'cwd': '/work/project',
        'scope': 'swarm',
        'repositoryUrl': null,
      };
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      // This machine's memory does not answer — a reading that failed or had
      // not arrived — so the field has no suggestion of its own and sits at
      // the floor of the range.
      await _openAddMachineDialog(tester, f, c, readLocal: (_) async => null);
      expect(_agentSlots(tester), '1');

      // The owner never touched it, so the 1 is not a number they chose and
      // must not be what the machine is contributed with: preparation's own
      // suggestion is the number the field would have shown.
      await tester.tap(find.widgetWithText(FilledButton, 'Add machine'));
      await _settleSave(tester);
      expect(find.byType(SuperTabDetailDialog), findsNothing);
      expect(f.connection.server.posts.single['command']!['maxAgents'], 8);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'a check of an earlier attempt that fails says why that attempt is unclear',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['project'] = {
        'machineId': 'm',
        'cwd': '/work/project',
        'scope': 'swarm',
        'repositoryUrl': null,
      };
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(
        tester,
        f,
        c,
        readLocal: (_) async => _reading(freeGiB: 8),
      );
      f.connection.server.loseReply = true;
      await tester.tap(find.widgetWithText(FilledButton, 'Add machine'));
      await _settleSave(tester);
      expect(find.byType(SuperTabDetailDialog), findsOneWidget);

      // Now the earlier attempt cannot be checked either, and the reason it
      // gives is the one worth reading.
      f.connection.server.refuse = {
        'code': 'MACHINE_NOT_FOUND',
        'message': 'This machine is no longer linked to this Swarm.',
      };
      await tester.tap(find.widgetWithText(FilledButton, 'Add machine'));
      await _settleSave(tester);
      expect(find.byType(SuperTabDetailDialog), findsOneWidget);
      expect(
        find.text('This machine is no longer linked to this Swarm.'),
        findsOneWidget,
      );
      expect(find.textContaining('Could not add this machine'), findsNothing);
      // The check re-sent the attempt it was already holding, untouched, and
      // no second, new one followed it out.
      expect(f.connection.server.posts, hasLength(2));
      expect(
        f.connection.server.posts.last['command'],
        f.connection.server.posts.first['command'],
      );
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets('a machine already set to 16 keeps that number when configured', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    // The backend accepts 16, and opening Configure must preserve that choice.
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

    expect(_agentSlots(tester), '16');
    expect(_slotsButton(tester, 'more').onPressed, isNull);
    expect(_slotsButton(tester, 'fewer').onPressed, isNotNull);

    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await _settleSave(tester);
    // The owner’s chosen 16 is still sent unchanged.
    expect(f.connection.server.posts.single['command'], {
      'type': 'machine.contribute',
      'machineId': 'm',
      'name': f.app.stateOf('m')!.machine.displayName,
      'cwd': '/work/project',
      'scope': 'swarm',
      'engines': ['claude', 'codex'],
      'maxAgents': 16,
    });
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  });

  testWidgets('Agent slots stop at 1 and the machine’s eight-slot RAM limit', (
    tester,
  ) async {
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

    expect(_agentSlots(tester), '3');
    for (var i = 0; i < 5; i++) {
      await tester.tap(_slotsStep('more'));
      await tester.pumpAndSettle();
    }
    expect(_agentSlots(tester), '8');
    // Neither end is a press that lands and does nothing: the button is dead.
    expect(_slotsButton(tester, 'more').onPressed, isNull);
    expect(_slotsButton(tester, 'fewer').onPressed, isNotNull);

    for (var i = 0; i < 7; i++) {
      await tester.tap(_slotsStep('fewer'));
      await tester.pumpAndSettle();
    }
    expect(_agentSlots(tester), '1');
    expect(_slotsButton(tester, 'fewer').onPressed, isNull);
    expect(_slotsButton(tester, 'more').onPressed, isNotNull);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  });
}

/// A hardware reading's value in a machine's expanded readings.
String? _hw(WidgetTester tester, String id, String name) => tester
    .widget<Text>(find.byKey(ValueKey('super-machine-hw-$id-$name')))
    .data;
