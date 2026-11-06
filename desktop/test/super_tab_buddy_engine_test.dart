import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/super_tabs/buddy_engine.dart';

import 'support/buddy_engine_fixture.dart';
import 'support/super_tab_fixture.dart';

ConversationServer namedBuddySwarm({
  String firstEngine = 'claude',
  bool secondLimited = false,
}) {
  final server = buddyEngineSwarm(engine: firstEngine);
  server.state['buddyCap'] = 5;
  final first = (server.state['agents'] as List).cast<Map>().firstWhere(
    (a) => a['id'] == 'wren',
  );
  server.state['agents'] = <dynamic>[
    ...server.state['agents'] as List,
    {
      ...first,
      'id': 'moss',
      'name': 'Moss',
      'harnessId': 'h-moss',
      'configuration': {'engine': 'claude', 'model': 'default'},
      if (secondLimited)
        'limitedUntil': DateTime.now()
            .add(const Duration(hours: 1))
            .toUtc()
            .toIso8601String(),
    },
  ];
  final firstChat = (server.state['conversations'] as List)
      .cast<Map>()
      .firstWhere((g) => g['id'] == 'swarm-buddy-peer');
  server.state['conversations'] = <dynamic>[
    ...server.state['conversations'] as List,
    {
      ...firstChat,
      'id': 'swarm-buddy-peer-moss',
      'title': 'Moss',
      'buddyName': 'Moss',
      'buddyDefault': true,
      'agentIds': ['moss'],
    },
  ];
  return server;
}

void main() {
  final picker = find.byKey(const ValueKey('super-buddy-engine'));
  final model = find.byKey(const ValueKey('super-buddy-model'));
  Finder row(String name) => find.widgetWithText(AppMenuItem, name);
  List<Map> commands(ConversationServer server) => [
    for (final post in server.posts)
      if ((post['command'] as Map)['type'] == 'buddy.engine')
        post['command'] as Map,
  ];
  Future<void> open(WidgetTester tester) async {
    expect(picker, findsOneWidget);
    await tester.tap(picker);
    await tester.pumpAndSettle();
  }

  // Catches a wrong engine payload or a second command for the current engine.
  testWidgets('selecting Codex submits the engine and keeps the Buddy chat', (
    tester,
  ) async {
    final server = buddyEngineSwarm();
    final c = await showBuddyEngine(tester, server);
    await open(tester);
    expect(row('Claude Code'), findsOneWidget);
    expect(row('Codex'), findsOneWidget);
    expect(row('OpenCode'), findsNothing);
    await tester.tap(row('Claude Code'));
    await tester.pumpAndSettle();
    expect(commands(server), isEmpty);
    await open(tester);
    await tester.tap(row('Codex'));
    await tester.pumpAndSettle();
    expect(commands(server), [
      {'type': 'buddy.engine', 'engine': 'codex'},
    ]);
    expect(c.selectedId, 'swarm-buddy-peer');
    expect(c.buddy('')!.id, 'wren');
    await closeBuddyEngine(tester, c);
  });

  // A named Buddy must not inherit the person's first Buddy as its target.
  // Exercise the picker with the actual agent it was given: the second chat
  // is both selected and default, and both Buddies belong to the same owner.
  testWidgets('a named Buddy engine picker targets its own selected chat', (
    tester,
  ) async {
    final server = namedBuddySwarm();
    final c = server.controller(account: 'peer');
    await c.refresh();
    await c.select('swarm-buddy-peer-moss');
    addTearDown(c.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: BuddyEnginePicker(
              key: const ValueKey('super-buddy-engine'),
              controller: c,
              agent: c.snapshot!.agent('moss')!,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await open(tester);
    await tester.tap(row('Codex'));
    await tester.pumpAndSettle();
    expect(commands(server), [
      {
        'type': 'buddy.engine',
        'engine': 'codex',
        'conversationId': 'swarm-buddy-peer-moss',
      },
    ]);
    expect(c.selectedId, 'swarm-buddy-peer-moss');
    expect(c.snapshot!.conversation('swarm-buddy-peer')!.agentIds, ['wren']);
    expect(c.snapshot!.conversation('swarm-buddy-peer-moss')!.agentIds, [
      'moss',
    ]);
  });

  for (final limitAction in [false, true]) {
    testWidgets(
      'named Buddy full header targets its chat, limit=$limitAction',
      (tester) async {
        final server = namedBuddySwarm(
          firstEngine: limitAction ? 'claude' : 'codex',
          secondLimited: limitAction,
        );
        final c = await showBuddyEngine(tester, server);
        addTearDown(c.dispose);
        await c.select('swarm-buddy-peer-moss');
        await tester.pumpAndSettle();
        if (limitAction) {
          final notice = find.byKey(const ValueKey('super-buddy-engine-limit'));
          expect(notice, findsOneWidget);
          await tester.tap(
            find.descendant(of: notice, matching: find.text('Switch engine')),
          );
          await tester.pumpAndSettle();
        } else {
          expect(
            find.descendant(of: picker, matching: find.text('Claude Code')),
            findsOneWidget,
          );
          await open(tester);
        }
        await tester.tap(row('Codex'));
        await tester.pumpAndSettle();
        expect(commands(server), [
          {
            'type': 'buddy.engine',
            'engine': 'codex',
            'conversationId': 'swarm-buddy-peer-moss',
          },
        ]);
        expect(c.selectedId, 'swarm-buddy-peer-moss');
        expect(c.snapshot!.conversation('swarm-buddy-peer')!.agentIds, [
          'wren',
        ]);
        expect(c.snapshot!.conversation('swarm-buddy-peer-moss')!.agentIds, [
          'moss',
        ]);
      },
    );
  }

  // Catches interpreting unknown authentication, installation or old readings
  // as an offer. Values are independent of the production eligibility helper.
  for (final (label, signedIn, installed, ageMs) in [
    ('signed out', false, true, 0),
    ('unknown sign-in', null, true, 0),
    ('missing installation', true, false, 0),
    ('stale reading', true, true, 45001),
  ]) {
    testWidgets('$label never offers Codex', (tester) async {
      final c = await showBuddyEngine(
        tester,
        buddyEngineSwarm(
          codexSignIn: signedIn,
          installed: installed,
          ageMs: ageMs,
        ),
      );
      await open(tester);
      expect(row('Codex'), findsNothing);
      await closeBuddyEngine(tester, c);
    });
  }

  testWidgets('an older host has no engine action', (tester) async {
    final c = await showBuddyEngine(
      tester,
      buddyEngineSwarm(capable: false, limited: true),
    );
    expect(picker, findsNothing);
    expect(find.text('Switch engine'), findsNothing);
    await closeBuddyEngine(tester, c);
  });

  testWidgets('a Team session never offers its subscription to a Buddy', (
    tester,
  ) async {
    final c = await showBuddyEngine(
      tester,
      buddyEngineSwarm(sessionKind: 'team', limited: true),
    );
    expect(picker, findsNothing);
    expect(find.text('Switch engine'), findsNothing);
    await closeBuddyEngine(tester, c);
  });

  testWidgets('an engine handoff names its target and disables model changes', (
    tester,
  ) async {
    final server = buddyEngineSwarm(
      switchRequest: {
        'id': 'engine-request',
        'engine': 'codex',
        'profileId': 'default',
        'requestedBy': 'peer',
        'at': DateTime.now().toUtc().toIso8601String(),
      },
    );
    final c = await showBuddyEngine(tester, server);
    expect(find.text('Switching to Codex…'), findsOneWidget);
    await tester.tap(model);
    await tester.pumpAndSettle();
    expect(find.byType(AppMenuItem), findsNothing);
    expect(commands(server), isEmpty);
    await closeBuddyEngine(tester, c);
  });

  testWidgets('a model switch disables engine changes', (tester) async {
    final c = await showBuddyEngine(
      tester,
      buddyEngineSwarm(
        modelRequest: {'id': 'model-request', 'gridModel': null},
      ),
    );
    await open(tester);
    expect(find.byType(AppMenuItem), findsNothing);
    await closeBuddyEngine(tester, c);
  });

  testWidgets('a refused engine request shows the actionable server reason', (
    tester,
  ) async {
    final server = buddyEngineSwarm();
    server.refuse = {
      'code': 'BUDDY_ENGINE_UNAVAILABLE',
      'message': 'Sign in to Codex on your Buddy’s machine.',
    };
    final c = await showBuddyEngine(tester, server);
    await open(tester);
    await tester.tap(row('Codex'));
    await tester.pumpAndSettle();
    expect(
      find.text('Sign in to Codex on your Buddy’s machine.'),
      findsOneWidget,
    );
    await closeBuddyEngine(tester, c);
  });

  testWidgets('a Codex Buddy model menu names the Codex subscription', (
    tester,
  ) async {
    final c = await showBuddyEngine(tester, buddyEngineSwarm(engine: 'codex'));
    await tester.tap(model);
    await tester.pumpAndSettle();
    final subscription = row('Your subscription');
    expect(
      find.descendant(of: subscription, matching: find.text('Codex')),
      findsOneWidget,
    );
    expect(find.text('Claude Code'), findsNothing);
    expect(find.text('SHARED IN THIS SWARM'), findsNothing);
    await closeBuddyEngine(tester, c);
  });

  testWidgets('header selectors scale their text once at 200 percent', (
    tester,
  ) async {
    final label = find.descendant(
      of: picker,
      matching: find.text('Claude Code'),
    );
    final normal = await showBuddyEngine(tester, buddyEngineSwarm());
    final normalHeight = tester.getRect(label).height;
    await closeBuddyEngine(tester, normal);
    final large = await showBuddyEngine(
      tester,
      buddyEngineSwarm(),
      textScale: 2,
    );
    expect(tester.getRect(label).height, closeTo(normalHeight * 2, 1));
    await closeBuddyEngine(tester, large);
  });

  for (final narrow in [false, true]) {
    testWidgets(
      'subscription limit opens the same engine menu, narrow=$narrow',
      (tester) async {
        final server = buddyEngineSwarm(limited: true);
        final c = await showBuddyEngine(tester, server, narrow: narrow);
        final notice = find.byKey(const ValueKey('super-buddy-engine-limit'));
        expect(notice, findsOneWidget);
        expect(find.text('Limit reached.'), findsOneWidget);
        final action = find.descendant(
          of: notice,
          matching: find.text('Switch engine'),
        );
        expect(action, findsOneWidget);
        await tester.tap(action);
        await tester.pumpAndSettle();
        await tester.tap(row('Codex'));
        await tester.pumpAndSettle();
        expect(commands(server), [
          {'type': 'buddy.engine', 'engine': 'codex'},
        ]);
        expect(tester.takeException(), isNull);
        await closeBuddyEngine(tester, c);
      },
    );
  }
}
