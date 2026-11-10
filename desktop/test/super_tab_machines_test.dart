import 'dart:io';
import 'dart:ui' show PointerDeviceKind;

import 'package:flutter/gestures.dart' show kSecondaryMouseButton;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_icons.dart';
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
import 'package:harness/widgets/browser_menu_guard.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

class _RemovalServer extends ConversationServer {
  Map<String, dynamic> preview = {
    'previewVersion': 2,
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
    if (method == 'GET' && path.contains('/machines/studio/removal')) {
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

/// A machine's details are in its right-click menu; a click expands it (Dee, 2026-10-27).
Future<void> openMachineDetails(WidgetTester tester, Finder row) async {
  await tester.tap(row, buttons: kSecondaryMouseButton);
  await tester.pumpAndSettle();
  await tester.tap(find.text('Details').last);
  await tester.pumpAndSettle();
}

void main() {
  final capture = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];
  setUpAll(() => loadCaptureFonts(capture));
  test('a computer is shown by its real hostname without ".local", and a name a person chose stays as it is', () {
    for (final (hostname, shown) in [
      ('MacBookPro2021.local', 'MacBookPro2021'),
      ('MacBooks-MacBook-Pro-19.local', 'MacBooks-MacBook-Pro-19'),
      ('MacbookPro.local', 'MacbookPro'),
      ('Mac-mini.local', 'Mac-mini'),
      ('build-server.LOCAL', 'build-server'),
      // A Mac's Harness Team account entry, as the backend reads it (task #3060): its Mac's name, then the label.
      ('Gray.local · Team account', 'Gray · Team account'),
      ('Ada’s Mac · Team account', 'Ada’s Mac · Team account'),
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
      await tester.binding.setSurfaceSize(const Size(1000, 700));
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
      expect(offline, findsOneWidget);
      expect(find.text('Offline · 1'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('super-machine-online')));
      await tester.pumpAndSettle();
      expect(find.byType(SuperTabDetailDialog), findsNothing);
      expect(_hw(tester, 'online', 'CPU'), '0%');
      expect(_hw(tester, 'online', 'RAM'), '0 GB');
      expect(_hw(tester, 'online', 'SSD'), '141 GB');
      expect(
        _tipOf(tester, online),
        'Owned by owner · CPU 100% free · RAM 0 GB free · SSD 141 GB free',
      );
      // Offline: its state in words in the tooltip, never when it was last seen.
      expect(_tipOf(tester, offline), 'Offline · Owned by owner');
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
    'a machine’s owner is named by the name they set (review of #2794)',
    (tester) async {
      final server = ConversationServer();
      server.state['people'] = [
        {
          'id': 'tony',
          'email': 'tony@example.com',
          'role': 'owner',
          'name': 'Tony Tran',
        },
      ];
      server.state['machines'] = [
        {
          'machineId': 't',
          'name': 'MacBook Pro',
          'contributorId': 'tony',
          'observation': {'receivedAt': DateTime.now().millisecondsSinceEpoch},
        },
      ];
      final c = server.controller();
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabMachines(controller: c, onAddAgent: (_) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        _tipOf(tester, find.byKey(const ValueKey('super-machine-t'))),
        'Owned by Tony Tran',
      );
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );

  // Security review 1 of #2234: a Buddy's machine outside the Swarm is its
  // person's alone. Their own Buddy row names it and another person's reaches
  // them with no machine; neither makes a row here.
  testWidgets('no Buddy adds a machine row: not its person\'s private machine, '
      'not another person\'s hidden one', (tester) async {
    final server = ConversationServer();
    Map<String, dynamic> buddy(String id, String machineId, String person) => {
      'id': id,
      'name': 'Buddy',
      'displayName': 'Buddy',
      'machineId': machineId,
      'harnessId': 'native-$id',
      'contributorId': person,
      'configuration': {'engine': 'claude'},
      'buddyOf': {'personId': person, 'generation': 'fixture'},
    };
    server.state['agents'] = [
      buddy('mine', 'private-laptop', 'owner'),
      buddy('theirs', '', 'maya'),
    ];
    server.state['machines'] = [
      {'machineId': 'm', 'name': 'Studio Mac', 'contributorId': 'owner'},
    ];
    final c = server.controller();
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabMachines(controller: c, onAddAgent: (_) {}),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('super-machine-m')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('super-machine-private-laptop')),
      findsNothing,
    );
    expect(find.byKey(const ValueKey('super-machine-')), findsNothing);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  });

  group('an expanded machine shows its agents as one count', () {
    Future<dynamic> mount(
      WidgetTester tester,
      int agents, {
      int buddies = 0,
      Duration age = Duration.zero,
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
            'receivedAt':
                DateTime.now().millisecondsSinceEpoch - age.inMilliseconds,
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

    testWidgets(
      'an offline machine keeps its total and says nothing is running, in the muted ink',
      (tester) async {
        final c = await mount(tester, 34, age: const Duration(minutes: 10));
        final text = find.descendant(
          of: line,
          matching: find.text('34 agents · none running, machine offline'),
        );
        expect(text, findsOneWidget);
        expect(
          tester.widget<Text>(text).style?.color,
          DesktopChrome.control(color: DesktopChrome.muted).color,
        );
        expect(find.textContaining('working'), findsNothing);
        await unmount(tester, c);
      },
    );

    testWidgets(
      'one agent on an offline machine reads "1 agent · none running"',
      (tester) async {
        final c = await mount(tester, 1, age: const Duration(minutes: 10));
        expect(
          find.descendant(
            of: line,
            matching: find.text('1 agent · none running, machine offline'),
          ),
          findsOneWidget,
        );
        await unmount(tester, c);
      },
    );

    testWidgets('one: "1 agent" with a chevron, no avatar and no agent row', (
      tester,
    ) async {
      final c = await mount(tester, 1);
      expect(
        find.descendant(of: line, matching: find.text('1 agent · 0 working')),
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
          find.descendant(
            of: line,
            matching: find.text('2 agents · 0 working'),
          ),
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
        find.descendant(of: line, matching: find.text('20 agents · 0 working')),
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
      'tapping the line lists every agent, Working, Waiting, Idle, then Kept (closed), with name, role and status',
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
          // Closed on its machine and kept by someone: not Idle (Huy, 2026-11-02).
          agent('kept', 'Kai')
            ..['workDecision'] = 'keep'
            ..['downSince'] = DateTime.now().toUtc().toIso8601String()
            ..['configuration'] = {
              'engine': 'claude',
              'model': 'opus',
              'effort': 'high',
            },
        ];
        (server.state['agents'] as List)[2]['role'] = 'reviewer';
        (server.state['conversations'] as List)[0]
          ..['leadId'] = 'pm'
          ..['agentIds'] = ['pm', 'dev', 'rev', 'idle', 'kept']
          ..['assignment'] = {'agentId': 'rev', 'status': 'needs_human'};
        f.app.machineStates['m']!
          ..agents = [
            for (final id in ['pm', 'dev', 'rev', 'idle', 'kept'])
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
          find.descendant(
            of: line,
            matching: find.text('5 agents · 2 working'),
          ),
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
          for (final group in ['Working', 'Waiting', 'Idle', 'Kept (closed)'])
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
          headings[3],
          row('kept'),
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
        // Hovering the kept, closed agent reads as its line does, the mockup Huy approved: status, machine, model, effort.
        Finder tip(String id) => find.ancestor(
          of: row(id),
          matching: find.byWidgetPredicate(
            (w) =>
                w is Tooltip &&
                (w.message ?? '').startsWith('Kept (closed) · ') &&
                (w.message ?? '').endsWith(' · Opus · high'),
          ),
        );
        expect(tip('kept'), findsOneWidget);
        expect(tip('idle'), findsNothing);

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
      // The role the project's document gives it; its badge cut to 12 characters.
      (server.state['agents'] as List)[1]['roleName'] = 'Research Engineer';
      await c.refresh();
      await show();
      await tester.pumpAndSettle();
      expect(
        find.descendant(of: dev, matching: find.text('Research En…')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: dev,
          matching: find.byWidgetPredicate(
            (w) => w is Semantics && w.properties.label == 'Research Engineer',
          ),
        ),
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
          'previewVersion': 2,
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
          '/api/super-tabs/tab/machines/studio/removal/v2',
        ]);
        expect(find.textContaining('Mira'), findsWidgets);
        expect(find.textContaining('River'), findsWidgets);
        expect(find.textContaining('Pilot'), findsWidgets);
        expect(find.textContaining('Beacon'), findsWidgets);
        expect(
          find.text(
            'The open task “Review the onboarding flow” loses its agent.',
          ),
          findsOneWidget,
        );
        expect(find.textContaining('Product Manager'), findsNothing);
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
        expect(find.textContaining('Cleaning up'), findsOneWidget);
        if (capture != null) {
          await captureWindow(tester, capture, 'machine-removal-cleaning');
        }
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      },
    );

    testWidgets(
      'a Swarm-wide Buddy has no project: its name is listed alone and Remove still asks',
      (tester) async {
        final server = _RemovalServer();
        server.state['machines'] = [machine('owner')];
        server.preview = {
          'previewVersion': 2,
          'blockedBy': null,
          'agents': [
            {'id': 'a1', 'name': 'Wren', 'projectName': ''},
          ],
          'soleSourceProjects': <Object>[],
        };
        final c = server.controller();
        await c.refresh();
        await mount(tester, c);
        await tester.tap(
          find.byKey(const ValueKey('super-machine-studio')),
          buttons: kSecondaryMouseButton,
        );
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('super-machine-menu-remove')),
        );
        await tester.pumpAndSettle();
        expect(find.text('Remove Studio from this Swarm?'), findsOneWidget);
        expect(find.text('Wren'), findsOneWidget);
        expect(find.textContaining('Wren ·'), findsNothing);
        expect(find.text('Could not check this machine.'), findsNothing);
        await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
        await tester.pumpAndSettle();
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

    testWidgets(
      'a long press opens the same menu, Details and Remove, not the details',
      (tester) async {
        final server = _RemovalServer();
        server.state['machines'] = [machine('owner')];
        final c = server.controller();
        await c.refresh();
        await mount(tester, c);
        await tester.longPress(
          find.byKey(const ValueKey('super-machine-studio')),
        );
        await tester.pumpAndSettle();
        expect(find.text('Details'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('super-machine-menu-remove')),
          findsOneWidget,
        );
        expect(find.byType(SuperTabMachineDetails), findsNothing);
        await tester.tap(find.text('Details'));
        await tester.pumpAndSettle();
        expect(find.byType(SuperTabMachineDetails), findsOneWidget);
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      },
    );

    testWidgets(
      'in a browser, pointing at a machine row switches the browser menu off',
      (tester) async {
        final told = <bool>[];
        BrowserMenuGuard.debugWeb = true;
        BrowserMenuGuard.debugSink = (off) async => told.add(off);
        addTearDown(BrowserMenuGuard.debugReset);
        final server = _RemovalServer();
        server.state['machines'] = [machine('owner')];
        final c = server.controller();
        await c.refresh();
        await mount(tester, c);
        final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
        await mouse.addPointer(location: const Offset(900, 700));
        await tester.pump();
        expect(told, isEmpty);
        await mouse.moveTo(
          tester.getCenter(find.byKey(const ValueKey('super-machine-studio'))),
        );
        await tester.pump();
        expect(told, [true]);
        await mouse.moveTo(const Offset(900, 700));
        await tester.pump();
        expect(told, [true, false]);
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      },
    );

    testWidgets(
      'the browser menu stays off while the Swarm menu is open, and comes back when it closes',
      (tester) async {
        final told = <bool>[];
        BrowserMenuGuard.debugWeb = true;
        BrowserMenuGuard.debugSink = (off) async => told.add(off);
        addTearDown(BrowserMenuGuard.debugReset);
        final server = _RemovalServer();
        server.state['machines'] = [machine('owner')];
        final c = server.controller();
        await c.refresh();
        await mount(tester, c);
        final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
        addTearDown(mouse.removePointer);
        await mouse.addPointer(location: const Offset(900, 700));
        final row = find.byKey(const ValueKey('super-machine-studio'));
        await mouse.moveTo(tester.getCenter(row));
        await tester.pump();
        await tester.tap(row, buttons: kSecondaryMouseButton);
        await tester.pumpAndSettle();
        expect(find.text('Details'), findsOneWidget);
        // The menu's barrier took the pointer from the row: a second right-click
        // lands on the barrier and must not bring up the browser's menu.
        await mouse.moveTo(const Offset(900, 700));
        await tester.pump();
        expect(told, [true], reason: 'still off with the menu open');
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(told, [
          true,
          false,
        ], reason: 'a terminal has its Copy and Paste again');
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      },
    );

    testWidgets(
      'an expanded machine: a right-click on its readings opens the same menu, with the browser menu off',
      (tester) async {
        final told = <bool>[];
        BrowserMenuGuard.debugWeb = true;
        BrowserMenuGuard.debugSink = (off) async => told.add(off);
        addTearDown(BrowserMenuGuard.debugReset);
        final server = _RemovalServer();
        server.state['machines'] = [machine('owner')];
        final c = server.controller();
        await c.refresh();
        await mount(tester, c);
        await tester.tap(find.byKey(const ValueKey('super-machine-studio')));
        await tester.pumpAndSettle();
        final below = find.text('No agents yet');
        expect(below, findsOneWidget);
        final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
        addTearDown(mouse.removePointer);
        await mouse.addPointer(location: const Offset(900, 700));
        await mouse.moveTo(tester.getCenter(below));
        await tester.pump();
        expect(told.last, isTrue);
        await tester.tap(below, buttons: kSecondaryMouseButton);
        await tester.pumpAndSettle();
        expect(find.text('Details'), findsOneWidget);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      },
    );

    testWidgets(
      'losing the screen with the Swarm menu open gives the browser menu back',
      (tester) async {
        final told = <bool>[];
        BrowserMenuGuard.debugWeb = true;
        BrowserMenuGuard.debugSink = (off) async => told.add(off);
        addTearDown(BrowserMenuGuard.debugReset);
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
        expect(BrowserMenuGuard.isOff, isTrue);
        // Sign-out or access lost: the workspace goes, Navigator and all.
        await tester.pumpWidget(const SizedBox());
        expect(BrowserMenuGuard.isOff, isFalse);
        expect(told.last, isFalse);
        await c.flush();
        c.dispose();
      },
    );

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
        'previewVersion': 2,
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

    testWidgets('removal preview counts projects the viewer cannot see', (
      tester,
    ) async {
      final server = _RemovalServer();
      server.state['machines'] = [machine('owner')];
      server.preview = {
        'previewVersion': 2,
        'blockedBy': {
          'reason': "A Product Manager of a project you can't see runs on this machine.",
        },
        'agents': <dynamic>[],
        'hiddenAgentCount': 2,
        'soleSourceProjects': <dynamic>[],
        'hiddenSoleSourceProjectCount': 1,
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
        find.text(
          "A Product Manager of a project you can't see runs on this machine.",
        ),
        findsOneWidget,
      );
      expect(
        find.textContaining("2 agents of projects you can't see"),
        findsOneWidget,
      );
      expect(
        find.textContaining(
          "1 project you can't see has code only on this machine",
        ),
        findsOneWidget,
      );
      expect(find.textContaining('Secret Project'), findsNothing);
      expect(
        tester
            .widget<FilledButton>(
              find.byKey(const ValueKey('super-machine-remove-confirm')),
            )
            .onPressed,
        isNull,
      );
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    });

    testWidgets('fails closed when the backend lacks the versioned preview', (
      tester,
    ) async {
      final server = _RemovalServer()
        ..state['machines'] = [machine('owner')]
        ..preview = {
          'blockedBy': null,
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
      expect(find.textContaining('Cleaning up'), findsOneWidget);
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
  // Task #2195: a Swarm that isn't showing reads no machine's usage.
  testWidgets(
    'reads nothing while its Swarm is away, and reads at once on its return',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner', 'maxAgents': 8},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      var reads = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 800,
              height: 400,
              child: SuperTabMachines(
                controller: c,
                app: f.app,
                onAddAgent: (_) {},
                readLocal: (_) async {
                  reads++;
                  return null;
                },
              ),
            ),
          ),
        ),
      );
      await tester.pump(const Duration(seconds: 1));
      expect(reads, greaterThan(0));
      c.away = true;
      await tester.pump(const Duration(seconds: 16));
      final atAway = reads;
      await tester.pump(const Duration(seconds: 40));
      expect(reads, atAway);
      c.away = false;
      await tester.pump(const Duration(seconds: 1));
      expect(reads, greaterThan(atAway));
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

}

/// A hardware reading's value in a machine's expanded readings.
String? _hw(WidgetTester tester, String id, String name) => tester
    .widget<Text>(find.byKey(ValueKey('super-machine-hw-$id-$name')))
    .data;
