import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
import 'support/super_tab_fixture.dart';

// Huy, 11-04 (task #2815, a follow-up to #2633): in his Personal Swarm,
// # Harness Monitor had no Lead, and its empty chat said only "1 pane in this
// project · Discuss the plan with Product Manager · Show panes". Now the empty
// channel offers Start PM, which opens the PM's own chat at once (Swarm v4:
// only agents post in the channel; the person talks to the PM there).

/// Set to a folder to write the PR's pictures of the empty chat.
final _shots = Platform.environment['PERSONAL_LEAD_CARD_SHOTS'];

var _paneIds = 9000;

/// The person's desk on this Mac: one tab, # Harness Monitor, with one pane,
/// in a checkout of the project's repo or, without [repo], a plain folder and
/// a project of that name made by hand.
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
  if (!repo) _byHand(f, 'Harness Monitor');
}

/// A project the person made by hand, [name]: a pane with no repo is in no project (Swarm v4), so a project with no repo
/// is one made so.
void _byHand(SuperTabLaunchFixture f, String name) {
  final server = f.connection.server.state;
  (server['projects'] ??= [projectFixture('lead', 'Personal', 'lead')] as List)
      .add(
        projectFixture('by-hand', name, 'chat-by-hand', visibility: 'private'),
      );
  (server['conversations'] as List).add({
    ...conversationFixture('chat-by-hand', 'Lead'),
    'projectId': 'by-hand',
  });
}

/// The fixture's Swarm made the person's Personal one ([personal] false leaves
/// it a Team Swarm), its projects made for the desk, # Harness Monitor shown.
Future<(SuperTabController, String)> _swarm(
  SuperTabLaunchFixture f, {
  bool personal = true,
  String role = 'owner',
}) async {
  for (final state in f.app.machineStates.values) {
    state.localOnly = true;
  }
  f.connection.server.state
    ..['name'] = personal ? 'Personal' : 'Team'
    ..['ownerId'] = 'owner'
    ..['people'] = [
      {'id': 'owner', 'email': 'owner@example.com', 'role': role},
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

final _startPm = find.widgetWithText(FilledButton, 'Start PM');

String _line(WidgetTester tester) =>
    tester.widget<Text>(_key('super-lead-start-line')).data!;

/// The PM's own chat its start opened (backend pmChat.ts), as the fake server keeps it.
String _pmChat(SuperTabLaunchFixture f) =>
    (f.connection.server.state['conversations'] as List)
            .cast<Map>()
            .singleWhere(
              (g) =>
                  g['kind'] == 'agent-chat' && g['title'] == 'Product Manager',
            )['id']
        as String;

void main() {
  setUpAll(() => loadCaptureFonts(_shots));
  tearDown(() => PersonalLeadStarter.launchForTest = null);

  testWidgets('a Personal project with no PM offers Start PM, above Show '
      'panes', (tester) async {
    final f = SuperTabLaunchFixture();
    _desk(f);
    final (c, _) = await _swarm(f);
    await _show(tester, f);
    expect(_card, findsOneWidget);
    expect(_line(tester), 'This project has no Product Manager.');
    expect(_startPm, findsOneWidget);
    // Nothing to send in: the channel is agents only.
    expect(_key('super-agents-only'), findsOneWidget);
    expect(_key('super-message-composer'), findsNothing);
    // Show panes stays, under the card.
    final panes = _key('super-project-show-panes');
    expect(panes, findsOneWidget);
    expect(
      tester.getRect(panes).top,
      greaterThan(tester.getRect(_card).bottom),
    );
    await _close(tester, f, c);
  });

  testWidgets('Start PM starts one PM however often it is pressed, opens its '
      'own chat, and what the person sends there waits for it', (tester) async {
    final f = SuperTabLaunchFixture();
    _desk(f);
    final (c, channel) = await _swarm(f);
    final plans = <PersonalLeadPlan>[];
    PersonalLeadStarter.launchForTest = (_, id, plan) async {
      expect(id, channel);
      plans.add(plan);
    };
    await _show(tester, f);
    await tester.tap(_startPm);
    await tester.tap(_startPm, warnIfMissed: false);
    await _settle(tester);
    expect(_claims(f), hasLength(1));
    expect(plans, hasLength(1));
    expect(plans.single.machineId, 'm');
    expect(plans.single.engine, 'claude');
    expect(plans.single.folder, '/Users/huy/harness-monitor');
    // The PM's own chat is open, with a box to write in.
    final chat = _pmChat(f);
    expect(c.selectedId, chat);
    final composer = _key('super-message-composer');
    expect(composer, findsOneWidget);
    await tester.tap(composer);
    await tester.enterText(composer, 'Make the dashboard dark');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await _settle(tester);
    final sent = [
      for (final post in f.connection.server.posts)
        if ((post['command'] as Map)['type'] == 'message.send')
          post['command'] as Map,
    ];
    expect(sent.single['conversationId'], chat);
    expect(sent.single['text'], 'Make the dashboard dark');
    expect(find.text('Waiting for the Product Manager'), findsOneWidget);
    // The channel holds none of the person's words.
    expect(
      f.connection.server.messages.where((m) => m['conversationId'] == channel),
      isEmpty,
    );
    await _close(tester, f, c);
  });

  testWidgets('with no repo, Start PM starts it in a new folder of the '
      'Harness projects folder', (tester) async {
    final f = SuperTabLaunchFixture();
    _desk(f, repo: false);
    final (c, _) = await _swarm(f);
    final plans = <PersonalLeadPlan>[];
    PersonalLeadStarter.launchForTest = (_, _, plan) async => plans.add(plan);
    await _show(tester, f);
    await tester.tap(_startPm);
    await _settle(tester);
    expect(plans.single.folder, isNull);
    await _close(tester, f, c);
  });

  testWidgets('a project with a PM shows no card', (tester) async {
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

  testWidgets('with none of the person\'s computers online, the card says '
      'why and offers no Start PM', (tester) async {
    final f = SuperTabLaunchFixture();
    _desk(f);
    final (c, _) = await _swarm(f);
    f.app.machineStates['m']!.nodeOnline = false;
    await _show(tester, f);
    expect(
      _line(tester),
      'Can’t start a Product Manager: none of your computers is online',
    );
    expect(_startPm, findsNothing);
    await _close(tester, f, c);
  });

  testWidgets('a reader who can\'t write sees no card', (tester) async {
    final f = SuperTabLaunchFixture();
    _desk(f);
    final (c, _) = await _swarm(f, role: 'viewer');
    await _show(tester, f);
    expect(c.canWrite, isFalse);
    expect(find.text('1 pane in this project'), findsOneWidget);
    expect(_card, findsNothing);
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

  testWidgets('a failed start says why in its chat and back on the card, and '
      'Start PM tries again', (tester) async {
    final f = SuperTabLaunchFixture();
    _desk(f);
    final (c, channel) = await _swarm(f);
    var calls = 0;
    final first = Completer<void>();
    PersonalLeadStarter.launchForTest = (_, _, _) {
      calls++;
      return calls == 1 ? first.future : Future.value();
    };
    await _show(tester, f);
    await tester.tap(_startPm);
    await _settle(tester);
    // Its chat is open while it starts: what the person sends waits.
    final chat = _pmChat(f);
    expect(c.selectedId, chat);
    final composer = _key('super-message-composer');
    await tester.tap(composer);
    await tester.enterText(composer, 'Make the dashboard dark');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await _settle(tester);
    expect(find.text('Waiting for the Product Manager'), findsOneWidget);
    first.completeError(
      const SuperTabFailure(
        'CREATE_FAILED',
        'Claude Code isn’t signed in on Test host.',
      ),
    );
    await _settle(tester);
    // Back on the channel, whose card says why.
    const why = 'Claude Code isn’t signed in on Test host';
    expect(c.selectedId, channel);
    expect(_line(tester), 'Couldn’t start the Product Manager: $why');
    // Its chat says it under the message too.
    await c.select(chat);
    await _settle(tester);
    expect(
      find.text('Couldn’t start the Product Manager: $why'),
      findsOneWidget,
    );
    await c.select(channel);
    await _settle(tester);
    await tester.tap(_startPm);
    await _settle(tester);
    expect(calls, 2);
    await _close(tester, f, c);
  });

  for (final brightness in Brightness.values) {
    for (final failed in [false, true]) {
      final name =
          'personal-pm-card-${failed ? 'failed' : 'empty'}-'
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
