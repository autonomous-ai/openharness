import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/linked_tasks.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';

import 'swarm_fixture.dart';

/// Task steps design (Ken, 2026-11-02: one pull request showed as three
/// tasks): a step sits on its task's row, not in the project's list; a linked
/// task from before steps is listed as before.
void main() {
  SuperTabSnapshot swarm(List<Map<String, dynamic>> groups) =>
      SuperTabSnapshot.fromJson(
        SuperTabParts.firstLoad(
          firstLoad(
            agents: [agent('a-dev', displayName: 'Dev')],
            groups: groups,
          ),
        ).state,
      );

  test('the project list hides every linked task, named as a step or not', () {
    final snapshot = swarm([
      groupData(
        'task',
        title: 'Fix login',
        number: 12,
        status: 'working',
        workerId: 'a-dev',
      ),
      {
        ...groupData(
          'step',
          title: 'Review',
          number: 13,
          status: 'working',
          workerId: 'a-dev',
        ),
        'reviewOf': 'task',
        'step': 'Review',
      },
      {
        ...groupData('old', title: 'Review PR 9', number: 9),
        'reviewOf': 'task',
      },
    ]);
    final work = swarmProjectWork(snapshot, snapshot.projects.single);
    expect(work.active.map((g) => g.id), ['task']);
    expect(
      [...work.active, ...work.older].map((g) => g.id),
      isNot(contains('step')),
    );
    expect(superTabIsStep(snapshot.conversation('step')!), isTrue);
    expect(
      superTabLinkedLine(snapshot, snapshot.conversation('task')!),
      'Review PR 9: not started · Review (Dev): working',
    );
  });
}
