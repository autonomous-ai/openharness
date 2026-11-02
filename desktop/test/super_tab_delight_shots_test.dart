import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/profile_sheet.dart';
import 'package:harness/super_tabs/ship_row.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the avatars-and-delight PR's screenshots there:
/// the real views over the in-memory Swarm, never a backend or the live app.
final shots = Platform.environment['SUPER_TAB_DELIGHT_SHOTS'];

String ago(Duration d) => DateTime.now().toUtc().subtract(d).toIso8601String();

ConversationServer office() {
  final server = ConversationServer();
  server.state['projects'] = [projectFixture('lead', 'openharness', 'lead')];
  server.state['people'] = [
    {
      'id': 'owner',
      'email': 'dee@example.com',
      'role': 'owner',
      'avatar': {'kind': 'preset', 'key': 'fox'},
      'status': {'text': 'Focusing', 'emoji': '🎯'},
    },
    {
      'id': 'ivy',
      'email': 'ivy@example.com',
      'role': 'collaborator',
      'avatar': {'kind': 'preset', 'key': 'cactus'},
      'status': {'text': 'Coffee break', 'emoji': '☕'},
    },
    {'id': 'sam', 'email': 'sam@example.com', 'role': 'collaborator'},
  ];
  server.state['agents'] = [
    for (final (id, name, engine) in [
      ('river', 'River', 'claude'),
      ('kai', 'Kai', 'claude'),
      ('ellis', 'Ellis', 'codex'),
      ('theo', 'Theo', 'codex'),
    ])
      {
        'id': id,
        'projectId': 'lead',
        'name': name,
        'displayName': name,
        'machineId': 'm',
        'harnessId': id,
        'contributorId': 'owner',
        'configuration': {'engine': engine},
      },
  ];
  (server.state['conversations'] as List)[0]['leadId'] = 'river';
  void say(
    String text,
    Map<String, dynamic> author, {
    List<Map<String, dynamic>>? reactions,
    Duration at = const Duration(minutes: 9),
  }) {
    server.append(text);
    server.messages.last
      ..['author'] = author
      ..['createdAt'] = ago(at)
      ..['reactions'] = reactions ?? const [];
  }

  final river = {
    'kind': 'agent',
    'id': 'river',
    'name': 'River',
    'displayName': 'River',
  };
  say(
    'Morning! Avatars and the ship moment are ready for a look.',
    river,
    at: const Duration(minutes: 12),
  );
  say(
    'Love the generated faces 😍',
    {'kind': 'person', 'id': 'ivy', 'name': 'ivy@example.com'},
    reactions: [
      {
        'emoji': 'heart',
        'count': 2,
        'by': [
          {'kind': 'person', 'id': 'owner'},
          {'kind': 'agent', 'id': 'kai'},
        ],
      },
      {
        'emoji': 'laugh',
        'count': 1,
        'by': [
          {'kind': 'person', 'id': 'sam'},
        ],
      },
    ],
  );
  say(
    'Merging now.',
    {'kind': 'person', 'id': 'owner', 'name': 'dee@example.com'},
    at: const Duration(minutes: 2),
    reactions: [
      {
        'emoji': 'rocket',
        'count': 3,
        'by': [
          {'kind': 'person', 'id': 'ivy'},
          {'kind': 'agent', 'id': 'river'},
          {'kind': 'agent', 'id': 'theo'},
        ],
      },
    ],
  );
  server.append('🎉 Shipped: Avatars and moments of delight');
  server.messages.last
    ..['author'] = river
    ..['createdAt'] = ago(const Duration(seconds: 5))
    ..['source'] = {
      'kind': 'ship',
      'conversationId': 'group-261',
      'title': 'Avatars and moments of delight',
      'pullRequests': [
        'https://github.com/autonomous-ai/openharness/pull/1760',
      ],
      'requesterId': 'owner',
      'builderIds': ['kai'],
      'reviewerIds': ['ellis'],
    };
  return server;
}

/// The conversation over [office], as both captures draw it.
Widget delightApp(
  SuperTabController c, {
  Brightness brightness = Brightness.dark,
  bool reduceMotion = false,
  Key? boundary,
}) => RepaintBoundary(
  key: boundary,
  child: MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: grid.buildAppTheme(brightness: brightness),
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context).copyWith(disableAnimations: reduceMotion),
      child: child!,
    ),
    home: Scaffold(
      body: SuperTabView(
        controller: c,
        onInvite: () {},
        onAddAgent: (_) {},
        onOpenTerminal: (_) {},
        machineName: (_) => 'MacBookPro2021',
      ),
    ),
  ),
);

Future<void> showOffice(
  WidgetTester tester, {
  Brightness brightness = Brightness.dark,
  bool reduceMotion = false,
}) async {
  await tester.binding.setSurfaceSize(const Size(1280, 860));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  // The app sets the design tokens' brightness from its theme at startup.
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = Brightness.dark);
  final c = office().controller();
  addTearDown(c.dispose);
  await c.refresh();
  await tester.pumpWidget(
    delightApp(c, brightness: brightness, reduceMotion: reduceMotion),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 650));
}

void main() {
  setUpAll(() => loadCaptureFonts(shots));
  setUp(SuperTabShipRow.resetPlayed);

  testWidgets('screenshots for review', (tester) async {
    await showOffice(tester);
    await captureWindow(tester, shots, 'office-dark-confetti');
    await tester.pumpAndSettle();
    await captureWindow(tester, shots, 'office-dark');
    SuperTabShipRow.resetPlayed();
    await showOffice(tester, brightness: Brightness.light, reduceMotion: true);
    await tester.pumpAndSettle();
    await captureWindow(tester, shots, 'office-light-reduced-motion');
    final context = tester.element(find.byType(SuperTabView));
    final view = tester.widget<SuperTabView>(find.byType(SuperTabView));
    showSuperTabProfile(context, view.controller);
    await tester.pumpAndSettle();
    await captureWindow(tester, shots, 'profile-sheet');
    await tester.tap(find.text('Close'));
    await tester.pumpAndSettle();
    showSuperTabProfile(context, view.controller, agentId: 'kai');
    await tester.pumpAndSettle();
    await captureWindow(tester, shots, 'agent-avatar-sheet');
  }, skip: shots == null);
}
