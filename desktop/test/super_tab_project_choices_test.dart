import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/project_choices.dart';

/// The project list Cmd-N and Join pick a main project from (task #4541, spec 2026-11-07-members-and-leads section 1).
void main() {
  Map<String, dynamic> answer() => {
    'projects': [
      {
        'id': 'lead',
        'name': 'harness',
        'about': 'The Harness app and Swarm',
        'repositoryName': 'autonomous-ai/openharness',
        'lead': {'agentId': 'river', 'name': 'River'},
        'waiting': 12,
      },
      {
        'id': 'lamp',
        'name': 'lamp',
        'about': null,
        'repositoryName': 'autonomous-ai/lamp-os',
        'lead': null,
        'waiting': 0,
      },
      {
        'id': 'notes',
        'name': 'notes',
        'about': null,
        'repositoryName': null,
        'lead': null,
        'waiting': 3,
      },
    ],
    'pick': 'lamp',
  };

  test('reads each project with its purpose, Lead and waiting count, in the '
      'server\'s order, and the one to pick', () async {
    final paths = <String>[];
    final read = await SuperTabProjectChoices.read(
      (method, path, {body}) async {
        paths.add('$method $path');
        return answer();
      },
      'tab',
      invitedTo: 'lamp',
    );
    expect(paths, ['GET /api/super-tabs/tab/project-list?invitedTo=lamp']);
    expect(read!.pick, 'lamp');
    expect([for (final p in read.projects) p.id], ['lead', 'lamp', 'notes']);
    final harness = read.projects.first;
    expect(harness.name, 'harness');
    expect(harness.purpose, 'The Harness app and Swarm');
    expect(harness.lead?.name, 'River');
    expect(harness.lead?.agentId, 'river');
    expect(harness.waiting, 12);
    // No purpose of its own: its repository's name; neither: nothing.
    expect(read.projects[1].purpose, 'autonomous-ai/lamp-os');
    expect(read.projects[1].lead, isNull);
    expect(read.projects[2].purpose, isEmpty);
  });

  test('with no invitation the query names none', () async {
    final paths = <String>[];
    await SuperTabProjectChoices.read((method, path, {body}) async {
      paths.add(path);
      return {'projects': <dynamic>[], 'pick': null};
    }, 'tab');
    expect(paths, ['/api/super-tabs/tab/project-list']);
  });

  test('a backend from before the list answers 404: no list, and the form '
      'stays as it was', () async {
    final read = await SuperTabProjectChoices.read(
      (method, path, {body}) async => throw const SuperTabFailure(
        'NOT_FOUND',
        'Not found',
        statusCode: 404,
      ),
      'tab',
    );
    expect(read, isNull);
  });

  test('any other failure is said', () async {
    expect(
      SuperTabProjectChoices.read(
        (method, path, {body}) async =>
            throw const SuperTabFailure('UNAVAILABLE', 'Down', statusCode: 503),
        'tab',
      ),
      throwsA(isA<SuperTabFailure>()),
    );
  });

  test('a pick the list does not hold picks nothing', () async {
    final read = await SuperTabProjectChoices.read(
      (method, path, {body}) async => {...answer(), 'pick': 'gone'},
      'tab',
    );
    expect(read!.pick, isNull);
  });
}
