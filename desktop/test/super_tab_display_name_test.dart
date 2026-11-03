import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/leaderboard/model.dart';
import 'package:harness/super_tabs/leaderboard/person_row.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

// A person sets the name the Swarm shows for them (backend personNames.ts):
// it shows wherever a person shows, and their username stays the tag.

Map<String, dynamic> _person(
  String id,
  String email, {
  String? username,
  String? name,
}) => {
  'id': id,
  'email': email,
  'role': 'collaborator',
  'username': ?username,
  'name': ?name,
};

SuperTabSnapshot _swarm(List<Map<String, dynamic>> people) =>
    SuperTabSnapshot.fromJson({
      'version': 1,
      'id': 'tab',
      'name': 'Pilot',
      'ownerId': people.first['id'],
      'people': people,
      'agents': const [],
      'conversations': const [],
      'invitations': const [],
    });

SuperTabMessage _from(String id, String email) => SuperTabMessage.fromJson({
  'id': 'm-$id',
  'conversationId': 'lead',
  'text': 'Morning',
  'sequence': 1,
  'author': {'kind': 'person', 'id': id, 'name': email},
});

void main() {
  group('the model', () {
    final swarm = _swarm([
      _person('relay', 'wkpnjjhbnm@privaterelay.appleid.com', name: 'Minh Nguyen'),
      _person('dee', 'dee@autonomous.ai'),
    ]);
    final minh = swarm.people.first, dee = swarm.people.last;

    test('shows the name a person set, else their username', () {
      expect(minh.name, 'Minh Nguyen');
      expect(minh.shownName, 'Minh Nguyen');
      expect(minh.username, 'wkpnjjhbnm');
      expect(dee.name, isNull);
      expect(dee.shownName, 'dee');
    });

    test('signs a person’s message with the name they set', () {
      expect(
        swarm.authorName(
          _from('relay', 'wkpnjjhbnm@privaterelay.appleid.com'),
        ),
        'Minh Nguyen',
      );
      expect(swarm.authorName(_from('dee', 'dee@autonomous.ai')), 'dee');
    });

    test('the leaderboard and the avatar name a person by it', () {
      final score = SuperTabPersonScore.fromJson({'personId': 'relay'});
      expect(leaderboardName(minh, score), 'Minh Nguyen');
      expect(leaderboardName(dee, null), 'dee');
      expect(SuperTabAvatar.person(minh).name, 'Minh Nguyen');
      expect(SuperTabAvatar.person(dee).name, 'dee');
    });
  });

  group('the Swarm screen', () {
    final composer = find.byKey(const ValueKey('super-message-composer'));
    final picker = find.byKey(const ValueKey('super-composer-completions'));

    ConversationServer server({bool named = true}) {
      final server = ConversationServer();
      server.state['people'] = [
        {'id': 'owner', 'email': 'river@autonomous.ai', 'role': 'owner'},
        {
          'id': 'relay',
          'email': 'wkpnjjhbnm@privaterelay.appleid.com',
          'role': 'collaborator',
          'username': 'wkpnjjhbnm',
          if (named) 'name': 'Minh Nguyen',
        },
        {'id': 'dee', 'email': 'dee@autonomous.ai', 'role': 'collaborator'},
      ];
      server.append('@wkpnjjhbnm can you check the sign-in screen?');
      server.messages.last['mentions'] = ['relay'];
      server.append('On it.');
      server.messages.last['author'] = {
        'kind': 'person',
        'id': 'relay',
        'name': 'wkpnjjhbnm@privaterelay.appleid.com',
      };
      return server;
    }

    Future<SuperTabController> show(
      WidgetTester tester,
      ConversationServer server,
    ) async {
      final c = server.controller();
      await c.refresh();
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
      addTearDown(c.dispose);
      return c;
    }

    List<(String, String?)> choices(WidgetTester tester) => [
      for (final tile in tester.widgetList<ListTile>(
        find.descendant(of: picker, matching: find.byType(ListTile)),
      ))
        (
          (tile.title as Text).data!,
          switch (tile.subtitle) {
            final Text text => text.data,
            _ => null,
          },
        ),
    ];

    testWidgets('People, the chat author and a tag show the name', (
      tester,
    ) async {
      await show(tester, server());
      // The People row and the message's author line.
      expect(find.text('Minh Nguyen'), findsWidgets);
      expect(find.text('wkpnjjhbnm'), findsNothing);
      // The tag reads as their name, though the text still says the username.
      expect(
        find.textContaining('@Minh Nguyen', findRichText: true),
        findsOneWidget,
      );
      expect(
        find.textContaining('@wkpnjjhbnm', findRichText: true),
        findsNothing,
      );
    });

    testWidgets('with no name set, each reads as today', (tester) async {
      await show(tester, server(named: false));
      expect(find.text('wkpnjjhbnm'), findsWidgets);
      expect(
        find.textContaining('@wkpnjjhbnm', findRichText: true),
        findsOneWidget,
      );
      expect(find.textContaining('Minh'), findsNothing);
    });

    testWidgets('@ offers a person by name, matched by name or username, '
        'and tags their username', (tester) async {
      final s = server();
      final c = await show(tester, s);
      await tester.tap(composer);
      await tester.enterText(composer, 'Thanks @minh');
      await tester.pumpAndSettle();
      expect(choices(tester), [('Minh Nguyen', '@wkpnjjhbnm')]);
      await tester.enterText(composer, 'Thanks @wkp');
      await tester.pumpAndSettle();
      expect(choices(tester), [('Minh Nguyen', '@wkpnjjhbnm')]);
      // Someone with no name reads as today.
      await tester.enterText(composer, 'Thanks @de');
      await tester.pumpAndSettle();
      expect(choices(tester), [('dee', null)]);
      await tester.enterText(composer, 'Thanks @minh');
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(composer).controller!.text,
        'Thanks @wkpnjjhbnm ',
      );
      expect(c.mentions(c.selectedId), {'relay': '@wkpnjjhbnm'});
      await tester.pump(const Duration(seconds: 1));
    });
  });
}
