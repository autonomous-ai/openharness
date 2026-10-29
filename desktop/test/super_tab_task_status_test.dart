import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/harness_activity.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/task_status.dart';
import 'package:harness/widgets/harness_activity_mark.dart';

import 'support/super_tab_fixture.dart';

/// The line under each task row (#957, the mockup Ken approved): whether the
/// task is moving, waiting on purpose and for what, or stuck, and what the PM
/// did about it, with the activity mark beside it.
void main() {
  final now = DateTime.utc(2026, 10, 29, 12);
  int ago(Duration age) => now.subtract(age).millisecondsSinceEpoch;
  const minute = Duration(minutes: 1);

  SuperTabConversation task({
    String? status = 'working',
    String? result,
    Duration? progress,
    Map<String, dynamic>? liveness,
    Map<String, dynamic>? leadAction,
  }) => SuperTabConversation.fromJson({
    ...conversationFixture('g', 'Task'),
    'number': 931,
    'assignment': status == null
        ? null
        : {
            'id': 'a',
            'agentId': 'w',
            'status': status,
            'result': result,
            'progressAt': ?(progress == null ? null : ago(progress)),
          },
    'liveness': ?liveness,
    'leadAction': ?leadAction,
  });
  Map<String, dynamic> state(
    String state,
    String why,
    Duration since, {
    String? personId,
  }) => {
    'state': state,
    'why': why,
    'since': ago(since),
    'personId': ?personId,
  };
  String? person(String id) => id == 'ken' ? 'Ken' : null;

  Future<void> show(WidgetTester tester, SuperTabConversation group) =>
      withClock(
        Clock.fixed(now),
        () => tester.pumpWidget(
          MaterialApp(
            home: Material(
              child: Row(
                children: [
                  Expanded(child: SuperTabTaskLine(group, personName: person)),
                  SuperTabTaskMark(group),
                ],
              ),
            ),
          ),
        ),
      );
  String line(WidgetTester tester) => tester
      .widget<Text>(find.byKey(const ValueKey('super-task-line-g')))
      .data!;
  HarnessActivity mark(WidgetTester tester) =>
      tester.widget<ActivityMark>(find.byType(ActivityMark)).activity;

  testWidgets('a working task: how long since its agent last reported', (
    tester,
  ) async {
    await show(tester, task(progress: 4 * minute));
    expect(line(tester), 'Working · 4m ago');
    expect(mark(tester), HarnessActivity.working);
    await show(tester, task(progress: const Duration(seconds: 20)));
    expect(line(tester), 'Working · just now');
  });

  testWidgets('waiting on a person: who, their question and how long', (
    tester,
  ) async {
    await show(
      tester,
      task(
        status: 'needs_human',
        result: 'mockup OK?',
        liveness: state('waiting', 'person', 12 * minute, personId: 'ken'),
      ),
    );
    expect(line(tester), 'Waiting on Ken · mockup OK? · 12m');
    expect(mark(tester), HarnessActivity.needsInput);
    // A person who has left is still waited on, unnamed.
    await show(
      tester,
      task(
        status: 'needs_human',
        liveness: state('waiting', 'person', 12 * minute, personId: 'gone'),
      ),
    );
    expect(line(tester), 'Waiting on a person · 12m');
  });

  testWidgets('queued for a free machine, with the PM retrying', (
    tester,
  ) async {
    await show(
      tester,
      task(
        status: null,
        liveness: state('waiting', 'queued', 25 * minute),
        leadAction: {'kind': 'route', 'at': ago(2 * minute)},
      ),
    );
    expect(line(tester), 'Queued: no free machine · PM retrying · 25m');
    expect(mark(tester), HarnessActivity.unknown);
  });

  testWidgets('quiet, with what the PM did once it went quiet', (
    tester,
  ) async {
    await show(
      tester,
      task(
        liveness: state('quiet', 'silent', 34 * minute),
        leadAction: {'kind': 'assign', 'at': ago(minute)},
      ),
    );
    expect(line(tester), 'Quiet 34m · PM moved it to a new agent');
    expect(mark(tester), HarnessActivity.failed);
    // What the PM did before it went quiet is not handling it.
    await show(
      tester,
      task(
        liveness: state('quiet', 'silent', 34 * minute),
        leadAction: {'kind': 'post', 'at': ago(40 * minute)},
      ),
    );
    expect(line(tester), 'Quiet 34m');
    await show(
      tester,
      task(
        liveness: state('quiet', 'silent', 34 * minute),
        leadAction: {'kind': 'post', 'at': ago(minute)},
      ),
    );
    expect(line(tester), 'Quiet 34m · PM posted');
  });

  testWidgets('waiting on a review, a new revision, a blocker or a start', (
    tester,
  ) async {
    final cases = {
      task(status: 'review', liveness: state('waiting', 'review', 3 * minute)):
          ('Waiting for review · 3m', HarnessActivity.needsInput),
      task(liveness: state('waiting', 'revision', 3 * minute)): (
        'Waiting for the new revision · 3m',
        HarnessActivity.needsInput,
      ),
      task(
        status: 'blocked',
        result: 'Needs a token',
        liveness: state('waiting', 'blocked', 5 * minute),
      ): (
        'Blocked · Needs a token · 5m',
        HarnessActivity.needsInput,
      ),
      task(status: null, liveness: state('waiting', 'starting', 2 * minute)): (
        'Starting its agent · 2m',
        HarnessActivity.starting,
      ),
    };
    for (final MapEntry(key: group, value: (text, activity)) in cases.entries) {
      await show(tester, group);
      expect(line(tester), text);
      expect(mark(tester), activity);
    }
  });

  testWidgets('stuck with nobody on it, and why', (tester) async {
    final cases = {
      'removed': 'Stuck: its agent was removed · 5m',
      'lost': 'Stuck: its agent stopped · 5m',
      'start-failed': 'Stuck: its agent could not start · 5m',
      'unstarted': 'Stuck: its agent has not started · 5m',
    };
    for (final MapEntry(key: why, value: text) in cases.entries) {
      await show(tester, task(liveness: state('orphaned', why, 5 * minute)));
      expect(line(tester), text, reason: why);
      expect(mark(tester), HarnessActivity.failed);
    }
  });

  testWidgets(
    'nothing for finished work, a group without work, or a wait an older backend sent no state for',
    (tester) async {
      for (final group in [
        task(status: 'done', progress: minute),
        task(status: null),
        task(status: 'needs_human', progress: minute),
      ]) {
        await show(tester, group);
        expect(find.byKey(const ValueKey('super-task-line-g')), findsNothing);
        expect(find.byType(ActivityMark), findsNothing);
      }
    },
  );
}
