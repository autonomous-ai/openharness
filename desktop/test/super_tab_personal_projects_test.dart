import 'dart:async';
import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/personal_projects.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/swarm_switcher.dart';
import 'package:harness/super_tabs/workspace.dart';
import 'package:harness/widgets/pane_grid.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's pictures there.
final _shots = Platform.environment['PERSONAL_PROJECTS_SHOTS'];

/// A pane's agent, in a checkout of [remote] (none for a folder), which
/// stands for [repository] when its host is an SSH alias.
Agent _agent(
  String id, {
  String? remote,
  String? repository,
  String cwd = '/work/x',
}) => Agent(
  id: id,
  name: 'Agent $id',
  engine: 'codex',
  terminalAvailable: true,
  project: AgentProject(
    name: cwd.split('/').last,
    cwd: cwd,
    root: remote == null ? null : cwd,
    remote: remote,
    repository: repository,
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
Swarm _tab(
  AppNotifier app,
  String id,
  List<TerminalPane> panes, {
  String? name,
}) {
  final tab = Swarm(id: id, name: name ?? id)..panes.addAll(panes);
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
  // These panes are this computer's: Personal's sync of other machines has no part here.
  for (final state in f.app.machineStates.values) {
    state.localOnly = true;
  }
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

  for (final brightness in Brightness.values) {
    testWidgets('pictures of a Personal project leaving the list once its '
        'panes close (task #3042), in ${brightness.name}', (tester) async {
      if (_shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(2560, 1440);
      addTearDown(tester.view.reset);
      final f = SuperTabLaunchFixture();
      final p = _desk(f);
      final c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      c.select(
        c.snapshot!.projects
            .firstWhere((p) => p.name == 'web')
            .leadConversationId,
      );
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
      await captureWindow(
        tester,
        _shots,
        'personal-panes-open-${brightness.name}',
      );
      f.app.swarms.firstWhere((s) => s.id == 'one').panes.remove(p.api);
      f.app.swarms.firstWhere((s) => s.id == 'two').panes.remove(p.api2);
      f.app.notifyListeners();
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 20));
      }
      await captureWindow(
        tester,
        _shots,
        'personal-panes-closed-${brightness.name}',
      );
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

    test('the daemon\'s own form, host/owner/repo, is that repo too', () {
      // What every agent reports as its project's remote (cli agentProject.ts
      // canonicalRepository): no scheme, no user, no .git.
      for (final form in [
        'github.com/acme/api',
        'GitHub.com/Acme/Api',
        'github.com/acme/api/',
      ]) {
        expect(normalizedRemote(form), 'github.com/acme/api', reason: form);
      }
      expect(
        normalizedRemote('example.com:2222/Org/App'),
        'example.com/org/app',
      );
      expect(
        normalizedRemote('gitlab.com/team/sub/api'),
        'gitlab.com/team/sub/api',
      );
    });

    test('a remote through an SSH host alias is a repo too (task #2476)', () {
      // A second GitHub account's clone (`git@gh-work:acme/api.git`, #2525):
      // the daemon reports its alias as the host, with no dot in it.
      expect(normalizedRemote('gh-work/acme/api'), 'gh-work/acme/api');
      expect(normalizedRemote('GH-Work/Acme/Api'), 'gh-work/acme/api');
      expect(normalizedRemote('gitserver:2222/team/api'), 'gitserver/team/api');
      // `Host github.com-work` is the other common way to name one.
      expect(
        normalizedRemote('github.com-work/acme/api'),
        'github.com-work/acme/api',
      );
      expect(normalizedRemote('git@gh-work:Acme/Api.git'), 'gh-work/acme/api');
    });

    test('a folder or nothing is no repo', () {
      for (final form in [
        null,
        '',
        '/srv/git/api.git',
        '/srv/api',
        './api',
        '../api',
        '.hidden/api',
        'file:///srv/git/api.git',
        r'C:\repos\api',
        r'C:\api',
        'C:/repos/api',
        'c/api',
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
    });

    test('two repos of one name have long names that tell them apart', () {
      expect(repoName('github.com/acme/api'), 'api');
      expect(repoLongName('github.com/acme/api'), 'api (acme/api)');
      expect(repoLongName('gitlab.com/team/sub/api'), 'api (sub/api)');
    });
  });

  group('the person\'s panes, by repo', () {
    test(
      'every pane in a repo joins it whatever tab it is in, in tab order',
      () {
        final f = SuperTabLaunchFixture();
        final p = _desk(f);
        final panes = personalPanes(f.app);
        // The folder has no repo: it is in no project.
        expect([for (final e in panes) e.pane], [p.api, p.web, p.api2]);
        expect(
          [for (final e in panes) e.repo],
          ['github.com/acme/api', 'github.com/acme/web', 'github.com/acme/api'],
        );
      },
    );

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
        f.app.machineStates['m']!.agents = [
          _agent('n1', remote: 'git@github.com:acme/api.git'),
        ];
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
      f.app.machineStates['m']!.agents = [
        _agent('n1', remote: 'git@github.com:acme/api.git'),
      ];
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.app.activeSwarm.panes.add(_pane('m', 'n1'));
      expect(personalPanes(f.app), isEmpty);
    });
  });

  group('Personal\'s projects', () {
    test('each repo is made once as a private project, and a pane with no repo makes none', () async {
      final f = SuperTabLaunchFixture();
      _desk(f);
      final c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      final creates = _commands(f);
      expect(
        [for (final p in creates) p['operationId']],
        [
          personalProjectOperation('github.com/acme/api'),
          personalProjectOperation('github.com/acme/web'),
        ],
      );
      expect([for (final p in creates) p['command']['name']], ['api', 'web']);
      expect(
        creates.every((p) => p['command']['visibility'] == 'private'),
        isTrue,
      );
      final names = [for (final p in c.snapshot!.projects) p.name];
      expect(names, containsAll(['api', 'web']));
      expect(names, isNot(contains('one')));

      // Again: nothing.
      await PersonalProjects.of(f.app).sync(c);
      expect(_commands(f), hasLength(2));

      // Each names its GitHub repository on the server, once.
      expect(
        [
          for (final post in f.connection.server.posts)
            if ((post['command'] as Map)['type'] == 'project.github')
              (post['command'] as Map)['repository'],
        ],
        ['acme/api', 'acme/web'],
      );
      expect({
        for (final p in c.snapshot!.projects) p.name: p.githubRepository,
      }, containsPair('api', 'acme/api'));

      // The app restarted on the same computer, or another computer: nothing kept here, and no request either: each
      // project names its repository.
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
    });

    test('panes whose agents report the daemon\'s own remote form get repo projects', () async {
      final f = SuperTabLaunchFixture();
      f.app.machineStates['m']!.agents = [
        _agent('n1', remote: 'github.com/acme/api', cwd: '/w/api'),
        _agent('n2', remote: 'github.com/acme/web', cwd: '/w/web'),
      ];
      _machine(f.app, 'laptop').agents = [
        _agent('n1', remote: 'github.com/acme/api', cwd: '/x/api-copy'),
      ];
      _tab(f.app, 'one', [_pane('m', 'n1'), _pane('m', 'n2')]);
      _tab(f.app, 'two', [_pane('laptop', 'n1')]);
      expect(
        [for (final e in personalPanes(f.app)) e.repo],
        ['github.com/acme/api', 'github.com/acme/web', 'github.com/acme/api'],
      );
      final c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      expect(
        [for (final p in _commands(f)) p['operationId']],
        [
          personalProjectOperation('github.com/acme/api'),
          personalProjectOperation('github.com/acme/web'),
        ],
      );
      final names = [for (final p in c.snapshot!.projects) p.name];
      expect(names, containsAll(['api', 'web']));
      expect(names, isNot(contains('scratch')));
    });

    test('a GitHub repository the server refuses is not asked again, and one whose record names its address is not '
        'asked at all', () async {
      final f = SuperTabLaunchFixture();
      _desk(f);
      final c = await _personal(f);
      final projects = PersonalProjects.of(f.app);
      await projects.sync(c);
      final named = _commands(f, 'project.github').length;
      expect(named, 2);
      (f.connection.server.state['projects'] as List).cast<Map>().forEach((p) {
        p.remove('githubRepository');
        if (p['name'] == 'web') {
          p['repository'] = {'repositoryUrl': 'https://github.com/acme/web'};
        }
      });
      await c.refresh();
      f.connection.server.refuse = {
        'code': 'PROJECT_REPOSITORY_SET',
        'message': 'This project has a repository.',
      };
      // Synced again: api's is refused (409), web's is not asked (its record names its address).
      await projects.sync(c);
      f.connection.server.refuse = null;
      await projects.sync(c);
      final again = _commands(f, 'project.github').skip(named).toList();
      expect([for (final p in again) p['command']['repository']], ['acme/api']);
    });

    test('nothing is sent of a pane but its project\'s name and its GitHub '
        'repository', () async {
      final f = SuperTabLaunchFixture();
      _desk(f);
      final c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      final sent = f.connection.server.posts.toString();
      expect(sent, contains('acme/api'));
      for (final leak in [
        'github.com',
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

        // Someone they invited changes nothing: it is still their Personal Swarm, with their repos' projects.
        final shared = SuperTabLaunchFixture();
        _desk(shared);
        final sc = await _personal(shared, people: ['owner', 'kim']);
        await PersonalProjects.of(shared.app).sync(sc);
        expect(
          [for (final p in _commands(shared)) p['command']['name']],
          ['api', 'web'],
        );
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

    // anh Dee, 2026-11-11: the person invites people to their Personal Swarm, and it stays theirs.
    test(
      'an answer after someone joined Personal is kept: it is still theirs',
      () async {
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
        expect(
          [for (final p in _commands(f)) p['command']['name']],
          ['api', 'web'],
        );
        expect(
          PersonalProjects.of(f.app).knownForTest('owner', tabId),
          hasLength(2),
        );
      },
    );

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

    test('a refused rename of two repos of one name is logged by its code, not the repo', () async {
      final lines = <String>[];
      final previous = appLog;
      appLog = _Recorder(lines);
      addTearDown(() => appLog = previous);
      final f = SuperTabLaunchFixture();
      f.app.machineStates['m']!.agents = [
        _agent('n1', remote: 'git@github.com:acme/api.git'),
        _agent('n2', remote: 'git@github.com:kim/api.git'),
      ];
      _tab(f.app, 'one', [_pane('m', 'n1'), _pane('m', 'n2')]);
      final c = await _personal(f);
      f.connection.server.unknownCommand = (command) =>
          command['type'] == 'project.rename';
      await PersonalProjects.of(f.app).sync(c);
      expect(lines.where((l) => l.contains('VALIDATION_ERROR')), isNotEmpty);
      for (final line in lines) {
        expect(line, isNot(contains('acme')), reason: line);
        expect(line, isNot(contains('kim')), reason: line);
      }
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

    test('an agent of Your Team works in its own pane\'s repo: where its tasks are read', () async {
      final f = SuperTabLaunchFixture();
      _desk(f);
      final c = await _personal(f);
      (f.connection.server.state['agents'] ??= <dynamic>[]).addAll([
        for (final (machine, harness) in [('laptop', 'n1'), ('m', 'n2')])
          {
            'id': 'agent-$harness',
            'projectId': 'lead',
            'name': harness,
            'displayName': harness,
            'machineId': machine,
            'harnessId': harness,
            'contributorId': 'owner',
            'configuration': {'engine': 'codex'},
            'kind': 'regular',
            'myAgent': true,
          },
      ]);
      await c.refresh();
      final projects = PersonalProjects.of(f.app);
      SuperTabAgent agent(String id) => c.snapshot!.agent(id)!;
      expect(
        projects.agentRepository(c, agent('agent-n1')),
        'github.com/acme/api',
      );
      // Notes, in a folder: no repo, no tasks.
      expect(projects.agentRepository(c, agent('agent-n2')), isNull);
      // Never outside the person's own Personal Swarm.
      c.accessRevoked = true;
      expect(projects.agentRepository(c, agent('agent-n1')), isNull);
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
      expect(projects.panesFor(c, lead('web')), [p.web]);

      // The folder becomes a checkout of the web app.
      f.app.machineStates['m']!.agents = [
        for (final a in f.app.machineStates['m']!.agents)
          a.id == 'n2'
              ? _agent('n2', remote: 'git@github.com:acme/web.git')
              : a,
      ];
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
      expect(_commands(f), hasLength(2));
    });
  });

  group('panes with no repo, and repos through an SSH alias', () {
    test('panes with a repo join the repo\'s project, whatever tab; a folder joins none', () {
      final f = SuperTabLaunchFixture();
      final p = _desk(f);
      final keys = {for (final e in personalPanes(f.app)) e.pane: e.repo};
      expect(keys[p.api], 'github.com/acme/api');
      expect(keys[p.api2], 'github.com/acme/api');
      expect(keys[p.web], 'github.com/acme/web');
      expect(keys, isNot(contains(p.folder)));
    });

    test('a pane on an SSH alias clone joins its repo (task #2476)', () async {
      final f = SuperTabLaunchFixture();
      f.app.machineStates['m']!.agents = [
        _agent('a1', remote: 'gh-work/acme/api', cwd: '/w/api'),
        _agent('f1', cwd: '/w/notes'),
      ];
      _machine(f.app, 'laptop').agents = [
        _agent('a2', remote: 'gh-work/acme/api', cwd: '/x/api'),
      ];
      _tab(f.app, 'one', [_pane('m', 'a1'), _pane('m', 'f1')]);
      _tab(f.app, 'two', [_pane('laptop', 'a2')]);
      expect(
        [for (final e in personalPanes(f.app)) e.repo],
        ['gh-work/acme/api', 'gh-work/acme/api'],
      );
      final c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      expect([for (final p in _commands(f)) p['command']['name']], ['api']);
      final api = c.snapshot!.projects
          .firstWhere((p) => p.name == 'api')
          .leadConversationId;
      // Both panes, in two tabs on two computers, are the one project's.
      expect(
        [
          for (final p in PersonalProjects.of(f.app).panesFor(c, api))
            p.agentId,
        ],
        ['a1', 'a2'],
      );
    });

    test('the repo an alias stands for is the one project on every computer (task #2476)', () async {
      final f = SuperTabLaunchFixture();
      // This Mac cloned it through `Host gh-work`; the laptop straight from GitHub.
      f.app.machineStates['m']!.agents = [
        _agent(
          'a1',
          remote: 'gh-work/acme/api',
          repository: 'github.com/acme/api',
          cwd: '/w/api',
        ),
        // A repository that is no remote is not believed: the remote stands.
        _agent('a3', remote: 'gh-work/acme/web', repository: '/srv/web'),
      ];
      _machine(f.app, 'laptop').agents = [
        _agent('a2', remote: 'github.com/acme/api', cwd: '/x/api'),
      ];
      _tab(f.app, 'one', [_pane('m', 'a1'), _pane('m', 'a3')]);
      _tab(f.app, 'two', [_pane('laptop', 'a2')]);
      expect(
        [for (final e in personalPanes(f.app)) e.repo],
        ['github.com/acme/api', 'gh-work/acme/web', 'github.com/acme/api'],
      );
      final c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      expect(
        [for (final p in _commands(f)) p['operationId']],
        [
          personalProjectOperation('github.com/acme/api'),
          personalProjectOperation('gh-work/acme/web'),
        ],
      );
    });

    test('the daemon\'s repository is read with the project', () {
      final project = AgentProject.fromJson({
        'name': 'api',
        'cwd': '/w/api',
        'root': '/w/api',
        'remote': 'gh-work/acme/api',
        'repository': 'github.com/acme/api',
      })!;
      expect(project.repository, 'github.com/acme/api');
      expect(
        project,
        isNot(
          AgentProject.fromJson({
            'name': 'api',
            'cwd': '/w/api',
            'root': '/w/api',
            'remote': 'gh-work/acme/api',
          }),
        ),
      );
      // An older daemon sends none.
      expect(
        AgentProject.fromJson({'name': 'x', 'cwd': '/x'})!.repository,
        isNull,
      );
    });
  });

  group('the empty chat of a project with panes (task #2376)', () {
    Future<void> show(WidgetTester tester, SuperTabLaunchFixture f) async {
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
    }

    Future<void> close(
      WidgetTester tester,
      SuperTabLaunchFixture f,
      SuperTabController c,
    ) async {
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    }

    testWidgets('says how many panes the project has, and opens them', (
      tester,
    ) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final f = SuperTabLaunchFixture();
      final p = _desk(f);
      final c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      final code = c.snapshot!.projects.firstWhere((p) => p.name == 'api');
      c.select(code.leadConversationId);
      await show(tester, f);
      expect(find.text('2 panes in this project'), findsOneWidget);
      // An empty chat says nothing (rule 7, #4465).
      expect(find.textContaining('Discuss the plan'), findsNothing);
      await tester.tap(find.text('Show panes'));
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 20));
      }
      expect(c.groupTerminalsOpen(code.leadConversationId), isTrue);
      final swarm = f.app.swarms.firstWhere((s) => s.superTabId == tabId);
      expect(swarm.panes, [p.api, p.api2]);
      await close(tester, f, c);
    });

    testWidgets('one pane is one pane', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final f = SuperTabLaunchFixture();
      _desk(f);
      final c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      c.select(
        c.snapshot!.projects
            .firstWhere((p) => p.name == 'web')
            .leadConversationId,
      );
      await show(tester, f);
      expect(find.text('1 pane in this project'), findsOneWidget);
      await close(tester, f, c);
    });

    testWidgets('a project with no panes keeps today\'s empty chat', (
      tester,
    ) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final f = SuperTabLaunchFixture();
      _desk(f);
      final c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      // The Personal Swarm's first project holds none of the person's panes.
      final first = c.snapshot!.projects.firstWhere(
        (p) => p.name == 'Pilot' || p.name == 'Personal',
      );
      c.select(first.leadConversationId);
      await show(tester, f);
      expect(find.textContaining('panes in this project'), findsNothing);
      expect(find.text('Show panes'), findsNothing);
      // An empty chat says nothing (rule 7, #4465).
      expect(find.textContaining('Discuss the plan'), findsNothing);
      await close(tester, f, c);
    });
  });

  // Huy, 11-05 (task #3042): every pane of a repo closed, its project
  // leaves the list; its chat stays; a pane of it opening brings it back.
  group('a project with no panes leaves the list', () {
    SuperTabProject named(SuperTabController c, String name) =>
        c.snapshot!.projects.firstWhere((p) => p.name == name);

    List<Map<String, dynamic>> removals(SuperTabLaunchFixture f) => [
      for (final post in f.connection.server.posts)
        if ((post['command'] as Map?)?['type'] case final String type
            when type.contains('delete') || type.contains('archive'))
          Map<String, dynamic>.from(post),
    ];

    test('closing every pane of a repo hides its project, and a pane of it '
        'opening shows it again with its chat', () async {
      final f = SuperTabLaunchFixture();
      final p = _desk(f);
      final c = await _personal(f);
      final projects = PersonalProjects.of(f.app);
      await projects.sync(c);
      final api = named(c, 'api'), web = named(c, 'web');
      expect(projects.hidden(c, api.id), isFalse);

      final one = f.app.swarms.firstWhere((s) => s.id == 'one');
      final two = f.app.swarms.firstWhere((s) => s.id == 'two');
      one.panes.remove(p.api);
      // One of its panes is still open, on the laptop.
      expect(projects.hidden(c, api.id), isFalse);
      two.panes.remove(p.api2);
      expect(projects.hidden(c, api.id), isTrue);
      expect(projects.hidden(c, web.id), isFalse);

      // Its chat is kept: nothing was deleted or archived on the server.
      expect(removals(f), isEmpty);
      expect(c.snapshot!.conversation(api.leadConversationId), isNotNull);

      two.panes.add(p.api2);
      expect(projects.hidden(c, api.id), isFalse);
      expect(projects.panesFor(c, api.leadConversationId), [p.api2]);
    });

    // Review of #4088: nothing of a repo's project is kept on a computer, so a restart must still know it.
    test('after a restart, a repo project whose panes are all closed still leaves the list', () async {
      final f = SuperTabLaunchFixture();
      final p = _desk(f);
      final c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      final restarted = SuperTabLaunchFixture();
      restarted.store.values.addAll(f.store.values);
      restarted.connection.server.state
        ..clear()
        ..addAll(f.connection.server.state);
      final rp = _desk(restarted);
      final rc = await _personal(restarted);
      final projects = PersonalProjects.of(restarted.app);
      final api = named(rc, 'api');
      expect(projects.hidden(rc, api.id), isFalse);
      restarted.app.swarms
          .firstWhere((s) => s.id == 'one')
          .panes
          .remove(rp.api);
      restarted.app.swarms
          .firstWhere((s) => s.id == 'two')
          .panes
          .remove(rp.api2);
      // No sync since the restart: known by the GitHub repository it names.
      expect(projects.hidden(rc, api.id), isTrue);
      expect(p.api, isNotNull);
    });

    test('the list works out every hidden project in one pass, with the same '
        'answer as asking each (review of #3073)', () async {
      final f = SuperTabLaunchFixture();
      final p = _desk(f);
      final c = await _personal(f);
      final projects = PersonalProjects.of(f.app);
      await projects.sync(c);
      final api = named(c, 'api');
      // The Swarm's own first project is listed as any other (the server deletes an empty one, PS-B).
      expect(projects.hiddenIn(c), isEmpty);
      f.app.swarms.firstWhere((s) => s.id == 'one').panes.remove(p.api);
      f.app.swarms.firstWhere((s) => s.id == 'two').panes.remove(p.api2);
      expect(projects.hiddenIn(c), {api.id});
      for (final project in c.snapshot!.projects) {
        expect(
          projects.hidden(c, project.id),
          projects.hiddenIn(c).contains(project.id),
          reason: project.name,
        );
      }
      // A machine with one of the panes not listed yet: no repo's project hides.
      f.app.machineStates['m']!
        ..agentsListedOnce = false
        ..agentLoadStatus = AgentLoadStatus.loading;
      expect(projects.hiddenIn(c), isEmpty);
    });

    test('nothing hides while a machine with one of the panes has not listed '
        'its agents yet', () async {
      final f = SuperTabLaunchFixture();
      final p = _desk(f);
      final c = await _personal(f);
      final projects = PersonalProjects.of(f.app);
      await projects.sync(c);
      final api = named(c, 'api');
      f.app.swarms.firstWhere((s) => s.id == 'one').panes.remove(p.api);
      // The laptop just came back and has not said what runs there: its
      // pane may well be the api's.
      f.app.machineStates['laptop']!
        ..agents = const []
        ..agentsListedOnce = false
        ..agentLoadStatus = AgentLoadStatus.loading;
      expect(projects.hidden(c, api.id), isFalse);
      f.app.machineStates['laptop']!
        ..agents = [_agent('n1', remote: 'https://github.com/acme/api')]
        ..agentsListedOnce = true
        ..agentLoadStatus = AgentLoadStatus.loaded;
      expect(projects.hidden(c, api.id), isFalse);
      f.app.swarms.firstWhere((s) => s.id == 'two').panes.remove(p.api2);
      expect(projects.hidden(c, api.id), isTrue);
    });

    test('a project made by hand, and any project of a Team Swarm, never '
        'hides', () async {
      final f = SuperTabLaunchFixture();
      _desk(f);
      final server = f.connection.server.state;
      (server['projects'] ??= [
        projectFixture('lead', 'Personal', 'lead'),
      ]).add(projectFixture('by-hand', 'Notes', 'chat-by-hand'));
      (server['conversations'] as List).add({
        ...conversationFixture('chat-by-hand', 'Lead'),
        'projectId': 'by-hand',
      });
      final c = await _personal(f);
      final projects = PersonalProjects.of(f.app);
      await projects.sync(c);
      f.app.swarms.removeWhere((s) => s.id == 'one' || s.id == 'two');
      expect(projects.hidden(c, named(c, 'api').id), isTrue);
      expect(projects.hidden(c, 'by-hand'), isFalse);

      final team = SuperTabLaunchFixture();
      _desk(team);
      team.app.bindSuperTab(team.app.activeSwarmId, tabId, 'Pilot');
      final tc = await team.app.superTabs.open(tabId);
      await tc.refresh();
      expect(PersonalProjects.of(team.app).hidden(tc, 'lead'), isFalse);
    });

    // anh Dee, 2026-11-11: the person invites people to their Personal Swarm, as to any Swarm.
    testWidgets('Personal shows its owner Invite people, as any Swarm does', (
      tester,
    ) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final f = SuperTabLaunchFixture();
      _desk(f);
      final c = await _personal(f);
      expect(c.isOwner, isTrue);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 260,
              child: ProjectSidebar(
                controller: c,
                app: f.app,
                onSelect: c.select,
                onInvite: () {},
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.text('Invite people'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    });

    testWidgets('the list leaves it out, but keeps it while its chat is open', (
      tester,
    ) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final f = SuperTabLaunchFixture();
      final p = _desk(f);
      final c = await _personal(f);
      await PersonalProjects.of(f.app).sync(c);
      final api = named(c, 'api'), web = named(c, 'web');
      final redraw = ValueNotifier(0);
      addTearDown(redraw.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: Listenable.merge([f.app, c, redraw]),
              builder: (_, _) => SizedBox(
                width: 260,
                child: ProjectSidebar(
                  controller: c,
                  app: f.app,
                  onSelect: c.select,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      Finder row(SuperTabProject project) =>
          find.byKey(ValueKey('super-project-${project.id}'));
      expect(row(api), findsOneWidget);

      c.select(api.leadConversationId);
      f.app.swarms.firstWhere((s) => s.id == 'one').panes.remove(p.api);
      f.app.swarms.firstWhere((s) => s.id == 'two').panes.remove(p.api2);
      redraw.value++;
      await tester.pump();
      // Open now: it stays until the person goes elsewhere.
      expect(row(api), findsOneWidget);

      c.select(web.leadConversationId);
      redraw.value++;
      await tester.pump();
      expect(row(api), findsNothing);
      expect(row(web), findsOneWidget);
      expect(
        superTabSidebarOrder(c, app: f.app),
        isNot(contains(api.leadConversationId)),
      );

      f.app.swarms.firstWhere((s) => s.id == 'two').panes.add(p.api2);
      redraw.value++;
      await tester.pump();
      expect(row(api), findsOneWidget);
      expect(
        superTabSidebarOrder(c, app: f.app),
        contains(api.leadConversationId),
      );

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    });
  });

  group('[term]', () {
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

class _Recorder implements AppLog {
  _Recorder(this.lines);
  final List<String> lines;

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) => lines.add('$level $category $message ${error ?? ''}');
}
