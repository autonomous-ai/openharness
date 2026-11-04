import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/personal_lead.dart';
import 'package:harness/super_tabs/personal_projects.dart';
import 'package:harness/super_tabs/swarm_switcher.dart';
import 'package:harness/super_tabs/workspace.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/capture.dart';

// Huy, 11-04 (task #2815, a follow-up to #2633): in his Personal Swarm,
// # Harness Monitor had no Lead, and its empty chat said only "1 pane in this
// project · Discuss the plan with Product Manager · Show panes". A message
// there starts its Lead (#2633), but nothing said so. Now the empty chat
// offers the start itself, as a Buddy chat's start card does.

/// Set to a folder to write the PR's pictures of the empty chat.
final _shots = Platform.environment['PERSONAL_LEAD_CARD_SHOTS'];

var _paneIds = 9000;

/// The person's desk on this Mac: one tab, # Harness Monitor, with one pane,
/// in a checkout of the project's repo or, without [repo], a plain folder.
void _desk(SuperTabLaunchFixture f, {bool repo = true}) {
  f.app.machineStates['m']!.agents = [
    Agent(
      id: 'n1',
      name: 'Agent n1',
      engine: 'codex',
      terminalAvailable: true,
      project: AgentProject(
        name: 'harness-monitor',
        cwd: '/Users/huy/harness-monitor',
        root: repo ? '/Users/huy/harness-monitor' : null,
        remote: repo ? 'git@github.com:huy/harness-monitor.git' : null,
      ),
    ),
  ];
  f.app.swarms.add(
    Swarm(id: 'desk', name: 'Harness Monitor')
      ..panes.add(TerminalPane(id: _paneIds++, machineId: 'm', agentId: 'n1')),
  );
}

/// The fixture's Swarm made the person's Personal one ([personal] false leaves
/// it a Team Swarm), its projects made for the desk, # Harness Monitor shown.
Future<(SuperTabController, String)> _swarm(
  SuperTabLaunchFixture f, {
  bool personal = true,
}) async {
  for (final state in f.app.machineStates.values) {
    state.localOnly = true;
  }
  f.connection.server.state
    ..['name'] = personal ? 'Personal' : 'Team'
    ..['ownerId'] = 'owner'
    ..['people'] = [
      {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
      if (!personal)
        {'id': 'peer', 'email': 'peer@example.com', 'role': 'collaborator'},
    ];
  if (personal) {
    await f.app.superTabs.storage.write('super_tab.personal.owner', tabId);
  }
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Personal');
  PersonalSwarm.of(f.app).id;
  for (var i = 0; i < 20; i++) {
    await Future<void>.microtask(() {});
  }
  final c = await f.app.superTabs.open(tabId);
  await c.refresh();
  if (personal) await PersonalProjects.of(f.app).sync(c);
  // The desk's project; the Swarm's first one holds none of its panes.
  final chat = personal
      ? c.snapshot!.projects
            .firstWhere((p) => p.leadConversationId != 'lead')
            .leadConversationId
      : 'lead';
  c.select(chat);
  return (c, chat);
}

Future<void> _show(
  WidgetTester tester,
  SuperTabLaunchFixture f, {
  Brightness brightness = Brightness.light,
}) async {
  await tester.binding.setSurfaceSize(const Size(1280, 800));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
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
  await _settle(tester);
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 20; i++) {
    await tester.pump(const Duration(milliseconds: 20));
  }
}

Future<void> _close(
  WidgetTester tester,
  SuperTabLaunchFixture f,
  SuperTabController c,
) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  f.app.superTabs.dispose();
  await tester.pump();
}

Finder _key(String value) => find.byKey(ValueKey(value));
final _card = _key('super-lead-start');

List<Map> _claims(SuperTabLaunchFixture f) => [
  for (final post in f.connection.server.posts)
    if ((post['command'] as Map?)?['type'] == 'lead.claim')
      post['command'] as Map,
];

void main() {
  setUpAll(() => loadCaptureFonts(_shots));
  tearDown(() => PersonalLeadStarter.launchForTest = null);

  testWidgets('a Personal project with no Lead offers to start one, on this '
      'Mac with Claude Code in the repo\'s folder, above Show panes', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    _desk(f);
    final (c, _) = await _swarm(f);
    await _show(tester, f);
    expect(_card, findsOneWidget);
    expect(
      find.descendant(
        of: _card,
        matching: find.text('This project has no Lead yet'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: _key('super-lead-start-machine'),
        matching: find.text('Test host'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: _key('super-lead-start-engine'),
        matching: find.text('Claude Code'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: _key('super-lead-start-folder'),
        matching: find.textContaining('/Users/huy/harness-monitor'),
      ),
      findsOneWidget,
    );
    expect(find.widgetWithText(FilledButton, 'Start Lead'), findsOneWidget);
    // Show panes stays, under the card.
    final panes = _key('super-project-show-panes');
    expect(panes, findsOneWidget);
    expect(
      tester.getRect(panes).top,
      greaterThan(tester.getRect(_card).bottom),
    );
    await _close(tester, f, c);
  });

  testWidgets('with no repo, the card says the Lead starts in a new folder '
      'of the Harness projects folder', (tester) async {
    final f = SuperTabLaunchFixture();
    _desk(f, repo: false);
    final (c, _) = await _swarm(f);
    final plans = <PersonalLeadPlan>[];
    PersonalLeadStarter.launchForTest = (_, _, plan) async => plans.add(plan);
    await _show(tester, f);
    expect(
      find.descendant(
        of: _key('super-lead-start-folder'),
        matching: find.text('A new folder in your Harness projects folder'),
      ),
      findsOneWidget,
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Start Lead'));
    await _settle(tester);
    expect(plans.single.folder, isNull);
    await _close(tester, f, c);
  });

  testWidgets('Start Lead starts one Lead where the card says, however often '
      'it is pressed', (tester) async {
    final f = SuperTabLaunchFixture();
    _desk(f);
    final (c, chat) = await _swarm(f);
    final plans = <PersonalLeadPlan>[];
    PersonalLeadStarter.launchForTest = (_, id, plan) async {
      expect(id, chat);
      plans.add(plan);
    };
    await _show(tester, f);
    final start = find.widgetWithText(FilledButton, 'Start Lead');
    await tester.tap(start);
    await tester.tap(start, warnIfMissed: false);
    await _settle(tester);
    expect(_claims(f), hasLength(1));
    expect(plans, hasLength(1));
    expect(plans.single.machineId, 'm');
    expect(plans.single.engine, 'claude');
    expect(plans.single.folder, '/Users/huy/harness-monitor');
    await _close(tester, f, c);
  });

  testWidgets('the engine picked on the card is the one the Lead starts with', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    _desk(f);
    final (c, _) = await _swarm(f);
    final plans = <PersonalLeadPlan>[];
    PersonalLeadStarter.launchForTest = (_, _, plan) async => plans.add(plan);
    await _show(tester, f);
    await tester.tap(_key('super-lead-start-engine'));
    await _settle(tester);
    await tester.tap(find.text('Codex').last);
    await _settle(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Start Lead'));
    await _settle(tester);
    expect(plans.single.engine, 'codex');
    await _close(tester, f, c);
  });

  testWidgets('a project with a Lead shows no card', (tester) async {
    final f = SuperTabLaunchFixture();
    _desk(f);
    final (c, chat) = await _swarm(f);
    final state = f.connection.server.state;
    final project = (state['projects'] as List).cast<Map>().firstWhere(
      (p) => p['leadConversationId'] == chat,
    );
    (state['agents'] as List).add({
      'id': 'monitor-lead',
      'name': 'Lead',
      'machineId': 'm',
      'harnessId': 'h-lead',
      'contributorId': 'owner',
      'projectId': project['id'],
      'configuration': {'engine': 'claude'},
    });
    project['leadId'] = 'monitor-lead';
    (state['conversations'] as List).cast<Map>().firstWhere(
        (g) => g['id'] == chat,
      )
      ..['leadId'] = 'monitor-lead'
      ..['agentIds'] = ['monitor-lead'];
    await c.refresh();
    await _show(tester, f);
    expect(c.snapshot!.leadOf(project['id'] as String), isNotNull);
    expect(_card, findsNothing);
    expect(find.text('1 pane in this project'), findsOneWidget);
    await _close(tester, f, c);
  });

  testWidgets('a Team Swarm shows no card', (tester) async {
    final f = SuperTabLaunchFixture();
    _desk(f);
    final state = f.connection.server.state;
    (state['conversations'] as List).cast<Map>().first['leadId'] = null;
    final (c, _) = await _swarm(f, personal: false);
    await _show(tester, f);
    expect(_card, findsNothing);
    await _close(tester, f, c);
  });

  testWidgets('a failed start says why on the card, and Start Lead tries '
      'again', (tester) async {
    final f = SuperTabLaunchFixture();
    _desk(f);
    final (c, _) = await _swarm(f);
    var calls = 0;
    PersonalLeadStarter.launchForTest = (_, _, _) async {
      calls++;
      if (calls == 1) {
        throw const SuperTabFailure(
          'CREATE_FAILED',
          'Claude Code isn’t signed in on Test host.',
        );
      }
    };
    await _show(tester, f);
    await tester.tap(find.widgetWithText(FilledButton, 'Start Lead'));
    await _settle(tester);
    expect(
      find.descendant(
        of: _card,
        matching: find.text(
          'Couldn’t start a Lead: Claude Code isn’t signed in on Test host',
        ),
      ),
      findsOneWidget,
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Start Lead'));
    await _settle(tester);
    expect(calls, 2);
    await _close(tester, f, c);
  });

  for (final brightness in Brightness.values) {
    for (final failed in [false, true]) {
      final name =
          'personal-lead-card-${failed ? 'failed' : 'empty'}-'
          '${brightness.name}';
      testWidgets(name, (tester) async {
        final previous = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = previous);
        final f = SuperTabLaunchFixture();
        _desk(f);
        final (c, chat) = await _swarm(f);
        await _show(tester, f, brightness: brightness);
        if (failed) {
          PersonalLeadStarter.of(f.app).setStatusForTest(
            c,
            chat,
            const PersonalLeadStatus.failed(
              'Claude Code isn’t signed in on Test host',
            ),
          );
          await _settle(tester);
        }
        await captureWindow(tester, _shots, name);
        await _close(tester, f, c);
      }, skip: _shots == null);
    }
  }
}
