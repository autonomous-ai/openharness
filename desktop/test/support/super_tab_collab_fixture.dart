import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_fixture.dart';

Map<String, dynamic> agent(String id, String name) => {
  'id': id,
  'projectId': 'web',
  'name': name,
  'machineId': 'm',
  'harnessId': id,
  'contributorId': 'owner',
  'configuration': {'engine': 'claude'},
};

/// A Swarm of three people with one public project, 'web', whose Lead 'pm'
/// and Builder 'atlas' work in the group 'work'.
ConversationServer swarm() {
  final server = ConversationServer();
  server.state['leadsConversationId'] = 'lead';
  server.state['projects'] = [projectFixture('web', 'Web', 'web-lead')];
  server.state['people'] = [
    {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
    {'id': 'dee', 'email': 'dee@example.com', 'role': 'collaborator'},
    {'id': 'kai', 'email': 'kai@example.com', 'role': 'viewer'},
  ];
  server.state['agents'] = <dynamic>[
    agent('pm', 'River'),
    agent('atlas', 'Atlas'),
  ];
  server.state['conversations'] = [
    {...conversationFixture('lead', 'Lead'), 'kind': 'leads'},
    {
      ...conversationFixture('web-lead', 'Web'),
      'projectId': 'web',
      'leadId': 'pm',
      'agentIds': ['pm'],
    },
    {
      ...conversationFixture('work', 'Sidebar glance'),
      'projectId': 'web',
      'number': 3,
      'agentIds': ['pm', 'atlas'],
    },
  ];
  return server;
}

/// The view over [swarm] as [account], in the group 'work'.
Future<(ConversationServer, SuperTabController)> showSwarm(
  WidgetTester tester, {
  String account = 'owner',
}) async {
  // The picker takes a third of the window's height: room for four rows.
  tester.view
    ..physicalSize = const Size(1200, 900)
    ..devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final server = swarm();
  final c = server.controller(account: account);
  addTearDown(c.dispose);
  await c.refresh();
  c.select('work');
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: SuperTabView(
          controller: c,
          onInvite: () {},
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          machineName: (_) => 'Team Mac',
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return (server, c);
}
