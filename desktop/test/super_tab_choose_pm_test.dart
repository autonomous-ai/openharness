import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the pull request's pictures of Choose PM there.
final _shots = Platform.environment['CHOOSE_PM_SHOTS'];

/// Choose PM (anh Dee, 2026-11-11: "in a project's settings, the person chooses the PM from their agents. Choosing again
/// switches it. No new folders."), clicked through as a person does: Project settings, and a channel with no PM.
void main() {
  setUpAll(() => loadCaptureFonts(_shots));

  Finder key(String k) => find.byKey(ValueKey(k));

  Map<String, dynamic> agent(
    String id,
    String name, {
    String person = 'owner',
    String? chatId,
  }) => {
    'id': id,
    'name': name,
    'displayName': name,
    'machineId': '$person-mac',
    'harnessId': 'h-$id',
    'contributorId': person,
    'machineOwnerId': person,
    'configuration': {'engine': 'claude'},
    'kind': 'regular',
    'chatId': chatId ?? 'chat-$id',
    'myAgent': person == 'owner',
  };

  /// A Swarm with the project "api" (its channel `lead`), [pm] its PM or none, the owner's agents Kai and Pip, Juno the PM
  /// of another project "web", and a member's agent Rex.
  ConversationServer swarm({String? pm = 'kai'}) {
    final server = ConversationServer();
    server.state['people'] = [
      {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
      {'id': 'member', 'email': 'member@example.com', 'role': 'member'},
    ];
    server.state['projects'] = [
      projectFixture('lead', 'api', 'lead'),
      projectFixture('web', 'web', 'web-channel'),
    ];
    (server.state['conversations'] as List).add({
      ...conversationFixture('web-channel', 'web'),
      'projectId': 'web',
      'leadId': 'juno',
    });
    server.state['agents'] = [
      agent('kai', 'Kai'),
      agent('pip', 'Pip'),
      agent('juno', 'Juno'),
      agent('rex', 'Rex', person: 'member'),
    ];
    for (final id in ['kai', 'pip', 'juno']) {
      (server.state['conversations'] as List).add({
        ...conversationFixture('chat-$id', id),
        'kind': 'agent-chat',
        'agentIds': [id],
      });
    }
    if (pm != null) {
      ((server.state['conversations'] as List)[0] as Map)['leadId'] = pm;
    }
    return server;
  }

  Future<SuperTabController> mount(
    WidgetTester tester,
    ConversationServer server, {
    String account = 'owner',
  }) async {
    await tester.binding.setSurfaceSize(const Size(1400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final c = server.controller(account: account);
    await c.refresh();
    addTearDown(c.dispose);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            onNewProject: () {},
            machineName: (_) => 'Mac Studio',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return c;
  }

  Future<void> settings(WidgetTester tester) async {
    await tester.tap(find.byTooltip('Project options'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(AppMenuItem, 'Project settings…'));
    await tester.pumpAndSettle();
  }

  Future<void> finish(WidgetTester tester) async {
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpWidget(const SizedBox());
  }

  final row = key('super-project-setting-Product Manager');

  testWidgets('its owner switches the PM to another of their agents in Project '
      'settings: the PM chat opens, and the one before stays an agent', (
    tester,
  ) async {
    final server = swarm();
    final c = await mount(tester, server);
    await settings(tester);
    expect(
      find.descendant(of: row, matching: find.text('Kai')),
      findsOneWidget,
    );
    await tester.tap(row);
    await tester.pumpAndSettle();
    expect(find.text('Choose PM'), findsWidgets);
    await captureWindow(tester, _shots, 'choose-pm');
    // Their own agents alone: the current one and another project's PM say why they cannot be chosen.
    expect(key('choose-pm-rex'), findsNothing);
    expect(
      find.descendant(of: key('choose-pm-kai'), matching: find.text('Current')),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: key('choose-pm-juno'),
        matching: find.text('PM of web'),
      ),
      findsOneWidget,
    );
    expect(tester.widget<ListTile>(key('choose-pm-juno')).enabled, isFalse);
    expect(
      tester.widget<FilledButton>(key('choose-pm-confirm')).onPressed,
      isNull,
    );

    await tester.tap(key('choose-pm-pip'));
    await tester.pump();
    await tester.tap(key('choose-pm-confirm'));
    await tester.pumpAndSettle();
    final sent = [for (final post in server.posts) post['command'] as Map]
        .where((command) => command['type'] == 'project.pm');
    expect(sent.single, {
      'type': 'project.pm',
      'projectId': 'lead',
      'agentId': 'pip',
    });
    // Nothing was started: no claim, no switch, no folder.
    expect(
      server.posts.where(
        (post) => [
          'lead.claim',
          'lead.switch',
          'lead.start',
        ].contains((post['command'] as Map)['type']),
      ),
      isEmpty,
    );
    expect(find.byType(AlertDialog), findsNothing);
    expect(c.selectedId, 'chat-pip');
    expect(c.snapshot!.leadOf('lead')!.id, 'pip');
    expect(c.snapshot!.agent('kai'), isNotNull);
    await finish(tester);
  });

  testWidgets('a project with no PM: its owner\'s empty channel says so and '
      'Choose PM picks one; a member sees no card and no setting', (
    tester,
  ) async {
    final server = swarm(pm: null);
    final c = await mount(tester, server);
    expect(find.text('This project has no Product Manager.'), findsOneWidget);
    await captureWindow(tester, _shots, 'no-pm-channel');
    await tester.tap(find.widgetWithText(FilledButton, 'Choose PM'));
    await tester.pumpAndSettle();
    await tester.tap(key('choose-pm-kai'));
    await tester.pump();
    await tester.tap(key('choose-pm-confirm'));
    await tester.pumpAndSettle();
    expect(server.projectPms, ['kai']);
    expect(c.selectedId, 'chat-kai');
    await finish(tester);

    await mount(tester, swarm(pm: null), account: 'member');
    expect(find.text('This project has no Product Manager.'), findsNothing);
    await settings(tester);
    expect(row, findsNothing);
    await finish(tester);
  });

  testWidgets('a refusal is said in the dialog and the PM stays', (
    tester,
  ) async {
    final server = swarm();
    final c = await mount(tester, server);
    await settings(tester);
    await tester.tap(row);
    await tester.pumpAndSettle();
    await tester.tap(key('choose-pm-pip'));
    await tester.pump();
    // Pip went to another person's computer meanwhile: the server refuses it as no agent of theirs.
    (server.state['agents'] as List).cast<Map>().firstWhere(
      (a) => a['id'] == 'pip',
    )['contributorId'] = 'member';
    await tester.tap(key('choose-pm-confirm'));
    await tester.pumpAndSettle();
    expect(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.text('Choose one of your own agents.'),
      ),
      findsOneWidget,
    );
    expect(find.byType(AlertDialog), findsOneWidget);
    expect(c.snapshot!.leadOf('lead')!.id, 'kai');
    await finish(tester);
  });
}
