import 'dart:async';
import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/personal_projects.dart';
import 'package:harness/super_tabs/swarm_switcher.dart';
import 'package:harness/super_tabs/workspace.dart';
import 'package:harness/widgets/pane_grid.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/capture.dart';

/// Set to a folder to write the PR's pictures there.
final _shots = Platform.environment['PERSONAL_PROJECTS_SHOTS'];

/// A pane's agent, in a checkout of [remote] (none for a folder).
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

MachineState _machine(
  AppNotifier app,
  String id, {
  bool shared = false,
  String? sessionKind,
}) {
  final machine = Machine(
    machineId: id,
    authMode: MachineAuthMode.remote,
    name: 'Mac $id',
    isShared: shared,
    ownerName: shared ? 'Kim' : null,
    sessionKind: sessionKind,
  );
  app.machines = [...app.machines, machine];
  return app.machineStates[id] = MachineState(machine)
    ..nodeOnline = true
    ..agentLoadStatus = AgentLoadStatus.loaded;
}

var _paneIds = 9000;
TerminalPane _pane(String machineId, String agentId) =>
    TerminalPane(id: _paneIds++, machineId: machineId, agentId: agentId);

/// A desk tab of the person's, holding [panes] in this order.
Swarm _tab(AppNotifier app, String id, List<TerminalPane> panes) {
  final tab = Swarm(id: id, name: id)..panes.addAll(panes);
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

/// The fixture's Swarm, made the person's Personal one: theirs alone, and
/// picked here before.
Future<SuperTabController> _personal(
  SuperTabLaunchFixture f, {
  List<String> people = const ['owner'],
}) async {
  f.connection.server.state
    ..['name'] = 'Personal'
    ..['ownerId'] = 'owner'
    ..['people'] = [
      for (final person in people)
        {
          'id': person,
          'email': '$person@example.com',
          'role': person == 'owner' ? 'owner' : 'collaborator',
        },
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

/// Two repos and a folder across two of the person's Macs, in two tabs:
/// `one` holds the api on this Mac, then a folder; `two` holds the web app,
/// then the api again on the laptop under another URL form.
({TerminalPane api, TerminalPane folder, TerminalPane web, TerminalPane api2})
_desk(SuperTabLaunchFixture f) {
  f.app.machineStates['m']!.agents = [
    _agent('n1', remote: 'git@github.com:Acme/api.git', cwd: '/w/api'),
    _agent('n2', cwd: '/Users/me/notes'),
    _agent('n3', remote: 'https://github.com/acme/web', cwd: '/w/web'),
  ];
  _machine(f.app, 'laptop').agents = [
    _agent('n1', remote: 'https://github.com/acme/api', cwd: '/x/api-copy'),
  ];
  final panes = (
    api: _pane('m', 'n1'),
    folder: _pane('m', 'n2'),
    web: _pane('m', 'n3'),
    api2: _pane('laptop', 'n1'),
  );
  _tab(f.app, 'one', [panes.api, panes.folder]);
  _tab(f.app, 'two', [panes.web, panes.api2]);
  return panes;
}

void main() {
  setUpAll(() => loadCaptureFonts(_shots));

  for (final brightness in Brightness.values) {
    testWidgets('pictures of Personal\'s projects, chat and [term], in '
        '${brightness.name}', (tester) async {
      if (_shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(2560, 1440);
      addTearDown(tester.view.reset);
      final f = SuperTabLaunchFixture();
      _desk(f);
      final c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      final api = c.snapshot!.projects
          .firstWhere((p) => p.name == 'api')
          .leadConversationId;
      c.select(api);
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: ListenableBuilder(
              listenable: f.app,
              builder: (_, _) => SuperTabWorkspace(
                app: f.app,
                canvas: PaneGrid(notifier: f.app, swarmMode: true),
                onAddAgent: (_) {},
                onNewProject: () {},
                onNewSwarm: () {},
              ),
            ),
          ),
        ),
      );
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 20));
      }
      await captureWindow(tester, _shots, 'personal-chat-${brightness.name}');
      await tester.tap(find.byTooltip('Group terminals (2)'));
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 20));
      }
      await captureWindow(tester, _shots, 'personal-term-${brightness.name}');
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
  }

  group('a repo is one string on every computer', () {
    test('ssh, https, case, user, port and .git are the same repo', () {
      const forms = [
        'git@github.com:Acme/Api.git',
        'https://github.com/acme/api',
        'https://github.com/acme/api.git/',
        'ssh://git@github.com:22/acme/api.git',
        'https://user:secret@GitHub.com/acme/api',
      ];
      for (final form in forms) {
        expect(normalizedRemote(form), 'github.com/acme/api', reason: form);
      }
    });

    test('a folder or nothing is no repo', () {
      for (final form in [
        null,
        '',
        '/srv/git/api.git',
        './api',
        'file:///srv/git/api.git',
        r'C:\repos\api',
      ]) {
        expect(normalizedRemote(form), isNull, reason: form);
      }
    });

    test('the request id never carries the URL', () {
      final id = personalProjectOperation('github.com/acme/api');
      expect(id, startsWith('personal-repo-'));
      expect(id, isNot(contains('acme')));
      expect(id, personalProjectOperation('github.com/acme/api'));
      expect(id, isNot(personalProjectOperation('github.com/other/api')));
      expect(personalProjectOperation(kScratchRepo), 'personal-scratch');
    });

    test('two repos of one name have long names that tell them apart', () {
      expect(repoName('github.com/acme/api'), 'api');
      expect(repoLongName('github.com/acme/api'), 'api (acme/api)');
      expect(repoLongName('gitlab.com/team/sub/api'), 'api (sub/api)');
    });
  });

  group('the person\'s panes, by repo', () {
    test('every pane joins its repo whatever tab it is in, in tab order', () {
      final f = SuperTabLaunchFixture();
      final p = _desk(f);
      final panes = personalPanes(f.app);
      expect([for (final e in panes) e.pane], [p.api, p.folder, p.web, p.api2]);
      expect(
        [for (final e in panes) e.repo],
        [
          'github.com/acme/api',
          kScratchRepo,
          'github.com/acme/web',
          'github.com/acme/api',
        ],
      );
    });

    test('a pane twice in the tabs counts once, where it is first', () {
      final f = SuperTabLaunchFixture();
      final p = _desk(f);
      f.app.swarms.firstWhere((s) => s.id == 'two').panes.add(p.api);
      expect(
        personalPanes(f.app)
            .where((e) => identical(e.pane, p.api))
            .single
            .tab
            .id,
        'one',
      );
    });

    test(
      'panes on another person\'s, a shared or a Team machine are left out',
      () {
        final f = SuperTabLaunchFixture();
        _machine(f.app, 'kims', shared: true).agents = [
          _agent('k1', remote: 'git@github.com:kim/secret.git'),
        ];
        _machine(f.app, 'team', sessionKind: 'team').agents = [
          _agent('t1', remote: 'git@github.com:acme/team.git'),
        ];
        f.app.machineStates['m']!.agents = [_agent('n1')];
        _tab(f.app, 'mixed', [
          _pane('kims', 'k1'),
          _pane('team', 't1'),
          _pane('m', 'n1'),
        ]);
        expect([for (final e in personalPanes(f.app)) e.pane.agentId], ['n1']);
      },
    );

    test('a Swarm tab\'s panes are not the person\'s tabs', () {
      final f = SuperTabLaunchFixture();
      f.app.machineStates['m']!.agents = [_agent('n1')];
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.app.activeSwarm.panes.add(_pane('m', 'n1'));
      expect(personalPanes(f.app), isEmpty);
    });
  });

  group('Personal\'s projects', () {
    test(
      'each repo, and # scratch, is made once as a private project',
      () async {
        final f = SuperTabLaunchFixture();
        _desk(f);
        final c = await _personal(f);
        await PersonalProjects.of(f.app).sync(c);
        final creates = _commands(f);
        expect(
          [for (final p in creates) p['operationId']],
          [
            personalProjectOperation('github.com/acme/api'),
            'personal-scratch',
            personalProjectOperation('github.com/acme/web'),
          ],
        );
        expect(
          [for (final p in creates) p['command']['name']],
          ['api', 'scratch', 'web'],
        );
        expect(
          creates.every((p) => p['command']['visibility'] == 'private'),
          isTrue,
        );
        final names = [for (final p in c.snapshot!.projects) p.name];
        expect(names, containsAll(['api', 'scratch', 'web']));

        // Again: nothing.
        await PersonalProjects.of(f.app).sync(c);
        expect(_commands(f), hasLength(3));

        // The app restarted on the same computer: what it kept, no request.
        final restarted = SuperTabLaunchFixture();
        restarted.store.values.addAll(f.store.values);
        restarted.connection.server.state
          ..clear()
          ..addAll(f.connection.server.state);
        _desk(restarted);
        final rc = await _personal(restarted);
        await PersonalProjects.of(restarted.app).sync(rc);
        expect(_commands(restarted), isEmpty);
        expect(
          PersonalProjects.of(restarted.app).knownForTest('owner', tabId),
          PersonalProjects.of(f.app).knownForTest('owner', tabId),
        );
      },
    );

    test('nothing is sent of a pane but its project\'s name', () async {
      final f = SuperTabLaunchFixture();
      _desk(f);
      final c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      final sent = f.connection.server.posts.toString();
      for (final leak in [
        'acme',
        '/w/',
        '/Users/me',
        'notes',
        'n1',
        'laptop',
      ]) {
        expect(sent, isNot(contains(leak)), reason: leak);
      }
    });

    test('another computer of the person\'s finds the same projects', () async {
      final f = SuperTabLaunchFixture();
      _desk(f);
      final c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      final first = PersonalProjects.of(f.app).knownForTest('owner', tabId);

      // The laptop: its own app and store, the same Swarm and account.
      final laptop = SuperTabLaunchFixture();
      laptop.connection.server.state
        ..clear()
        ..addAll(f.connection.server.state);
      laptop.connection.server.receipts.addAll(f.connection.server.receipts);
      _desk(laptop);
      final lc = await _personal(laptop);
      final before = _projectCount(laptop);
      await PersonalProjects.of(laptop.app).sync(lc);
      expect(_projectCount(laptop), before);
      expect(
        PersonalProjects.of(laptop.app).knownForTest('owner', tabId),
        first,
      );
    });

    test('a project the person deleted is not made again', () async {
      final f = SuperTabLaunchFixture();
      f.app.machineStates['m']!.agents = [
        _agent('n1', remote: 'git@github.com:acme/api.git'),
      ];
      _tab(f.app, 'one', [_pane('m', 'n1')]);
      final c = await _personal(f);
      f.connection.server
        ..refuse = {
          'code': 'NOT_FOUND',
          'message': 'This project was deleted. Create a new project.',
        }
        ..refuseStatus = 404;
      await PersonalProjects.of(f.app).sync(c);
      expect(PersonalProjects.of(f.app).knownForTest('owner', tabId), {
        'github.com/acme/api': null,
      });
      f.connection.server.refuse = null;
      await PersonalProjects.of(f.app).sync(c);
      // The refused create, then none.
      expect(_commands(f), hasLength(1));
    });

    test('a failed create is asked again later, then works', () async {
      final f = SuperTabLaunchFixture();
      f.app.machineStates['m']!.agents = [
        _agent('n1', remote: 'git@github.com:acme/api.git'),
      ];
      _tab(f.app, 'one', [_pane('m', 'n1')]);
      final c = await _personal(f);
      var now = DateTime(2026, 10, 31, 9);
      Future<void> sync() =>
          withClock(Clock(() => now), () => PersonalProjects.of(f.app).sync(c));
      f.connection.server
        ..refuse = {'code': 'SERVICE_UNAVAILABLE', 'message': 'Busy.'}
        ..refuseStatus = 503;
      await sync();
      await sync();
      expect(_commands(f), hasLength(1), reason: 'waits before asking again');
      f.connection.server.refuse = null;
      now = now.add(const Duration(seconds: 11));
      await sync();
      expect(_commands(f), hasLength(2));
      expect(
        PersonalProjects.of(f.app).knownForTest('owner', tabId).values.single,
        isNotNull,
      );
    });

    test(
      'never in a team Swarm, nor a Personal one someone else is in',
      () async {
        final team = SuperTabLaunchFixture();
        _desk(team);
        team.app.bindSuperTab(team.app.activeSwarmId, tabId, 'Pilot');
        final tc = await team.app.superTabs.open(tabId);
        await tc.refresh();
        await PersonalProjects.of(team.app).sync(tc);
        expect(_commands(team), isEmpty);

        final shared = SuperTabLaunchFixture();
        _desk(shared);
        final sc = await _personal(shared, people: ['owner', 'kim']);
        await PersonalProjects.of(shared.app).sync(sc);
        expect(_commands(shared), isEmpty);
        expect(PersonalProjects.of(shared.app).panesFor(sc, 'lead'), isEmpty);
      },
    );

    test('an answer after the account changed is dropped', () async {
      final f = SuperTabLaunchFixture();
      _desk(f);
      final c = await _personal(f);
      final hold = f.connection.server.holdCommands = Completer<void>();
      final syncing = PersonalProjects.of(f.app).sync(c);
      await Future<void>.delayed(Duration.zero);
      f.app.currentUser = const CurrentUserProfile(
        id: 'other',
        email: 'other@example.com',
      );
      hold.complete();
      await syncing;
      expect(_commands(f), hasLength(1));
      expect(PersonalProjects.of(f.app).knownForTest('owner', tabId), isEmpty);
      expect(
        await f.app.superTabs.storage.read(
          PersonalProjects.storageKey('owner'),
        ),
        isNull,
      );
    });

    test('an answer after someone joined Personal is dropped', () async {
      final f = SuperTabLaunchFixture();
      _desk(f);
      final c = await _personal(f);
      final hold = f.connection.server.holdCommands = Completer<void>();
      final syncing = PersonalProjects.of(f.app).sync(c);
      await Future<void>.delayed(Duration.zero);
      (f.connection.server.state['people'] as List).add({
        'id': 'kim',
        'email': 'kim@example.com',
        'role': 'collaborator',
      });
      await c.refresh();
      hold.complete();
      await syncing;
      expect(_commands(f), hasLength(1));
      expect(PersonalProjects.of(f.app).knownForTest('owner', tabId), isEmpty);
      expect(
        await f.app.superTabs.storage.read(
          PersonalProjects.storageKey('owner'),
        ),
        isNull,
      );
    });

    test('losing access drops answers in flight and what was kept', () async {
      final f = SuperTabLaunchFixture();
      _desk(f);
      final c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      final lead = c.snapshot!.projects
          .firstWhere((p) => p.name == 'api')
          .leadConversationId;
      expect(PersonalProjects.of(f.app).panesFor(c, lead), hasLength(2));

      f.app.machineStates['m']!.agents = [
        ...f.app.machineStates['m']!.agents,
        _agent('n4', remote: 'git@github.com:acme/docs.git'),
      ];
      _tab(f.app, 'three', [_pane('m', 'n4')]);
      final hold = f.connection.server.holdCommands = Completer<void>();
      final syncing = PersonalProjects.of(f.app).sync(c);
      await Future<void>.delayed(Duration.zero);
      c.accessRevoked = true;
      hold.complete();
      await syncing;
      expect(PersonalProjects.of(f.app).panesFor(c, lead), isEmpty);
      expect(PersonalProjects.of(f.app).knownForTest('owner', tabId), isEmpty);
    });

    test('two repos of one name become two projects told apart', () async {
      final f = SuperTabLaunchFixture();
      f.app.machineStates['m']!.agents = [
        _agent('n1', remote: 'git@github.com:acme/api.git'),
        _agent('n2', remote: 'git@github.com:kim/api.git'),
        _agent('n3', remote: 'git@github.com:acme/web.git'),
      ];
      _tab(f.app, 'one', [
        _pane('m', 'n1'),
        _pane('m', 'n2'),
        _pane('m', 'n3'),
      ]);
      final c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      final names = [for (final p in c.snapshot!.projects) p.name];
      expect(names, containsAll(['api (acme/api)', 'api (kim/api)', 'web']));
      expect(names, isNot(contains('api')));
      // Each was created under the repo's own name, the same on every computer.
      expect(
        [for (final p in _commands(f)) p['command']['name']],
        ['api', 'api', 'web'],
      );
      // Once.
      await PersonalProjects.of(f.app).sync(c);
      expect(_commands(f, 'project.rename'), hasLength(2));
    });

    test('a name the person chose stays', () async {
      final f = SuperTabLaunchFixture();
      f.app.machineStates['m']!.agents = [
        _agent('n1', remote: 'git@github.com:acme/api.git'),
      ];
      _tab(f.app, 'one', [_pane('m', 'n1')]);
      final c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      final id = PersonalProjects.of(f.app)
          .knownForTest('owner', tabId)['github.com/acme/api']!;
      final project = (f.connection.server.state['projects'] as List)
          .cast<Map<String, dynamic>>()
          .firstWhere((p) => p['id'] == id);
      project['name'] = 'Backend';
      await c.refresh();
      f.app.machineStates['m']!.agents = [
        ...f.app.machineStates['m']!.agents,
        _agent('n2', remote: 'git@github.com:kim/api.git'),
      ];
      f.app.swarms.firstWhere((s) => s.id == 'one').panes.add(_pane('m', 'n2'));
      await PersonalProjects.of(f.app).sync(c);
      final renames = _commands(f, 'project.rename');
      expect(renames, hasLength(1));
      expect(renames.single['command']['name'], 'api (kim/api)');
      expect(project['name'], 'Backend');
    });

    test('a pane whose repo changes moves to that repo\'s project', () async {
      final f = SuperTabLaunchFixture();
      final p = _desk(f);
      final c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      String lead(String name) => c.snapshot!.projects
          .firstWhere((p) => p.name == name)
          .leadConversationId;
      final projects = PersonalProjects.of(f.app);
      expect(projects.panesFor(c, lead('scratch')), [p.folder]);

      // The folder becomes a checkout of the web app.
      f.app.machineStates['m']!.agents = [
        for (final a in f.app.machineStates['m']!.agents)
          a.id == 'n2'
              ? _agent('n2', remote: 'git@github.com:acme/web.git')
              : a,
      ];
      expect(projects.panesFor(c, lead('scratch')), isEmpty);
      expect(projects.panesFor(c, lead('web')), [p.folder, p.web]);
    });

    test('renaming or closing a tab keeps the projects', () async {
      final f = SuperTabLaunchFixture();
      final p = _desk(f);
      final c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      final api = c.snapshot!.projects
          .firstWhere((p) => p.name == 'api')
          .leadConversationId;
      f.app.swarms.firstWhere((s) => s.id == 'one')
        ..name = 'Renamed'
        ..nameIsCustom = true;
      expect(PersonalProjects.of(f.app).panesFor(c, api), [p.api, p.api2]);
      f.app.swarms.removeWhere((s) => s.id == 'one');
      expect(PersonalProjects.of(f.app).panesFor(c, api), [p.api2]);
      await PersonalProjects.of(f.app).sync(c);
      expect(_commands(f), hasLength(3));
    });
  });

  group('[term]', () {
    testWidgets(
      'shows the very panes the tabs hold, and the tabs stay as they are',
      (tester) async {
        await tester.binding.setSurfaceSize(const Size(1280, 800));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final f = SuperTabLaunchFixture();
        final p = _desk(f);
        p.api
          ..composerVisible = true
          ..watchOnly = false;
        late SuperTabController c;
        c = await _personal(f);
        await PersonalProjects.of(f.app).sync(c);
        final one = f.app.swarms.firstWhere((s) => s.id == 'one');
        final two = f.app.swarms.firstWhere((s) => s.id == 'two');
        final before = (
          one: [...one.panes],
          two: [...two.panes],
          closed: f.app.closedHistory.length,
        );
        final api = c.snapshot!.projects
            .firstWhere((p) => p.name == 'api')
            .leadConversationId;
        c.select(api);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: ListenableBuilder(
                listenable: f.app,
                builder: (_, _) => SuperTabWorkspace(
                  app: f.app,
                  canvas: const Text('Native terminals'),
                  onAddAgent: (_) {},
                ),
              ),
            ),
          ),
        );
        for (var i = 0; i < 10; i++) {
          await tester.pump(const Duration(milliseconds: 20));
        }
        expect(find.byTooltip('Group terminals (2)'), findsOneWidget);
        await tester.tap(find.byTooltip('Group terminals (2)'));
        for (var i = 0; i < 20; i++) {
          await tester.pump(const Duration(milliseconds: 20));
        }
        final swarm = f.app.swarms.firstWhere((s) => s.superTabId == tabId);
        expect(swarm.panes, hasLength(2));
        expect(identical(swarm.panes[0], p.api), isTrue);
        expect(identical(swarm.panes[1], p.api2), isTrue);
        expect(one.panes, before.one);
        expect(two.panes, before.two);
        expect(p.api.composerVisible, isTrue);
        expect(p.api.watchOnly, isFalse);
        expect(p.api.inputContext, isNull);
        // No Swarm terminal sharing was asked for.
        expect(
          f.connection.server.posts.where(
            (post) => post['conversationId'] != null && post['agentId'] != null,
          ),
          isEmpty,
        );

        // Back to the chat: the Swarm view lets them go, the tabs keep them.
        c.selectTerminal(api, null);
        for (var i = 0; i < 20; i++) {
          await tester.pump(const Duration(milliseconds: 20));
        }
        expect(swarm.panes, isEmpty);
        expect(one.panes, before.one);
        expect(two.panes, before.two);
        expect(f.app.allPanes, containsAll([p.api, p.api2]));
        expect(f.app.closedHistory, hasLength(before.closed));
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        f.app.superTabs.dispose();
        await tester.pump();
      },
    );

    testWidgets(
      'closing a tab while [term] shows its pane leaves one recently closed '
      'entry, the tab\'s',
      (tester) async {
        await tester.binding.setSurfaceSize(const Size(1280, 800));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final f = SuperTabLaunchFixture();
        final p = _desk(f);
        late SuperTabController c;
        c = await _personal(f);
        await PersonalProjects.of(f.app).sync(c);
        final before = f.app.closedHistory.length;
        final api = c.snapshot!.projects
            .firstWhere((p) => p.name == 'api')
            .leadConversationId;
        c
          ..select(api)
          ..selectGroupTerminals(api);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: ListenableBuilder(
                listenable: f.app,
                builder: (_, _) => SuperTabWorkspace(
                  app: f.app,
                  canvas: const Text('Native terminals'),
                  onAddAgent: (_) {},
                ),
              ),
            ),
          ),
        );
        for (var i = 0; i < 20; i++) {
          await tester.pump(const Duration(milliseconds: 20));
        }
        final swarm = f.app.swarms.firstWhere((s) => s.superTabId == tabId);
        expect(swarm.panes, [p.api, p.api2]);

        // Tab `one` holds the api pane [term] is showing.
        await f.app.closeSwarm('one');
        for (var i = 0; i < 20; i++) {
          await tester.pump(const Duration(milliseconds: 20));
        }
        expect(swarm.panes, [p.api2]);
        final added = f.app.closedHistory.take(
          f.app.closedHistory.length - before,
        );
        expect(added, hasLength(1));
        expect(added.single, isA<ClosedSwarm>());
        expect((added.single as ClosedSwarm).id, 'one');
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        f.app.superTabs.dispose();
        await tester.pump();
      },
    );

    testWidgets('a project of one tab\'s panes keeps that tab\'s sizes', (
      tester,
    ) async {
      final f = SuperTabLaunchFixture();
      f.app.machineStates['m']!.agents = [
        _agent('n1', remote: 'git@github.com:acme/api.git'),
        _agent('n2', remote: 'git@github.com:acme/api.git', cwd: '/w/wt'),
      ];
      final tab = _tab(f.app, 'one', [_pane('m', 'n1'), _pane('m', 'n2')]);
      tab.gridColumns = 2;
      late SuperTabController c;
      c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      final api = c.snapshot!.projects
          .firstWhere((p) => p.name == 'api')
          .leadConversationId;
      c
        ..select(api)
        ..selectGroupTerminals(api);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: f.app,
              builder: (_, _) => SuperTabWorkspace(
                app: f.app,
                canvas: const Text('Native terminals'),
                onAddAgent: (_) {},
              ),
            ),
          ),
        ),
      );
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 20));
      }
      final swarm = f.app.swarms.firstWhere((s) => s.superTabId == tabId);
      expect(swarm.panes, tab.panes);
      expect(swarm.gridColumns, 2);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    });
  });
}

int _projectCount(SuperTabLaunchFixture f) =>
    (f.connection.server.state['projects'] as List? ?? const []).length;
