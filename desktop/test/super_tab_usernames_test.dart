import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/parts.dart';
import 'package:harness/super_tabs/leaderboard/model.dart';
import 'package:harness/super_tabs/leaderboard/person_row.dart';
import 'package:harness/super_tabs/model.dart';

import 'super_tab_parts_test.dart' show recorded;

Map<String, dynamic> _person(String id, String email, [String? username]) => {
  'id': id,
  'email': email,
  'role': 'collaborator',
  'username': ?username,
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

Map<String, String> _names(List<Map<String, dynamic>> people) => {
  for (final person in _swarm(people).people) person.id: person.username,
};

void main() {
  // An older server sends no usernames: Desktop works out defaults by the
  // rule backend/src/superTabs/usernames.test.ts checks.
  group('default usernames', () {
    test('is the lowercased email prefix, numbered by join order', () {
      expect(
        _names([
          _person('a', 'Ken@autonomous.ai'),
          _person('b', 'ken@example.com'),
          _person('c', 'tony@autonomous.ai'),
          _person('d', 'KEN@other.org'),
        ]),
        {'a': 'ken', 'b': 'ken2', 'c': 'tony', 'd': 'ken3'},
      );
    });

    test('keeps a chosen name and numbers a default around it', () {
      expect(
        _names([
          _person('a', 'dee@autonomous.ai', 'ken'),
          _person('b', 'ken@autonomous.ai'),
          _person('c', 'diego@autonomous.ai'),
        ]),
        {'a': 'ken', 'b': 'ken2', 'c': 'diego'},
      );
    });

    test(
      'makes a usable name of a prefix with other characters, or too short',
      () {
        expect(
          _names([
            _person('a', 'pham.ngoc+swarm@gmail.com'),
            _person('b', 'x@example.com'),
            _person('c', '__@example.com'),
            _person('d', '${'a' * 40}@example.com'),
          ]),
          {'a': 'pham.ngocswarm', 'b': 'x1', 'c': 'user', 'd': 'a' * 30},
        );
      },
    );

    test('never ends a default name with a dot or puts two in a row', () {
      expect(
        _names([
          _person('a', '${'a' * 29}.b@example.com'),
          _person('b', 'ken..nguyen@example.com'),
          _person('c', 'dee.@example.com'),
          _person('d', 'x.@example.com'),
        ]),
        {'a': 'a' * 29, 'b': 'ken.nguyen', 'c': 'dee', 'd': 'x1'},
      );
    });
  });

  test('names come from the server, whatever order members arrive in', () {
    Map<String, dynamic> member(String id, String email, String username) => {
      'key': id,
      'version': 1,
      'changedAt': 1793000000000,
      'data': {
        'id': id,
        'email': email,
        'role': 'collaborator',
        'generation': 'g',
        'username': username,
      },
    };
    final load = recorded('first_load')
      ..['members'] = [
        member('6a86', 'ken15@autonomous.ai', 'ken15'),
        // Joined after `earlier`, sent before it (review of #2088).
        member('rejoined', 'ken@other.org', 'ken2'),
        member('earlier', 'ken@example.com', 'ken'),
      ];
    final snapshot = SuperTabSnapshot.fromJson(
      SuperTabParts.firstLoad(load).state,
    );
    expect(
      {for (final p in snapshot.people) p.id: p.username},
      {'6a86': 'ken15', 'rejoined': 'ken2', 'earlier': 'ken'},
    );
  });

  test('a person’s message is signed with their username, not their email', () {
    final swarm = _swarm([
      _person('owner', 'ken15@autonomous.ai', 'river'),
      _person('peer', 'dee@autonomous.ai'),
    ]);
    SuperTabMessage from(String id, String email) => SuperTabMessage.fromJson({
      'id': 'm-$id',
      'conversationId': 'lead',
      'text': 'Morning',
      'sequence': 1,
      'author': {'kind': 'person', 'id': id, 'name': email},
    });
    expect(swarm.authorName(from('owner', 'ken15@autonomous.ai')), 'river');
    expect(swarm.authorName(from('peer', 'dee@autonomous.ai')), 'dee');
    // Someone who left keeps the name their address gives.
    expect(swarm.authorName(from('gone', 'tony@autonomous.ai')), 'tony');
  });

  test('the leaderboard names a person by their username', () {
    final person = _swarm([_person('owner', 'ken15@autonomous.ai', 'river')])
        .people
        .single;
    final score = SuperTabPersonScore.fromJson({
      'personId': 'owner',
      'displayName': 'Ken Nguyen at Autonomous',
    });
    expect(leaderboardName(person, score), 'river');
  });
}
