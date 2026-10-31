import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/instructions_model.dart';
import 'package:harness/super_tabs/model.dart';

Map<String, dynamic> _swarm({Map<String, dynamic>? project, Map? agent}) => {
  'version': 1,
  'id': 'tab1',
  'name': 'Swarm',
  'ownerId': 'u1',
  'people': <Object>[],
  'agents': [
    {
      'id': 'a1',
      'projectId': 'p1',
      'name': 'a1',
      'machineId': 'm1',
      'harnessId': 'h1',
      'contributorId': 'u1',
      'configuration': <String, dynamic>{},
      ...?agent,
    },
  ],
  'conversations': <Object>[],
  'invitations': <Object>[],
  'projects': [
    {
      'id': 'p1',
      'name': 'P',
      'ownerId': 'u1',
      'leadConversationId': 'c1',
      ...?project,
    },
  ],
};

void main() {
  test('reads the document, its notes and its revisions', () {
    final doc = SuperTabInstructions.fromJson({
      'projectId': 'p1',
      'revision': 3,
      'hash': 'abc',
      'text': '# Doc',
      'template': false,
      'coordinatorName': 'Coordinator',
      'notesRevision': 2,
      'notes': [
        {
          'id': 'n1',
          'text': 'one',
          'askedBy': 'u2',
          'at': '2026-10-30T01:00:00.000Z',
          'expiresAt': '2026-11-06T01:00:00.000Z',
        },
        {
          'id': 'n2',
          'text': 'two',
          'askedBy': 'u3',
          'at': '2026-10-30T02:00:00.000Z',
        },
      ],
    });
    expect(doc.revision, 3);
    expect(doc.template, false);
    expect(doc.coordinatorName, 'Coordinator');
    expect(doc.notesRevision, 2);
    expect(doc.notes.map((n) => n.id), ['n1', 'n2']);
    expect(doc.notes[0].expiresAt, DateTime.utc(2026, 11, 6, 1));
    expect(doc.notes[1].expiresAt, isNull);
    expect(doc.notes[0].at, DateTime.utc(2026, 10, 30, 1));
    final buddy = SuperTabInstructions.fromJson({
      'projectId': 'p1',
      'revision': 1,
      'text': 'x',
      'template': true,
      'coordinatorName': 'Product Manager',
      'notesRevision': 0,
    });
    expect(buddy.notes, isEmpty);
    expect(buddy.hash, isNull);

    final revisions = [
      for (final (kind, n) in [('person', 3), ('agent', 2), ('system', 1)])
        SuperTabRevision.fromJson({
          'revision': n,
          'hash': 'h$n',
          'summary': 's$n',
          'writtenBy': {'kind': kind, 'id': 'x$n'},
          'askedBy': n == 2 ? 'u2' : null,
          'at': '2026-10-30T0$n:00:00.000Z',
        }),
    ];
    expect(revisions.map((r) => r.revision), [3, 2, 1]);
    expect(revisions.map((r) => r.writtenBy.kind), [
      'person',
      'agent',
      'system',
    ]);
    expect(revisions[1].askedBy, 'u2');
    expect(revisions[0].text, isNull);
  });

  test('finds the role headings of the Roles section', () {
    const template = '''
# Project

## Roles

### PM
Coordinates.

### Engineer
Builds.

### Reviewer
### Tester

## Workflow

### Step
Do it.
''';
    expect(superTabInstructionRoleNames(template), [
      'PM',
      'Engineer',
      'Reviewer',
      'Tester',
    ]);
    expect(
      superTabInstructionRoleNames('## Roles\n### Dev\n### dev\n### DEV\n'),
      ['Dev'],
    );
    expect(
      superTabInstructionRoleNames('## Roles\n### ${'x' * 41}\n### ok\n'),
      ['ok'],
    );
    expect(superTabInstructionRoleNames('## Workflow\n### Step\n'), isEmpty);
    expect(superTabInstructionRoleNames('## roles\n### A\n'), ['A']);
  });

  test('names the reads', () {
    expect(
      superTabInstructionsPath('t 1', 'p1', revision: 4),
      '/api/super-tabs/t%201/projects/p1/instructions/revisions/4',
    );
    expect(
      superTabInstructionsPath('t1', 'p1'),
      '/api/super-tabs/t1/projects/p1/instructions',
    );
    expect(
      superTabInstructionsPath('t1', 'p/1', revisions: true),
      '/api/super-tabs/t1/projects/p%2F1/instructions/revisions',
    );
    expect(superTabMissingRoute('BACKEND_UNAVAILABLE', 404), isTrue);
    expect(superTabMissingRoute('NOT_FOUND', 404), isFalse);
    expect(superTabMissingRoute('INSTRUCTIONS_UNAVAILABLE', 503), isFalse);
  });

  test("reads the project's instructions fields and the agent's role name", () {
    final snapshot = SuperTabSnapshot.fromJson(
      _swarm(
        project: {
          'coordinatorName': 'Coordinator',
          'instructionsRevision': 7,
          'notesRevision': 2,
        },
        agent: {'roleName': 'Tester'},
      ),
    );
    final project = snapshot.projectById('p1')!;
    expect(project.coordinatorName, 'Coordinator');
    expect(project.instructionsRevision, 7);
    expect(project.notesRevision, 2);
    expect(project.hasInstructions, isTrue);
    expect(snapshot.agent('a1')!.roleName, 'Tester');
    expect(snapshot.projectById('nope'), isNull);

    final old = SuperTabSnapshot.fromJson(_swarm());
    final oldProject = old.projectById('p1')!;
    expect(oldProject.coordinatorName, isNull);
    expect(oldProject.instructionsRevision, 0);
    expect(oldProject.notesRevision, 0);
    expect(oldProject.hasInstructions, isFalse);
    expect(old.agent('a1')!.roleName, isNull);
  });
}
