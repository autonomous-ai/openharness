import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/project_add_people.dart';

import 'support/super_tab_fixture.dart';

/// The Add people picker's lists (Diego, 2026-11-04): who can be added to a
/// private project, and who is already in.
SuperTabPerson _person(String id, {String? name}) => SuperTabPerson.fromJson({
  'id': id,
  'email': '$id@example.com',
  'role': 'collaborator',
  'name': ?name,
});

SuperTabProject _project(
  List<String> members, {
  Map<String, String> generations = const {},
}) => SuperTabProject.fromJson({
  'id': 'lead',
  'name': 'test private',
  'ownerId': 'owner',
  'leadConversationId': 'lead',
  'visibility': 'private',
  'members': [
    for (final id in members) {'id': id, 'generation': ?generations[id]},
  ],
});

void main() {
  group('projectPeopleLists', () {
    final people = [
      _person('owner'),
      _person('dee'),
      _person('tony'),
      _person('zed', name: 'Ana'),
    ];

    test('splits the Swarm into who can be added and who is in', () {
      final lists = projectPeopleLists(people, _project(['dee']), '');
      expect(lists.addable.map((p) => p.id), ['zed', 'tony']);
      expect(lists.inProject.map((p) => p.id), ['owner', 'dee']);
    });

    test('search ignores case and surrounding spaces', () {
      final lists = projectPeopleLists(people, _project(['dee']), '  TON ');
      expect(lists.addable.map((p) => p.id), ['tony']);
      expect(lists.inProject, isEmpty);
      final byEmail = projectPeopleLists(
        people,
        _project(['dee']),
        'example.com',
      );
      expect(byEmail.addable, hasLength(2));
    });

    test(
      'a member who left and rejoined is not in; a missing side is same',
      () {
        final rejoined = [
          _person('owner'),
          SuperTabPerson.fromJson({
            'id': 'dee',
            'email': 'dee@example.com',
            'role': 'collaborator',
            'generation': 'g2',
          }),
          SuperTabPerson.fromJson({
            'id': 'tony',
            'email': 'tony@example.com',
            'role': 'collaborator',
          }),
        ];
        final lists = projectPeopleLists(
          rejoined,
          _project(['dee', 'tony'], generations: {'dee': 'g1', 'tony': 'g1'}),
          '',
        );
        expect(lists.addable.map((p) => p.id), ['dee']);
        expect(lists.inProject.map((p) => p.id), ['owner', 'tony']);
      },
    );

    test('no one to add', () {
      final lists = projectPeopleLists(
        people,
        _project(['dee', 'tony', 'zed']),
        '',
      );
      expect(lists.addable, isEmpty);
    });
  });

  group('showProjectAddPeople', () {
    Map<String, dynamic> row(String id) => {
      'id': id,
      'email': '$id@example.com',
      'role': 'collaborator',
    };

    Future<(ConversationServer, SuperTabController)> open(
      WidgetTester tester, {
      List<String> members = const ['dee'],
      List<String> people = const ['dee', 'tony'],
      Map<String, Object?> project = const {},
    }) async {
      final server = ConversationServer();
      (server.state['people'] as List).addAll([
        for (final id in people) row(id),
      ]);
      server.state['projects'] = [
        {
          ...projectFixture('lead', 'test private', 'lead'),
          'visibility': 'private',
          'members': [
            for (final id in members) {'id': id},
          ],
          ...project,
        },
      ];
      final c = server.controller(account: 'owner');
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () => showProjectAddPeople(
                context,
                c,
                c.snapshot!.projectById('lead')!,
              ),
              child: const Text('open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      addTearDown(c.dispose);
      return (server, c);
    }

    final confirm = find.byKey(const ValueKey('project-add-confirm'));
    Finder tick(String id) => find.byKey(ValueKey('project-add-person-$id'));
    List<String> members(ConversationServer s) => [
      for (final m in (s.state['projects'] as List).first['members'] as List)
        (m as Map)['id'] as String,
    ];

    testWidgets('lists who can be added and who is in', (tester) async {
      await open(tester);
      expect(find.text('Add people to test private'), findsOneWidget);
      expect(tick('tony'), findsOneWidget);
      expect(tick('dee'), findsNothing);
      expect(find.text('Project owner'), findsOneWidget);
      expect(tester.widget<FilledButton>(confirm).onPressed, isNull);
    });

    testWidgets('ticking tony and Add sends project.sharing and closes', (
      tester,
    ) async {
      final (server, c) = await open(tester);
      await tester.tap(tick('tony'));
      await tester.pumpAndSettle();
      expect(find.text('Add 1 person'), findsOneWidget);
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(members(server), ['dee', 'tony']);
      expect((server.state['projects'] as List).first['visibility'], 'private');
      expect(find.text('Add people to test private'), findsNothing);
    });

    testWidgets('keeps a member added since the dialog opened', (tester) async {
      final (server, c) = await open(tester);
      (server.state['people'] as List).add(row('ana'));
      (server.state['projects'] as List).first['members'] = [
        {'id': 'dee'},
        {'id': 'ana'},
      ];
      await c.refresh();
      await tester.pumpAndSettle();
      await tester.tap(tick('tony'));
      await tester.pumpAndSettle();
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(members(server).toSet(), {'dee', 'ana', 'tony'});
    });

    testWidgets('drops a ticked person who left the Swarm', (tester) async {
      final (server, c) = await open(tester, people: ['dee', 'tony', 'ana']);
      await tester.tap(tick('tony'));
      await tester.tap(tick('ana'));
      await tester.pumpAndSettle();
      (server.state['people'] as List).removeWhere((p) => p['id'] == 'tony');
      await c.refresh();
      await tester.pumpAndSettle();
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(members(server).toSet(), {'dee', 'ana'});
    });

    testWidgets('a member no longer in the Swarm is not sent', (tester) async {
      final (server, c) = await open(tester, members: ['dee', 'gone']);
      await tester.tap(tick('tony'));
      await tester.pumpAndSettle();
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(members(server).toSet(), {'dee', 'tony'});
    });

    testWidgets('a member with a stale generation is added only when ticked', (
      tester,
    ) async {
      final (server, c) = await open(
        tester,
        members: ['dee', 'ana'],
        people: ['dee', 'tony', 'ana'],
      );
      (server.state['projects'] as List).first['members'] = [
        {'id': 'dee', 'generation': 'old'},
        {'id': 'ana', 'generation': 'old'},
      ];
      (server.state['people'] as List).firstWhere(
        (p) => p['id'] == 'dee',
      )['generation'] = 'new';
      (server.state['people'] as List).firstWhere(
        (p) => p['id'] == 'ana',
      )['generation'] = 'new';
      await c.refresh();
      await tester.pumpAndSettle();
      expect(tick('dee'), findsOneWidget);
      await tester.tap(tick('tony'));
      await tester.pumpAndSettle();
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(members(server), ['tony']);
    });

    testWidgets('Add waits on a pending action and offers to check it', (
      tester,
    ) async {
      final (server, c) = await open(tester);
      await tester.tap(tick('tony'));
      await tester.pumpAndSettle();
      server.loseReply = true;
      await c.command({
        'type': 'project.rename',
        'projectId': 'lead',
        'name': 'x',
      });
      await tester.pumpAndSettle();
      expect(c.hasPendingAction, isTrue);
      expect(tester.widget<FilledButton>(confirm).onPressed, isNull);
      await tester.tap(find.widgetWithText(TextButton, 'Check pending action'));
      await tester.pumpAndSettle();
      expect(c.hasPendingAction, isFalse);
      expect(tester.widget<FilledButton>(confirm).onPressed, isNotNull);
    });

    testWidgets('Add stops when the project turned public', (tester) async {
      final (server, c) = await open(tester);
      await tester.tap(tick('tony'));
      await tester.pumpAndSettle();
      (server.state['projects'] as List).first['visibility'] = 'public';
      await c.refresh();
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(confirm).onPressed, isNull);
    });

    testWidgets(
      'Add stops when the project is gone or no longer the reader\'s',
      (tester) async {
        final (server, c) = await open(tester);
        await tester.tap(tick('tony'));
        await tester.pumpAndSettle();
        (server.state['projects'] as List).first['ownerId'] = 'dee';
        await c.refresh();
        await tester.pumpAndSettle();
        expect(tester.widget<FilledButton>(confirm).onPressed, isNull);
      },
    );

    testWidgets('the owner is never sent as a member', (tester) async {
      final (server, c) = await open(tester, members: ['dee', 'owner']);
      await tester.tap(tick('tony'));
      await tester.pumpAndSettle();
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(members(server).toSet(), {'dee', 'tony'});
    });

    testWidgets('the count is of ticked people who can still be added', (
      tester,
    ) async {
      final (server, c) = await open(tester, people: ['dee', 'tony', 'ana']);
      await tester.tap(tick('tony'));
      await tester.tap(tick('ana'));
      await tester.pumpAndSettle();
      (server.state['projects'] as List).first['members'] = [
        {'id': 'dee'},
        {'id': 'tony'},
      ];
      await c.refresh();
      await tester.pumpAndSettle();
      expect(find.text('Add 1 person'), findsOneWidget);
    });

    testWidgets('a refused Add stays open with its error', (tester) async {
      final (server, c) = await open(tester);
      server.refuse = {
        'code': 'PROJECT_OWNER_REQUIRED',
        'message': 'Only the project owner can manage this project.',
      };
      await tester.tap(tick('tony'));
      await tester.pumpAndSettle();
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(find.text('Add people to test private'), findsOneWidget);
      expect(
        find.text('Only the project owner can manage this project.'),
        findsOneWidget,
      );
      expect(tester.widget<CheckboxListTile>(tick('tony')).value, isTrue);
    });

    testWidgets('search narrows both lists, and an empty match says so', (
      tester,
    ) async {
      await open(tester);
      await tester.enterText(
        find.byKey(const ValueKey('project-add-search')),
        'zzz',
      );
      await tester.pumpAndSettle();
      expect(find.text('No one matches'), findsOneWidget);
      await tester.enterText(
        find.byKey(const ValueKey('project-add-search')),
        'tony',
      );
      await tester.pumpAndSettle();
      expect(tick('tony'), findsOneWidget);
      expect(find.text('Already in'), findsNothing);
      expect(find.text('Project owner'), findsNothing);
    });

    testWidgets('everyone already in says so', (tester) async {
      await open(tester, members: ['dee', 'tony']);
      expect(
        find.text('Everyone in this Swarm is in this project.'),
        findsOneWidget,
      );
    });
  });
}
