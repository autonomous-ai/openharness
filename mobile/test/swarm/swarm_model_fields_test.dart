import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';

/// The Swarm fields Desktop's model took on 11-03 (task #2388): how a person
/// joined (#2714), the head's domain auto-join (#2714) and a project's GitHub
/// revision (#2713). The phone reads each as Desktop does, and the defaults an
/// older server leaves.
void main() {
  test('a person added for their email domain says so; others say nothing', () {
    final joined = SuperTabPerson.fromJson({
      'id': 'p1',
      'email': 'dee@example.com',
      'role': 'collaborator',
      'joinedVia': 'domain',
    });
    expect(joined.joinedVia, 'domain');
    final invited = SuperTabPerson.fromJson({
      'id': 'p2',
      'email': 'ken@example.com',
      'role': 'owner',
    });
    expect(invited.joinedVia, isNull);
  });

  test("a project's GitHub revision, 0 from an older server", () {
    Map<String, dynamic> row([Map<String, dynamic> extra = const {}]) => {
      'id': 'p',
      'name': 'openharness',
      'ownerId': 'o',
      'leadConversationId': 'project-p',
      ...extra,
    };
    expect(
      SuperTabProject.fromJson(row({'githubRevision': 3})).githubRevision,
      3,
    );
    expect(SuperTabProject.fromJson(row()).githubRevision, 0);
  });

  test("the Swarm's domain auto-join, off from an older server", () {
    Map<String, dynamic> head([Map<String, dynamic> extra = const {}]) => {
      'version': 1,
      'id': 'tab',
      'name': 'Swarm',
      'ownerId': 'o',
      'people': const [],
      'agents': const [],
      'conversations': const [],
      'invitations': const [],
      ...extra,
    };
    expect(
      SuperTabSnapshot.fromJson(head({'autoJoin': true})).autoJoin,
      isTrue,
    );
    expect(SuperTabSnapshot.fromJson(head()).autoJoin, isFalse);
  });
}
