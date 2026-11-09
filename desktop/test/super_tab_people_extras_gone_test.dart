import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_roster_test.dart' show RosterFixture;
import 'support/super_tab_fixture.dart';
import 'support/swarm_v4_data.dart';

/// The Swarm's people-chat extras are gone (anh Dee, 2026-11-09): the profile
/// sheet, the name, username and status editors, and the identity card over a
/// chat name. A person clicks through what is left, and none of it opens one,
/// offers one or sends what they sent.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  Future<(SuperTabController, ConversationServer)> channel(
    WidgetTester tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1440, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = swarmV4Server();
    final c = server.controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
    );
    addTearDown(c.dispose);
    await tester.runAsync(c.refresh);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
            github: swarmV4GitHub(),
            board: true,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return (c, server);
  }

  Iterable<String> commandTypes(ConversationServer server) => [
    for (final post in server.posts) (post['command'] as Map)['type'] as String,
  ];

  testWidgets('hovering an agent\'s name or its face in the channel opens no '
      'card, and leaves its tooltip', (tester) async {
    await channel(tester);
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    addTearDown(mouse.removePointer);
    final name = find.text('fourteen').first;
    expect(name, findsOneWidget);
    await mouse.moveTo(tester.getCenter(name));
    // Longer than the card ever waited (half a second) and than the card
    // took to close.
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
    expect(key('super-identity-card'), findsNothing);
    expect(key('super-identity-card-name'), findsNothing);
    // Its face is the agent's, and its hover still says what the agent runs.
    final face = find
        .ancestor(of: key('super-agent-face'), matching: find.byType(Tooltip))
        .first;
    await mouse.moveTo(tester.getCenter(face));
    await tester.pump(const Duration(seconds: 2));
    expect(find.textContaining('Claude'), findsWidgets);
    expect(key('super-identity-card'), findsNothing);
  });

  testWidgets('Tab through the channel reaches no identity card, and Escape '
      'has nothing to close', (tester) async {
    await channel(tester);
    for (var i = 0; i < 12; i++) {
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump(const Duration(milliseconds: 600));
      expect(key('super-identity-card'), findsNothing);
    }
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byType(SuperTabView), findsOneWidget);
  });

  testWidgets('loading a Swarm tells it no time zone, and sets no status or '
      'name', (tester) async {
    final (c, server) = await channel(tester);
    await tester.runAsync(c.refresh);
    await tester.pump(const Duration(seconds: 1));
    expect(
      commandTypes(server).where((type) => type.startsWith('member.')),
      isEmpty,
    );
    expect(commandTypes(server), isNot(contains('agent.avatar')));
  });

  group('the Members roster', () {
    testWidgets('one\'s own card offers Manage people and no Edit profile', (
      tester,
    ) async {
      final f = RosterFixture();
      addTearDown(f.dispose);
      await f.initialize();
      await f.show(tester);
      await tester.tap(key('super-person-owner'));
      await tester.pumpAndSettle();
      expect(find.text('Manage people'), findsOneWidget);
      expect(find.text('Edit profile'), findsNothing);
      expect(key('super-profile-edit'), findsNothing);
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      await f.close(tester);
    });

    testWidgets('an agent\'s details, its contributor looking, have no Change '
        'avatar', (tester) async {
      final f = RosterFixture();
      addTearDown(f.dispose);
      await f.initialize();
      await f.show(tester);
      await tester.tap(f.row(1));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Details…'));
      await tester.pumpAndSettle();
      expect(find.text('Engine'), findsOneWidget);
      expect(find.text('Change avatar'), findsNothing);
      expect(find.text('Open terminal'), findsOneWidget);
      await f.close(tester);
    });
  });
}
