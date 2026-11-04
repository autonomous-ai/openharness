import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/project_add_people.dart';

/// The Add people picker's lists (Diego, 2026-11-04): who can be added to a
/// private project, and who is already in.
SuperTabPerson _person(String id, {String? name}) => SuperTabPerson.fromJson({
  'id': id,
  'email': '$id@example.com',
  'role': 'collaborator',
  'name': ?name,
});

SuperTabProject _project(List<String> members) => SuperTabProject.fromJson({
  'id': 'lead',
  'name': 'test private',
  'ownerId': 'owner',
  'leadConversationId': 'lead',
  'visibility': 'private',
  'members': [
    for (final id in members) {'id': id},
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

    test('no one to add', () {
      final lists = projectPeopleLists(
        people,
        _project(['dee', 'tony', 'zed']),
        '',
      );
      expect(lists.addable, isEmpty);
    });
  });
}
