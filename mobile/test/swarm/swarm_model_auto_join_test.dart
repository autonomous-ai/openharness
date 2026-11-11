import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';

import 'swarm_fixture.dart';

/// Fields the desktop's model reads since domain auto-join and the GitHub
/// revision (#2736): the phone reads them too, so a read parsed on a computer
/// is not dropped on the phone (desktop_parity_test.dart).
void main() {
  SuperTabSnapshot snapshot({
    Map<String, dynamic> head = const {},
    Map<String, dynamic> project = const {},
    Map<String, dynamic> member = const {},
  }) {
    final base = headData();
    final data = firstLoad(
      head: {
        ...base,
        'projects': [
          {...(base['projects'] as List).single as Map, ...project},
        ],
        ...head,
      },
    );
    data['members'] = [
      part(me, 1, {...person(me), ...member}),
    ];
    return SuperTabSnapshot.fromJson(SuperTabParts.firstLoad(data).state);
  }

  test('a server that sends them: autoJoin on the head, joinedVia on a '
      "member and a project's GitHub revision", () {
    final read = snapshot(
      head: {'autoJoin': true},
      project: {'githubRevision': 3},
      member: {'joinedVia': 'domain'},
    );

    expect(read.autoJoin, isTrue);
    expect(read.projects.single.githubRevision, 3);
    expect(read.people.single.joinedVia, 'domain');
  });

  test('an older server, which sends none: off, 0 and null', () {
    final read = snapshot();

    expect(read.autoJoin, isFalse);
    expect(read.projects.single.githubRevision, 0);
    expect(read.people.single.joinedVia, isNull);
  });

  test('autoJoin is on only when it is true', () {
    expect(snapshot(head: {'autoJoin': false}).autoJoin, isFalse);
    expect(snapshot(head: {'autoJoin': 'yes'}).autoJoin, isFalse);
  });

  test('a person the phone names from their email, as an older server '
      'sends no username, keeps how they joined', () {
    final read = snapshot(member: {'joinedVia': 'domain'});

    expect(read.people.single.chosenUsername, isNull);
    expect(
      read.people.single.username,
      superTabDefaultUsername('$me@example.com'),
    );
    expect(read.people.single.joinedVia, 'domain');
  });

  test('a person whose username the server sends keeps it too', () {
    final read = snapshot(member: {'joinedVia': 'domain', 'username': 'tony'});

    expect(read.people.single.username, 'tony');
    expect(read.people.single.joinedVia, 'domain');
  });
}
