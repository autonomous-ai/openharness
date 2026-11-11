import 'dart:convert';
import 'dart:io';

import 'package:cryptography/dart.dart' show DartSha256;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart' show stableId;
import 'package:harness/super_tabs/personal_agents.dart' show swarmAgentId;
import 'package:harness/super_tabs/personal_projects.dart';
import 'package:harness/super_tabs/swarm_switcher.dart';
import 'package:harness/super_tabs/workspace.dart';
import 'package:harness/widgets/pane_grid.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'support/swarm_v4_data.dart';

/// Set to a folder to write the pictures of Projects there, in both themes at three window sizes.
final _shots = Platform.environment['PERSONAL_REPO_PROJECTS_SHOTS'];

/// Projects in a person's Personal Swarm (Swarm v4, anh Dee 2026-11-09): the repos their agents work in, the same repo on
/// two computers one project, each with its GitHub Tasks board; a pane with no repo is in no project, and the tab-named
/// projects of v3 go. Clicked through as a person does.
void main() {
  setUpAll(() => loadCaptureFonts(_shots));

  Finder key(String k) => find.byKey(ValueKey(k));

  Agent session(String id, String name, {String? remote, String cwd = '/w'}) =>
      Agent(
        id: id,
        name: name,
        nameChosen: true,
        engine: 'claude',
        terminalAvailable: true,
        project: AgentProject(
          name: cwd.split('/').last,
          cwd: cwd,
          root: remote == null ? null : cwd,
          remote: remote,
        ),
      );

  void computer(AppNotifier app, String id, String name) {
    final machine = Machine(
      machineId: id,
      authMode: MachineAuthMode.remote,
      name: name,
    );
    app.machines = [...app.machines, machine];
    app.machineStates[id] = MachineState(machine)
      ..localOnly = true
      ..nodeOnline = true
      ..agentLoadStatus = AgentLoadStatus.loaded;
  }

  var paneIds = 7000;
  TerminalPane pane(String machineId, String agentId) =>
      TerminalPane(id: paneIds++, machineId: machineId, agentId: agentId);

  /// The api on this Mac and on the laptop (two URL forms of one repo), the web app on this Mac, and notes in a folder
  /// with no repo, across the tabs `one` and `two`.
  void desk(SuperTabLaunchFixture f) {
    f.app.machineStates['m']!.agents = [
      session('api', 'Api builder', remote: 'git@github.com:Acme/api.git'),
      session('notes', 'Notes', cwd: '/Users/me/notes'),
      session('web', 'Web builder', remote: 'https://github.com/acme/web'),
    ];
    computer(f.app, 'laptop', 'Mac laptop');
    f.app.machineStates['laptop']!.agents = [
      session('api2', 'Api reviewer', remote: 'https://github.com/acme/api'),
    ];
    f.app.swarms
      ..add(
        Swarm(id: 'one', name: 'one')
          ..panes.addAll([pane('m', 'api'), pane('m', 'notes')]),
      )
      ..add(
        Swarm(id: 'two', name: 'two')
          ..panes.addAll([pane('m', 'web'), pane('laptop', 'api2')]),
      );
  }

  /// The request id v3 made tab [tab]'s project with: what the server checks a close against.
  String tabOperation(String tab) =>
      'personal-tab-${const DartSha256().hashSync(utf8.encode(tab)).bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join().substring(0, 24)}';

  /// The Personal Swarm in the real workspace, redrawn as the app is. [before] runs on the fixture first: what an older
  /// Desktop left on this computer and on the server.
  Future<
    ({SuperTabLaunchFixture f, SuperTabController c, List<List<String>> gh})
  >
  open(
    WidgetTester tester, {
    Future<void> Function(SuperTabLaunchFixture f)? before,
    Size size = const Size(1440, 900),
    Brightness brightness = Brightness.light,
  }) async {
    final f = SuperTabLaunchFixture();
    desk(f);
    f.connection.server.state
      ..['name'] = 'Personal'
      ..['ownerId'] = 'owner'
      ..['people'] = [
        {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
      ];
    await before?.call(f);
    await f.app.superTabs.storage.write('super_tab.personal.owner', tabId);
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Personal');
    PersonalSwarm.of(f.app).id;
    for (var i = 0; i < 20; i++) {
      await Future<void>.microtask(() {});
    }
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    final previous = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = previous);
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final gh = <List<String>>[];
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
              github: swarmV4GitHub(calls: gh),
              onAddAgent: (_) {},
              onNewProject: () {},
              onNewSwarm: () {},
            ),
          ),
        ),
      ),
    );
    // Personal makes its projects after the first frame; the view reads them as they come.
    for (var i = 0; i < 4; i++) {
      await tester.runAsync(() => Future<void>.delayed(Duration.zero));
      for (var j = 0; j < 4; j++) {
        await tester.pump(const Duration(milliseconds: 20));
      }
    }
    // The person is in the api's channel: the Swarm's own chat, open by default, stays listed while it is open.
    if (c.snapshot!.projects.where((p) => p.name == 'api').firstOrNull
        case final api?) {
      c.select(api.leadConversationId);
      await tester.pump(const Duration(milliseconds: 20));
    }
    return (f: f, c: c, gh: gh);
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

  List<Map<String, dynamic>> sent(SuperTabLaunchFixture f, String type) => [
    for (final post in f.connection.server.posts)
      if ((post['command'] as Map?)?['type'] == type)
        Map<String, dynamic>.from(post['command'] as Map),
  ];

  /// The projects the list shows, by name, in its order.
  List<String> listed(SuperTabController c) => [
    for (final project in c.snapshot!.projects)
      if (key('super-project-${project.id}').evaluate().isNotEmpty)
        project.name,
  ];

  String leadOf(SuperTabController c, String name) =>
      c.snapshot!.projects.firstWhere((p) => p.name == name).leadConversationId;

  testWidgets(
    'Projects are the repos the agents work in, one per repo across the computers, and a pane with no repo is in none',
    (tester) async {
      final (:f, :c, gh: _) = await open(tester);
      // Each repo is one project, the api's two computers included. The Swarm's own first project, which this Swarm
      // kept (the server deletes an empty one, PS-B), is listed as any other.
      expect(listed(c), unorderedEquals(['Personal', 'api', 'web']));
      for (final tab in ['one', 'two', 'Tab']) {
        expect(find.text(tab), findsNothing, reason: tab);
      }
      // The server learns each project's name and its GitHub repository, nothing else: no tab's, no folder's.
      expect(
        [for (final p in sent(f, 'project.create')) p['name']],
        ['api', 'web'],
      );
      expect([
        for (final p in sent(f, 'project.github')) p['repository'],
      ], unorderedEquals(['acme/api', 'acme/web']));
      expect(sent(f, 'project.rename'), isEmpty);
      final posted = f.connection.server.posts.toString();
      for (final leak in ['github.com', 'notes', '/Users', 'laptop']) {
        expect(posted, isNot(contains(leak)), reason: leak);
      }
      // The pane with no repo is still in Your Team.
      expect(key('super-pane-m-notes'), findsOneWidget);
      await close(tester, f, c);
    },
  );

  testWidgets(
    'a project opens its Tasks board on its repo\'s GitHub issues, read on this computer',
    (tester) async {
      final (:f, :c, :gh) = await open(tester);
      await tester.tap(key('super-group-${leadOf(c, 'api')}'));
      await tester.pump(const Duration(milliseconds: 50));
      await tester.tap(key('swarm-tasks-button'));
      for (var i = 0; i < 6; i++) {
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));
        await tester.pump(const Duration(milliseconds: 20));
      }
      expect(key('swarm-tasks-no-repository'), findsNothing);
      final read = gh.firstWhere((call) => call.contains('owner=acme'));
      expect(read, contains('name=api'));
      expect(
        find.text('No bathroom-break reminder skill ships'),
        findsOneWidget,
      );
      await close(tester, f, c);
    },
  );

  // Review of the Personal Swarm, finding 6: a computer that never saw a project's repo had no Tasks board.
  testWidgets(
    'a project whose repo no pane here works in still opens its Tasks board: the GitHub repository it names',
    (tester) async {
      final (:f, :c, :gh) = await open(
        tester,
        before: (f) async {
          final projects = f.connection.server.state['projects'] ??= [
            projectFixture('lead', 'Personal', 'lead'),
          ];
          (projects as List).add({
            ...projectFixture(
              'site',
              'site',
              'chat-site',
              visibility: 'private',
            ),
            'githubRepository': 'acme/site',
          });
          (f.connection.server.state['conversations'] as List).add({
            ...conversationFixture('chat-site', 'Lead'),
            'projectId': 'site',
          });
        },
      );
      expect(listed(c), contains('site'));
      await tester.tap(key('super-group-chat-site'));
      await tester.pump(const Duration(milliseconds: 50));
      await tester.tap(key('swarm-tasks-button'));
      for (var i = 0; i < 6; i++) {
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));
        await tester.pump(const Duration(milliseconds: 20));
      }
      expect(key('swarm-tasks-no-repository'), findsNothing);
      final read = gh.firstWhere((call) => call.contains('name=site'));
      expect(read, contains('owner=acme'));
      await close(tester, f, c);
    },
  );

  // Choose PM listed only the agents already in the Swarm: a person whose agents were all panes not opened yet met an empty
  // dialog whose Choose never woke, and nothing said why (PSQA, 2026-11-12).
  testWidgets(
    'Choose PM offers the person\'s panes too: choosing one joins it and makes it the PM, and one whose computer is off waits',
    (tester) async {
      final (:f, :c, gh: _) = await open(tester);
      f.app.machineStates['laptop']!.nodeOnline = false;
      f.app.notifyListeners();
      await tester.pump();
      final api = c.snapshot!.projects.firstWhere((p) => p.name == 'api');
      await tester.tap(find.widgetWithText(FilledButton, 'Choose PM'));
      await tester.pumpAndSettle();
      final here = key('choose-pm-${swarmAgentId('m', 'api')}');
      final off = key('choose-pm-${swarmAgentId('laptop', 'api2')}');
      expect(
        find.descendant(of: here, matching: find.text('Api builder')),
        findsOneWidget,
      );
      expect(tester.widget<ListTile>(off).enabled, isFalse);
      expect(
        find.descendant(of: off, matching: find.text('Mac laptop · offline')),
        findsOneWidget,
      );
      // Choose, then wait until the dialog says why or closes: at most 5 s.
      Future<void> choose() async {
        await tester.tap(key('choose-pm-confirm'));
        for (var i = 0; i < 100; i++) {
          await tester.runAsync(() => Future<void>.delayed(Duration.zero));
          await tester.pump(const Duration(milliseconds: 50));
          if (find.byType(AlertDialog).evaluate().isEmpty ||
              find.text('Choose your own computer.').evaluate().isNotEmpty) {
            return;
          }
        }
      }

      await tester.tap(here);
      await tester.pump();
      // A join its Swarm refuses is said in the dialog, and Choose again finishes it.
      f.connection.failJoin = const SuperTabFailure(
        'HOST_REQUIRED',
        'Choose your own computer.',
        statusCode: 403,
      );
      await choose();
      expect(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.text('Choose your own computer.'),
        ),
        findsOneWidget,
      );
      expect(sent(f, 'project.pm'), isEmpty);
      await choose();
      // It joined as a click on its row joins it, then became the PM: nothing else was started.
      expect(
        [for (final join in f.connection.joins) join['command']['harnessId']],
        ['api', 'api'],
      );
      expect(
        f.connection.joins[0]['operationId'],
        f.connection.joins[1]['operationId'],
      );
      expect(sent(f, 'project.pm').single, {
        'type': 'project.pm',
        'projectId': api.id,
        'agentId': 'lead-agent',
      });
      expect(sent(f, 'lead.start'), isEmpty);
      expect(find.byType(AlertDialog), findsNothing);
      expect(c.snapshot!.leadOf(api.id)?.id, 'lead-agent');
      await close(tester, f, c);
    },
  );

  testWidgets(
    'the tab-named projects an older Desktop made are closed on the server once, and leave the list',
    (tester) async {
      final (:f, :c, gh: _) = await open(
        tester,
        before: (f) async {
          // What v3 left: a project per tab with no-repo panes, each with its chat, one of them written in; and this
          // computer's record of them, with each project's layout and the order they came in.
          final projects = f.connection.server.state['projects'] ??= [
            projectFixture('lead', 'Personal', 'lead'),
          ];
          final chats = f.connection.server.state['conversations'] as List;
          for (final (id, name) in [('tab-one', 'one'), ('tab-two', 'two')]) {
            (projects as List).add(
              projectFixture(id, name, 'chat-$id', visibility: 'private'),
            );
            chats.add({
              ...conversationFixture('chat-$id', 'Lead'),
              'projectId': id,
              if (id == 'tab-two') 'lastMessageSequence': 3,
            });
          }
          await f.app.superTabs.storage.write(
            PersonalProjects.storageKey('owner'),
            jsonEncode({
              tabId: {
                'projects': {'tab:one': 'tab-one', 'tab:two': 'tab-two'},
                'renamed': <String>[],
                'layouts': {
                  'tab-one': {'count': 2},
                },
                'order': ['tab-one', 'tab-two'],
              },
            }),
          );
        },
      );
      expect(sent(f, 'project.closeTab'), [
        {
          'type': 'project.closeTab',
          'projectId': 'tab-one',
          'tabOperation': tabOperation('one'),
        },
        {
          'type': 'project.closeTab',
          'projectId': 'tab-two',
          'tabOperation': tabOperation('two'),
        },
      ]);
      // The one with no message is gone; the one written in is kept on the server, read-only, and not listed.
      expect(listed(c), unorderedEquals(['Personal', 'api', 'web']));
      expect(
        c.snapshot!.projects.where((p) => p.name == 'two').single.archived,
        isTrue,
      );
      // Once: this computer keeps nothing of the repos' projects (the server answers them), and the tabs' are closed.
      await PersonalProjects.of(f.app).sync(c);
      expect(sent(f, 'project.closeTab'), hasLength(2));
      final kept = jsonDecode(
        (await f.app.superTabs.storage.read(
          PersonalProjects.storageKey('owner'),
        ))!,
      ) as Map;
      expect(kept[tabId]?['projects'] ?? const {}, isEmpty);
      expect(kept[tabId], isNot(contains('layouts')));
      expect(kept[tabId], isNot(contains('order')));
      await close(tester, f, c);
    },
  );

  testWidgets(
    'a tab project another computer made is found by its desk tab and closed; one with an agent in it waits, out of the list',
    (tester) async {
      // Tab `one`'s project, which this computer has no record of: the server made its id from the Swarm, the person and
      // the request (backend `project.create`).
      final other = stableId([tabId, 'person:owner', tabOperation('one')]);
      final (:f, :c, gh: _) = await open(
        tester,
        before: (f) async {
          final server = f.connection.server.state;
          final projects = server['projects'] ??= [
            projectFixture('lead', 'Personal', 'lead'),
          ];
          final chats = server['conversations'] as List;
          for (final (id, name) in [(other, 'one'), ('tab-two', 'two')]) {
            (projects as List).add(
              projectFixture(id, name, 'chat-$id', visibility: 'private'),
            );
            chats.add({
              ...conversationFixture('chat-$id', 'Lead'),
              'projectId': id,
            });
          }
          // Tab `two`'s project has a PM in it: closing it would take the PM out of the Swarm.
          (server['agents'] ??= <dynamic>[]).add({
            'id': 'pm-two',
            'projectId': 'tab-two',
            'name': 'River',
            'displayName': 'River',
            'machineId': 'm',
            'harnessId': 'pm-two',
            'contributorId': 'owner',
            'configuration': {'engine': 'claude'},
            'kind': 'pm',
          });
          await f.app.superTabs.storage.write(
            PersonalProjects.storageKey('owner'),
            jsonEncode({
              tabId: {
                'projects': {'tab:two': 'tab-two'},
                'renamed': <String>[],
              },
            }),
          );
        },
      );
      expect(sent(f, 'project.closeTab'), [
        {
          'type': 'project.closeTab',
          'projectId': other,
          'tabOperation': tabOperation('one'),
        },
      ]);
      expect(listed(c), unorderedEquals(['Personal', 'api', 'web']));
      expect(c.snapshot!.projectById('tab-two'), isNotNull);
      await close(tester, f, c);
    },
  );

  testWidgets(
    'an agent started in the Swarm, with no pane in a tab, makes the repo it works in a project',
    (tester) async {
      final (:f, :c, gh: _) = await open(
        tester,
        before: (f) async {
          f.app.machineStates['m']!.agents = [
            ...f.app.machineStates['m']!.agents,
            session('docs', 'Docs bot', remote: 'git@github.com:acme/docs.git'),
          ];
          (f.connection.server.state['agents'] ??= <dynamic>[]).add({
            'id': 'docs-bot',
            'projectId': 'lead',
            'name': 'Docs bot',
            'displayName': 'Docs bot',
            'machineId': 'm',
            'harnessId': 'docs',
            'contributorId': 'owner',
            'configuration': {'engine': 'claude'},
            'kind': 'regular',
            'myAgent': true,
          });
        },
      );
      expect(listed(c), unorderedEquals(['Personal', 'api', 'docs', 'web']));
      await close(tester, f, c);
    },
  );

  testWidgets(
    'the Swarm\'s own first project, which the server keeps while it has messages, is listed as any project',
    (tester) async {
      final (:f, :c, gh: _) = await open(tester);
      expect(listed(c), unorderedEquals(['Personal', 'api', 'web']));
      expect(sent(f, 'project.delete'), isEmpty);
      await close(tester, f, c);
    },
  );

  for (final brightness in Brightness.values) {
    for (final size in const [
      Size(1440, 900),
      Size(1024, 700),
      Size(700, 800),
    ]) {
      testWidgets(
        'pictures: Projects and a project\'s Tasks at ${size.width.toInt()}x${size.height.toInt()}, ${brightness.name}',
        (tester) async {
          if (_shots == null) return;
          final (:f, :c, gh: _) = await open(
            tester,
            size: size,
            brightness: brightness,
          );
          final name =
              'repo-projects-${size.width.toInt()}x${size.height.toInt()}-${brightness.name}';
          await captureWindow(tester, _shots, '$name-list');
          final row = key('super-group-${leadOf(c, 'api')}');
          if (row.evaluate().isNotEmpty) {
            await tester.tap(row);
            await tester.pump(const Duration(milliseconds: 50));
            final tasks = key('swarm-tasks-button');
            if (tasks.evaluate().isNotEmpty) {
              await tester.tap(tasks);
              for (var i = 0; i < 6; i++) {
                await tester.runAsync(
                  () => Future<void>.delayed(Duration.zero),
                );
                await tester.pump(const Duration(milliseconds: 20));
              }
            }
            await captureWindow(tester, _shots, '$name-tasks');
          }
          await close(tester, f, c);
        },
        variant: TargetPlatformVariant.only(TargetPlatform.macOS),
      );
    }
  }
}
