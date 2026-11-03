import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_task_status.dart';

/// How the phone names people for @, as Desktop does: the username the
/// server sends, else (an older server) the email prefix, numbered after the
/// people before.
void main() {
  SuperTabPerson member(String id, String email, {String? username}) =>
      SuperTabPerson.fromJson({
        'id': id,
        'email': email,
        'role': 'collaborator',
        'username': ?username,
      });

  test('the server\'s username wins over the email prefix', () {
    final [ken] = superTabUsernames([
      member('p1', 'ken@example.com', username: 'kenji'),
    ]);
    expect(ken.username, 'kenji');
  });

  test('without one, the email prefix, numbered past names already taken', () {
    final people = superTabUsernames([
      member('p1', 'Ken.N@a.com'),
      member('p2', 'ken.n@b.com'),
      member('p3', 'x@c.com', username: 'ken.n3'),
      member('p4', 'KEN.N@d.com'),
      member('p5', '+@e.com'),
    ]);
    expect(
      [for (final p in people) p.username],
      ['ken.n', 'ken.n2', 'ken.n3', 'ken.n4', 'user'],
    );
  });

  test('task names use the person username and the Desktop fallback', () {
    SuperTabSnapshot snapshot(List<Map<String, dynamic>> people) =>
        SuperTabSnapshot.fromJson({
          'version': 1,
          'id': 'swarm',
          'name': 'Swarm',
          'ownerId': 'owner',
          'people': people,
          'agents': const [],
          'conversations': const [],
          'invitations': const [],
        });

    String? nameFor(SuperTabSnapshot snapshot, String id) =>
        swarmTaskPersonName(snapshot)(id);

    expect(
      nameFor(
        snapshot([
          {
            'id': 'p1',
            'email': 'ken@example.com',
            'role': 'collaborator',
            'username': 'kenji',
          },
        ]),
        'p1',
      ),
      'kenji',
    );
    expect(
      nameFor(
        snapshot([
          {'id': 'p1', 'email': 'Ken+test@example.com', 'role': 'collaborator'},
        ]),
        'p1',
      ),
      'kentest',
    );
  });
}
