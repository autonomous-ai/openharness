// Tabs to Personal Swarm, Phase 1 (task #3099; plan
// docs/plans/2026-11-04-tabs-to-personal-swarm-migration.md): a project that
// starts an agent gets its own desk tab, the one link from tab to project on
// every computer.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/personal_projects.dart';
import 'package:harness/super_tabs/swarm_switcher.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

/// The desk's id rule (backend `lib/desk.ts`).
final _deskId = RegExp(r'^[A-Za-z0-9_-]{1,64}$');

Agent _agent(String id, {String? remote, String cwd = '/work/x'}) => Agent(
  id: id,
  name: 'Agent $id',
  engine: 'codex',
  terminalAvailable: true,
  project: AgentProject(
    name: cwd.split('/').last,
    cwd: cwd,
    root: remote == null ? null : cwd,
    remote: remote,
  ),
);

var _paneIds = 7000;
TerminalPane _pane(String machineId, String agentId) =>
    TerminalPane(id: _paneIds++, machineId: machineId, agentId: agentId);

Swarm _tab(
  AppNotifier app,
  String id,
  List<TerminalPane> panes, {
  String? name,
  bool? nameIsCustom,
}) {
  final tab = Swarm(id: id, name: name ?? id, nameIsCustom: nameIsCustom)
    ..panes.addAll(panes);
  app.swarms.add(tab);
  return tab;
}

List<Map<String, dynamic>> _commands(
  SuperTabLaunchFixture f, [
  String type = 'project.create',
]) => [
  for (final post in f.connection.server.posts)
    if ((post['command'] as Map?)?['type'] == type)
      Map<String, dynamic>.from(post),
];

/// The fixture's Swarm as the person's Personal one, theirs alone.
Future<SuperTabController> _personal(SuperTabLaunchFixture f) async {
  for (final state in f.app.machineStates.values) {
    state.localOnly = true;
  }
  f.connection.server.state
    ..['name'] = 'Personal'
    ..['ownerId'] = 'owner'
    ..['people'] = [
      {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
    ];
  await f.app.superTabs.storage.write('super_tab.personal.owner', tabId);
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Personal');
  PersonalSwarm.of(f.app).id;
  for (var i = 0; i < 20; i++) {
    await Future<void>.microtask(() {});
  }
  expect(PersonalSwarm.of(f.app).id, tabId);
  final c = await f.app.superTabs.open(tabId);
  await c.refresh();
  return c;
}

/// Personal with one project of the person's, `api`, made on the server
/// before (its id is the server's).
Future<({SuperTabController c, String project, String chat})> _withApi(
  SuperTabLaunchFixture f, {
  Map<String, dynamic>? copyOf,
}) async {
  if (copyOf != null) {
    f.connection.server.state
      ..['projects'] = jsonDecode(jsonEncode(copyOf['projects']))
      ..['conversations'] = jsonDecode(jsonEncode(copyOf['conversations']));
  }
  final c = await _personal(f);
  if (copyOf == null) {
    await c.request(
      'POST',
      '/api/super-tabs/$tabId/commands',
      body: {
        'operationId': 'make-api',
        'command': {
          'type': 'project.create',
          'name': 'api',
          'visibility': 'private',
          'brief': '',
        },
      },
    );
    await c.refresh();
  }
  final api = c.snapshot!.projects.firstWhere((p) => p.name == 'api');
  return (c: c, project: api.id, chat: api.leadConversationId);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('a project tab id', () {
    test('is made from the project id alone and fits the desk', () {
      final id = personalProjectTabId('project-7');
      expect(id, startsWith('project-'));
      expect(id, matches(_deskId));
      expect(personalProjectTabId('project-7'), id);
      expect(personalProjectTabId('project-8'), isNot(id));
      expect(personalProjectTabId('project-7', 2), '$id-2');
      expect(personalProjectTabId('project-7', 3), matches(_deskId));
      expect(personalProjectTabParts(id), (base: id, number: 1));
      expect(personalProjectTabParts('$id-3'), (base: id, number: 3));
      expect(personalProjectTabParts('desk-code'), isNull);
      expect(personalProjectTabParts('project-abc'), isNull);
      expect(personalProjectTabParts('$id-1'), isNull);
    });

    test('links a no-repo pane in it to its project on every computer, and no '
        'computer makes a project for that tab', () async {
      final one = SuperTabLaunchFixture();
      final first = await _withApi(one);
      final two = SuperTabLaunchFixture();
      final second = await _withApi(two, copyOf: one.connection.server.state);
      expect(second.project, first.project);
      final tabOnBoth = personalProjectTabId(first.project);
      final made = <int>[];
      for (final (f, c, chat) in [
        (one, first.c, first.chat),
        (two, second.c, second.chat),
      ]) {
        f.app.machineStates['m']!.agents = [
          _agent('notes', cwd: '/Users/me/notes'),
        ];
        final pane = _pane('m', 'notes');
        _tab(f.app, tabOnBoth, [pane], name: 'api');
        final before = _commands(f).length;
        await PersonalProjects.of(f.app).sync(c);
        made.add(_commands(f).length - before);
        expect(
          PersonalProjects.of(f.app).projectOfTab(c, tabOnBoth)?.id,
          first.project,
        );
        expect(PersonalProjects.of(f.app).panesFor(c, chat), [pane]);
        expect(
          PersonalProjects.of(f.app).knownForTest('owner', tabId).keys,
          isNot(contains(personalTabKey(tabOnBoth))),
        );
      }
      expect(made, [0, 0]);
    });

    test('of a project Personal does not list makes no project, and an '
        'ordinary tab keeps its own project', () async {
      final f = SuperTabLaunchFixture();
      final api = await _withApi(f);
      f.app.machineStates['m']!.agents = [
        _agent('a', cwd: '/Users/me/a'),
        _agent('b', cwd: '/Users/me/b'),
      ];
      final stray = personalProjectTabId('gone');
      _tab(f.app, stray, [_pane('m', 'a')], name: 'old');
      _tab(f.app, 'desk-code', [_pane('m', 'b')], name: 'code');
      final before = _commands(f).length;
      await PersonalProjects.of(f.app).sync(api.c);
      final created = _commands(f).skip(before).toList();
      expect(created, hasLength(1));
      expect(
        PersonalProjects.of(f.app).knownForTest('owner', tabId).keys,
        allOf(
          contains(personalTabKey('desk-code')),
          isNot(contains(personalTabKey(stray))),
        ),
      );
      expect(PersonalProjects.of(f.app).projectOfTab(api.c, stray), isNull);
    });
  });
}
