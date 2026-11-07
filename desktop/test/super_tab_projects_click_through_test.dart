import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

/// Set to a folder to write the PR's screenshots there: the page at 1440 and 880, light and dark.
final shots = Platform.environment['SUPER_TAB_PROJECTS_SHOTS'];

Map<String, dynamic> _agent(String id, String projectId, String kind) => {
  'id': id,
  'projectId': projectId,
  'name': id,
  'displayName': id[0].toUpperCase() + id.substring(1),
  'machineId': 'host',
  'harnessId': 'session-$id',
  'contributorId': 'owner',
  'configuration': {'engine': 'claude'},
  'kind': kind,
};

Map<String, dynamic> _pulse(int working, int toDo) => {
  'pmId': null,
  'asks': {'count': 0, 'oldestAt': null, 'personId': null, 'list': []},
  'working': {'count': working, 'crew': 0, 'agentIds': <String>[]},
  'nextUp': {'count': toDo, 'conversationIds': <String>[]},
  'lost': {'count': 0, 'since': null, 'conversationIds': <String>[]},
  'held': {'count': 0, 'withoutReason': 0, 'list': []},
  'idleSince': null,
  'process': null,
  'redAt': {'asks': null, 'idle': null, 'lost': null, 'held': null},
  'limits': {'askMinutes': 5, 'idleMinutes': 10, 'lostMinutes': 10},
};

/// The mockup's Swarm (anh Dee's Buddy, 11-07): harness, lamp, computer, harness-gtm, pod, scout and lamp-gtm, each with
/// its purpose, Lead, members, open work, repository and four weeks of shipping.
void _projects(ConversationServer server) {
  final now = DateTime.now();
  final groups = (server.state['conversations'] as List)
      .cast<Map<String, dynamic>>();
  final rows =
      <
        ({
          String id,
          String name,
          String? about,
          String? repo,
          String lead,
          List<String> members,
          int working,
          int toDo,
          Duration ago,
          bool private,
        })
      >[
        (
          id: 'lead',
          name: 'harness',
          about:
              'The harness for coding agents and beyond. All your agents, all '
              'your machines, one command center.',
          repo: 'openharness',
          lead: 'river',
          members: ['kai', 'sage', 'vetch', 'jules'],
          working: 12,
          toDo: 3,
          ago: const Duration(minutes: 2),
          private: false,
        ),
        (
          id: 'lamp',
          name: 'lamp',
          about: 'The open-source operating system for physical AI.',
          repo: 'lampOS',
          lead: 'faye',
          members: ['rose', 'sky', 'lilac'],
          working: 4,
          toDo: 2,
          ago: const Duration(minutes: 12),
          private: false,
        ),
        (
          id: 'computer',
          name: 'computer',
          about:
              'Open-source AI computer builds, from 2-GPU desktops to 8-GPU '
              'servers: CAD, BOM, BIOS and build guides.',
          repo: 'Personal-AI-Computer',
          lead: 'sage2',
          members: ['pink'],
          working: 1,
          toDo: 0,
          ago: const Duration(hours: 1),
          private: false,
        ),
        (
          id: 'gtm',
          name: 'harness-gtm',
          about: null,
          repo: 'harness-gtm',
          lead: 'jules2',
          members: ['teal'],
          working: 1,
          toDo: 1,
          ago: const Duration(hours: 2),
          private: false,
        ),
        (
          id: 'pod',
          name: 'pod',
          about: null,
          repo: 'spaceship',
          lead: 'quinn',
          members: ['blush'],
          working: 1,
          toDo: 0,
          ago: const Duration(hours: 3),
          private: false,
        ),
        (
          id: 'scout',
          name: 'scout',
          about: null,
          repo: null,
          lead: 'lark',
          members: [],
          working: 0,
          toDo: 0,
          ago: const Duration(hours: 5),
          private: true,
        ),
        (
          id: 'lampgtm',
          name: 'lamp-gtm',
          about: null,
          repo: null,
          lead: 'nico',
          members: [],
          working: 0,
          toDo: 0,
          ago: const Duration(hours: 30),
          private: false,
        ),
      ];
  final projects = <Map<String, dynamic>>[];
  final agents = <Map<String, dynamic>>[];
  final pulse = <String, dynamic>{};
  final activity = <Map<String, dynamic>>[];
  for (final (i, row) in rows.indexed) {
    final chat = row.id == 'lead' ? 'lead' : '${row.id}-chat';
    projects.add({
      ...projectFixture(
        row.id,
        row.name,
        chat,
        visibility: row.private ? 'private' : 'public',
      ),
      'about': ?row.about,
      if (row.repo case final repo?)
        'repository': {
          'repositoryUrl': 'https://github.com/autonomous-ai/$repo',
        },
    });
    if (row.id == 'lead') {
      groups.firstWhere((g) => g['id'] == 'lead')['leadId'] = row.lead;
    } else {
      groups.add({
        ...conversationFixture(chat, row.name),
        'projectId': row.id,
        'leadId': row.lead,
      });
    }
    agents
      ..add(_agent(row.lead, row.id, 'pm'))
      ..addAll([for (final m in row.members) _agent(m, row.id, 'regular')]);
    pulse[row.id] = _pulse(row.working, row.toDo);
    activity.add({
      'projectId': row.id,
      'shipped': [for (var d = 0; d < 28; d++) (d * (i + 3) + i * 5) % 7],
      'updatedAt': now.subtract(row.ago).millisecondsSinceEpoch,
    });
  }
  // The reader's own Buddy, whose chat the view opens on.
  server.state['swarmBuddy'] = true;
  agents.add({
    ..._agent('buddy', 'lead', 'buddy'),
    'buddyScope': 'swarm',
    'buddyOf': {'personId': 'owner'},
    'chatId': 'swarm-buddy-owner',
    'myAgent': true,
  });
  groups.add({
    ...conversationFixture('swarm-buddy-owner', 'Buddy'),
    'kind': 'swarm-buddy',
    'buddyOwnerId': 'owner',
    'agentIds': ['buddy'],
  });
  server.state['projects'] = projects;
  server.state['agents'] = agents;
  server.state['pulse'] = pulse;
  server.projectActivity = {'through': '2026-11-07', 'projects': activity};
}

Future<SuperTabController> _open(
  WidgetTester tester,
  Brightness brightness,
  double width,
) async {
  await tester.binding.setSurfaceSize(Size(width, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final before = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = before);
  final server = swarm();
  _projects(server);
  final c = server.controller(
    account: 'owner',
    initial: {
      'tabId': 'tab',
      'accountId': 'owner',
      'selectedId': 'swarm-buddy-owner',
    },
  );
  await tester.runAsync(c.refresh);
  final AppNotifier app = createApp();
  addTearDown(app.dispose);
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: SuperTabView(
          controller: c,
          app: app,
          onNewSwarm: () {},
          onInvite: () {},
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          onNewProject: () {},
          machineName: (_) => 'Mac Studio',
          board: true,
          rightPane: (_) => const SizedBox.expand(),
        ),
      ),
    ),
  );
  await _settle(tester);
  return c;
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Finder _key(String k) => find.byKey(ValueKey(k));

List<String> _rows(WidgetTester tester) {
  final found = [
    for (final e
        in find
            .byWidgetPredicate(
              (w) =>
                  w.key is ValueKey<String> &&
                  (w.key! as ValueKey<String>).value.startsWith('super-group-'),
            )
            .evaluate())
      (
        (e.widget.key! as ValueKey<String>).value,
        tester.getTopLeft(find.byWidget(e.widget)).dy,
      ),
  ]..sort((a, b) => a.$2.compareTo(b.$2));
  return [for (final (k, _) in found) k];
}

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('a person opens Projects, finds one, sorts, and opens it '
        '(${brightness.name})', (tester) async {
      final c = await _open(tester, brightness, 1440);
      try {
        await tester.tap(_key('super-projects'));
        await _settle(tester);
        expect(find.text('Projects'), findsWidgets);
        expect(_rows(tester).first, 'super-group-lead');
        expect(_rows(tester), hasLength(7));
        await captureWindow(tester, shots, 'projects-1440-${brightness.name}');

        await tester.enterText(find.byType(TextField), 'lamp');
        await tester.pump();
        expect(_rows(tester), [
          'super-group-lamp-chat',
          'super-group-lampgtm-chat',
        ]);
        await tester.enterText(find.byType(TextField), '');
        await tester.pump();

        await tester.tap(_key('super-projects-sort'));
        await tester.pumpAndSettle();
        await tester.tap(_key('super-projects-sort-name'));
        await tester.pumpAndSettle();
        expect(_rows(tester).first, 'super-group-computer-chat');

        await tester.tap(_key('super-group-lamp-chat'));
        await _settle(tester);
        expect(_key('super-board-tab-board'), findsOneWidget);
        expect(c.snapshot?.projectById('lamp'), isNotNull);
      } finally {
        await tester.pumpWidget(const SizedBox());
        await tester.runAsync(c.flush);
        c.dispose();
        await tester.pump(const Duration(seconds: 5));
      }
    });

    testWidgets('the page at 880 (${brightness.name})', (tester) async {
      final c = await _open(tester, brightness, 880);
      try {
        await tester.tap(_key('super-projects'));
        await _settle(tester);
        expect(tester.takeException(), isNull);
        expect(_rows(tester), hasLength(7));
        await captureWindow(tester, shots, 'projects-880-${brightness.name}');
      } finally {
        await tester.pumpWidget(const SizedBox());
        await tester.runAsync(c.flush);
        c.dispose();
        await tester.pump(const Duration(seconds: 5));
      }
    });
  }
}
