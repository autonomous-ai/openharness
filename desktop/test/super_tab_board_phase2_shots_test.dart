// Task #3820 (Phase 2 of the Board): pictures for the PR, light and dark — the switched Board with its Needs you bar,
// cards' decisions, questions and pauses, + New proposal and the Buddies list; a card's chat with its question,
// priority and Pause; Project settings › People with Can chat. Writes nothing unless HARNESS_SUPER_TAB_CAPTURE names
// a folder.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

Finder _key(String k) => find.byKey(ValueKey(k));

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 4; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Map<String, dynamic> _card(
  String id,
  String title, {
  int? number,
  String? lane,
  String priority = 'P2',
  Map<String, dynamic>? proposal,
  Map<String, dynamic>? paused,
  Map<String, dynamic>? assignment,
}) => {
  ...conversationFixture(id, title),
  'projectId': 'lead',
  'agentIds': <String>[],
  'priority': priority,
  'number': ?number,
  'handOutLane': ?lane,
  'proposal': ?proposal,
  'paused': ?paused,
  'assignment': ?assignment,
};

Map<String, dynamic> _proposal(
  String sender, {
  Map<String, dynamic>? decision,
  String? askedOf,
}) => {
  'version': 1,
  'text': 'proposal',
  'createdAt': DateTime.now()
      .subtract(const Duration(hours: 3))
      .millisecondsSinceEpoch,
  'senders': [
    {'personId': sender, 'generation': 'g1'},
  ],
  'decision': ?decision,
  'questions': [
    if (askedOf != null)
      {
        'id': 'q1',
        'personId': askedOf,
        'question': 'Pin per person or for everyone?',
        'defaultAnswer': 'For everyone',
        'deadline': DateTime.now()
            .add(const Duration(hours: 2))
            .millisecondsSinceEpoch,
        'requiresConsent': false,
      },
  ],
};

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('Board Phase 2 in ${brightness.name}', (tester) async {
      if (shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(3200, 1800);
      addTearDown(tester.view.reset);

      final server = swarm();
      server.state['swarmBuddy'] = true;
      server.state['buddyCap'] = 5;
      (server.state['people'] as List).addAll([
        {'id': 'tuan', 'email': 'tuan@example.com', 'role': 'collaborator'},
        {'id': 'dee', 'email': 'dee@example.com', 'role': 'collaborator'},
      ]);
      (server.state['projects'] as List).first as Map
        ..['members'] = [
          {'id': 'owner'},
          {'id': 'tuan'},
          {'id': 'dee'},
        ]
        ..['boardMode'] = true
        ..['decider'] = 'dee'
        ..['canChat'] = ['dee'];
      (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
        _card(
          'pin',
          'Let people pin a card',
          lane: 'Desktop',
          proposal: _proposal('tuan', askedOf: 'owner'),
        ),
        _card(
          'dark',
          'Dark mode for the release page',
          lane: 'web',
          proposal: _proposal(
            'dee',
            decision: {
              'kind': 'later',
              'reason': 'After the website move',
              'at': 1,
              'by': 'lead',
              'revisitAt': DateTime(2026, 12, 4).millisecondsSinceEpoch,
            },
          ),
        ),
        _card(
          'cards',
          'Cards show who proposed them',
          number: 3830,
          lane: 'Desktop',
          priority: 'P1',
          proposal: _proposal(
            'tuan',
            decision: {
              'kind': 'accept',
              'reason': 'Small and clear',
              'at': 1,
              'by': 'lead',
            },
          ),
        ),
        _card(
          'held',
          'Phone Board tabs',
          number: 3821,
          lane: 'mobile',
          paused: {'by': 'dee', 'at': 1, 'reason': 'Waiting for 1.3.84'},
          assignment: {'id': 'a2', 'agentId': 'kestrel', 'status': 'working'},
        ),
        {
          ...conversationFixture('b-plan', 'Planning'),
          'kind': 'swarm-buddy',
          'buddyOwnerId': 'owner',
          'buddyName': 'Planning',
          'buddyDefault': true,
          'agentIds': <String>[],
        }..remove('projectId'),
        {
          ...conversationFixture('b-code', 'Code'),
          'kind': 'swarm-buddy',
          'buddyOwnerId': 'owner',
          'buddyName': 'Code',
          'agentIds': <String>[],
        }..remove('projectId'),
      ]);
      final c = server.controller(
        account: 'owner',
        initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
      );
      await tester.runAsync(c.refresh);
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: true),
            child: child!,
          ),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
            ),
          ),
        ),
      );
      await _settle(tester);
      // A project's Board opens from the Projects grid (task #4466).
      await tester.tap(find.byKey(const ValueKey('super-projects')));
      await tester.pump();
      await tester.tap(_key('super-group-lead'));
      await _settle(tester);
      expect(tester.takeException(), isNull);
      await captureWindow(tester, shots, 'board-phase2-${brightness.name}');

      // A card's chat: its question, its priority and Pause.
      await tester.tap(_key('super-board-needs-you-pin'));
      await _settle(tester);
      expect(tester.takeException(), isNull);
      await captureWindow(
        tester,
        shots,
        'board-phase2-card-${brightness.name}',
      );

      // + New proposal.
      await tester.tap(_key('super-board-new-proposal'));
      await _settle(tester);
      await captureWindow(
        tester,
        shots,
        'board-phase2-propose-${brightness.name}',
      );
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await _settle(tester);

      // Project settings › People.
      await tester.tap(_key('super-board-tab-chat'));
      await _settle(tester);
      await tester.tap(find.byTooltip('Project options'));
      await _settle(tester);
      await tester.tap(find.widgetWithText(AppMenuItem, 'Project settings…'));
      await _settle(tester);
      await tester.tap(_key('super-project-setting-People'));
      await _settle(tester);
      expect(tester.takeException(), isNull);
      await captureWindow(
        tester,
        shots,
        'board-phase2-people-${brightness.name}',
      );

      await tester.pumpWidget(const SizedBox());
      c.dispose();
      await tester.pump(const Duration(seconds: 5));
    });
  }
}
