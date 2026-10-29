import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/live_card.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/pull_request_facts.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_live_card_test.dart' show cardServer, found, other, pr;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the live-card PR's screenshots there: the real
/// chat rows over the in-memory Swarm and a fake GitHub, never a backend.
final shots = Platform.environment['SUPER_TAB_CARD_SHOTS'];

/// The workgroup with a second, merged pull request on a card of its own.
ConversationServer server() {
  final server = cardServer();
  final work = (server.state['conversations'] as List)
      .cast<Map<String, dynamic>>()
      .firstWhere((g) => g['id'] == 'work');
  server.append('Phone follow-up: $other', conversationId: 'work');
  // Its Lead wrote the brief, as the Swarm writes a brief in the Lead's name.
  (server.state['agents'] as List).add({
    'id': 'river',
    'name': 'River',
    'machineId': 'm',
    'harnessId': 'river',
    'contributorId': 'owner',
    'configuration': {'engine': 'claude'},
  });
  work['leadId'] = 'river';
  work['agentIds'] = ['river', ...work['agentIds'] as List];
  server.messages.first['author'] = {
    'kind': 'agent',
    'id': 'river',
    'name': 'River',
  };
  final kai = {'kind': 'agent', 'id': 'kai', 'name': 'Kai'};
  for (final m in server.messages) {
    if (const {'message-2', 'message-4', 'message-5'}.contains(m['id'])) {
      m['author'] = kai;
    }
  }
  work['pullRequestUrls'] = [pr, other];
  (work['cards'] as Map)['pullRequests'] = [
    {'url': pr, 'messageId': 'message-2'},
    {'url': other, 'messageId': 'message-5', 'mergedAt': 5},
  ];
  return server;
}

SuperTabPullRequestFacts github() => SuperTabPullRequestFacts(
  (_) async => {
    'rows': [
      found(pr, passed: 8, pending: 4),
      {...found(other, state: 'Merged'), 'title': 'Avatars on the phone'},
    ],
  },
);

Future<void> theme(WidgetTester tester, Brightness brightness) async {
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = Brightness.dark);
}

/// The chat's rows as the conversation draws them, each card under its
/// message.
Future<void> showRows(WidgetTester tester, Brightness brightness) async {
  await tester.binding.setSurfaceSize(const Size(900, 760));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await theme(tester, brightness);
  final c = server().controller();
  addTearDown(c.dispose);
  await c.refresh();
  await c.loadMessages('work');
  final facts = github();
  addTearDown(facts.dispose);
  final group = c.snapshot!.conversation('work')!;
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: ListView(
          children: [
            for (final message in c.messages('work'))
              SuperTabMessageRow(
                message: message,
                author: message.fromAgent
                    ? c.snapshot!.agentName(message.authorId)
                    : 'River',
                onReturnToComposer: () {},
                receipts: const [],
                card: switch (group.cards.of(message.id)) {
                  final card? => SuperTabLiveCard(
                    group: group,
                    card: card,
                    controller: c,
                    facts: facts,
                  ),
                  null => null,
                },
              ),
          ],
        ),
      ),
    ),
  );
  await tester.pump();
  // The app animates a change of theme; the picture is of where it lands.
  await tester.pump(const Duration(milliseconds: 400));
}

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  testWidgets('screenshots for review', (tester) async {
    for (final brightness in Brightness.values) {
      await showRows(tester, brightness);
      await captureWindow(tester, shots, 'cards-${brightness.name}');
    }
    // The whole conversation on a computer with no GitHub sign-in: the cards
    // keep what the Swarm knows and leave CI out.
    await tester.binding.setSurfaceSize(const Size(1280, 860));
    await theme(tester, Brightness.dark);
    final c = server().controller();
    addTearDown(c.dispose);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: Brightness.dark),
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
    await c.select('work');
    await tester.pumpAndSettle();
    await captureWindow(tester, shots, 'conversation-no-github-dark');
    await tester.pump(const Duration(milliseconds: 250));
  }, skip: shots == null);
}
