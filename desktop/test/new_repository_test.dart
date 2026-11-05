import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/model.dart';

/// A project row as the backend sends it, with [creation] as its
/// `repositoryCreation` (backend projects.ts, task #1788).
Map<String, dynamic> _row([Object? creation]) => {
  'id': 'p1',
  'name': 'Notes',
  'ownerId': 'owner',
  'leadConversationId': 'p1-chat',
  'repositoryCreation': ?creation,
};

void main() {
  group('a project\'s new repository (task #3374)', () {
    test('is read with each field the backend writes', () {
      final creation = SuperTabProject.fromJson(
        _row({
          'owner': 'acme',
          'name': 'notes',
          'private': true,
          'by': 'owner',
          'at': 1793886612889,
          'state': 'created',
          'repositoryUrl': 'https://github.com/acme/notes',
          'reachable': false,
        }),
      ).repositoryCreation!;
      expect(creation.owner, 'acme');
      expect(creation.name, 'notes');
      expect(creation.private, isTrue);
      expect(creation.at, 1793886612889);
      expect(creation.state, 'created');
      expect(creation.repositoryUrl, 'https://github.com/acme/notes');
      expect(creation.reachable, isFalse);
      expect(creation.reason, isNull);

      final refused = SuperTabProject.fromJson(
        _row({
          'owner': 'acme',
          'name': 'notes',
          'private': false,
          'by': 'owner',
          'at': 5,
          'state': 'refused',
          'reason': 'Repository creation failed.',
        }),
      ).repositoryCreation!;
      expect(refused.private, isFalse);
      expect(refused.reason, 'Repository creation failed.');
      expect(refused.reachable, isNull);
    });

    test('is null when absent or malformed, as from an older backend', () {
      expect(SuperTabProject.fromJson(_row()).repositoryCreation, isNull);
      for (final bad in [
        'created',
        <String, dynamic>{'owner': 'acme', 'name': 'notes', 'state': 'waiting'},
        <String, dynamic>{'owner': 'acme', 'at': 1, 'state': 'waiting'},
        <String, dynamic>{'name': 'notes', 'at': 1, 'state': 'waiting'},
        <String, dynamic>{'owner': 'acme', 'name': 'notes', 'at': 1},
      ]) {
        expect(
          SuperTabProject.fromJson(_row(bad)).repositoryCreation,
          isNull,
          reason: '$bad',
        );
      }
    });
  });
}
