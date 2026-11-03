import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/harness_activity.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/task_status.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/widgets/harness_activity_mark.dart';

import 'support/humans_fixture.dart';
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

  /// The line as it reads: its parts, in order.
  String line(WidgetTester tester) => tester
      .widgetList<Text>(
        find.descendant(
          of: find.byKey(const ValueKey('super-task-line-g')),
          matching: find.byType(Text),
        ),
      )
      .map((text) => text.data!)
      .join();
  HarnessActivity mark(WidgetTester tester) =>
      tester.widget<ActivityMark>(find.byType(ActivityMark)).activity;

  testWidgets('a working task: how long since its agent last reported', (
    tester,
  ) async {
    await show(tester, task(progress: minute * 4));
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
        liveness: state('waiting', 'person', minute * 12, personId: 'ken'),
      ),
    );
    expect(line(tester), 'Waiting on Ken · mockup OK? · 12m');
    expect(mark(tester), HarnessActivity.needsInput);
    // A person who has left is still waited on, unnamed.
    await show(
      tester,
      task(
        status: 'needs_human',
        liveness: state('waiting', 'person', minute * 12, personId: 'gone'),
      ),
    );
    expect(line(tester), 'Waiting on a person · 12m');
  });

  testWidgets('queued for a free machine, routed again', (tester) async {
    await show(
      tester,
      task(
        status: null,
        liveness: state('waiting', 'queued', minute * 25),
        leadAction: {'kind': 'route', 'at': ago(minute * 2)},
      ),
    );
    expect(line(tester), 'Queued: no free machine · 25m · Routed again 2m ago');
    expect(mark(tester), HarnessActivity.unknown);
  });

  testWidgets('quiet, with what was done once it went quiet', (tester) async {
    await show(
      tester,
      task(
        liveness: state('quiet', 'silent', minute * 34),
        leadAction: {'kind': 'assign', 'at': ago(minute)},
      ),
    );
    expect(line(tester), 'Quiet 34m · Reassigned 1m ago');
    expect(mark(tester), HarnessActivity.failed);
    // What was done before it went quiet is not handling it.
    await show(
      tester,
      task(
        liveness: state('quiet', 'silent', minute * 34),
        leadAction: {'kind': 'post', 'at': ago(minute * 40)},
      ),
    );
    expect(line(tester), 'Quiet 34m');
    await show(
      tester,
      task(
        liveness: state('quiet', 'silent', minute * 34),
        leadAction: {'kind': 'post', 'at': ago(minute)},
      ),
    );
    expect(line(tester), 'Quiet 34m · Posted 1m ago');
    // Facts about what was done; any agent may have done it.
    await show(
      tester,
      task(
        liveness: state('quiet', 'silent', minute * 34),
        leadAction: {'kind': 'start', 'at': ago(minute)},
      ),
    );
    expect(line(tester), 'Quiet 34m · Starting another agent 1m ago');
    expect(find.textContaining('PM'), findsNothing);
  });

  testWidgets(
    'a reassigned task that is working again shows its agent\'s progress, not the PM\'s old action',
    (tester) async {
      await show(
        tester,
        task(
          progress: minute * 2,
          leadAction: {'kind': 'assign', 'at': ago(minute * 3)},
        ),
      );
      expect(line(tester), 'Working · 2m ago');
    },
  );

  testWidgets(
    'its ages keep moving on their own, the state\'s and the PM\'s, with no other rebuild',
    (tester) async {
      var at = now;
      final group = task(
        liveness: state('quiet', 'silent', minute * 34),
        leadAction: {'kind': 'post', 'at': ago(minute)},
      );
      await withClock(Clock(() => at), () async {
        await tester.pumpWidget(
          MaterialApp(home: Material(child: SuperTabTaskLine(group))),
        );
        expect(line(tester), 'Quiet 34m · Posted 1m ago');
        for (final expected in [
          'Quiet 35m · Posted 2m ago',
          'Quiet 36m · Posted 3m ago',
        ]) {
          at = at.add(minute);
          await tester.pump(minute + const Duration(milliseconds: 2));
          expect(line(tester), expected);
        }
        // Gone with its row: no timer is left behind.
        await tester.pumpWidget(const SizedBox());
      });
    },
  );

  testWidgets('a line too long for its row cuts its reason, never its age', (
    tester,
  ) async {
    final group = task(
      status: 'needs_human',
      result: 'Please approve the production deployment and confirm the rollback plan',
      liveness: state('waiting', 'person', minute * 12, personId: 'ken'),
      leadAction: {'kind': 'post', 'at': ago(minute * 2)},
    );
    for (final scale in [1.0, 2.0]) {
      await withClock(
        Clock.fixed(now),
        () => tester.pumpWidget(
          MaterialApp(
            home: MediaQuery(
              data: MediaQueryData(textScaler: TextScaler.linear(scale)),
              child: Material(
                child: Center(
                  child: SizedBox(
                    width: 180 * scale,
                    child: SuperTabTaskLine(group, personName: person),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      RenderParagraph part(String text) =>
          tester.renderObject<RenderParagraph>(find.text(text));
      expect(part(' · 12m').didExceedMaxLines, isFalse, reason: '×$scale');
      expect(
        part(
          'Waiting on Ken · Please approve the production deployment and confirm the rollback plan',
        ).didExceedMaxLines,
        isTrue,
        reason: '×$scale',
      );
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets('waiting on others, a new revision, a blocker or a start', (
    tester,
  ) async {
    final cases = {
      task(status: 'review', liveness: state('waiting', 'review', minute * 3)):
          ('Waiting on others · 3m', HarnessActivity.needsInput),
      // With the agent's note.
      task(
        status: 'review',
        result: 'PR 12 is up',
        liveness: state('waiting', 'review', minute * 3),
      ): (
        'Waiting on others · PR 12 is up · 3m',
        HarnessActivity.needsInput,
      ),
      task(liveness: state('waiting', 'revision', minute * 3)): (
        'Waiting for the new revision · 3m',
        HarnessActivity.needsInput,
      ),
      task(
        status: 'blocked',
        result: 'Needs a token',
        liveness: state('waiting', 'blocked', minute * 5),
      ): (
        'Blocked · Needs a token · 5m',
        HarnessActivity.needsInput,
      ),
      task(status: null, liveness: state('waiting', 'starting', minute * 2)): (
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
      await show(tester, task(liveness: state('orphaned', why, minute * 5)));
      expect(line(tester), text, reason: why);
      expect(mark(tester), HarnessActivity.failed);
    }
  });

  testWidgets(
    'a task row in the sidebar shows its line under its name and its mark at its right, naming the person',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1300, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = humansSwarm();
      final group = (server.state['conversations'] as List)
          .cast<Map<String, dynamic>>()
          .firstWhere((g) => g['id'] == 'offline');
      group['assignment'] = {
        'id': 'a',
        'agentId': 'w',
        'status': 'needs_human',
        'result': 'mockup OK?',
      };
      group['liveness'] = state(
        'waiting',
        'person',
        minute * 12,
        personId: 'owner',
      );
      final controller = server.controller(
        account: 'peer',
        initial: {'tabId': 'tab', 'accountId': 'peer', 'selectedId': 'lead'},
      );
      await controller.refresh();
      controller.expandedProjects.add('lead');
      await withClock(
        Clock.fixed(now),
        () => tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: Brightness.light),
            home: Scaffold(
              body: SuperTabView(
                controller: controller,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Studio',
              ),
            ),
          ),
        ),
      );
      final row = find.byKey(const ValueKey('super-group-offline'));
      final line = find.descendant(
        of: row,
        matching: find.byKey(const ValueKey('super-task-line-offline')),
      );
      expect(
        tester
            .widgetList<Text>(
              find.descendant(of: line, matching: find.byType(Text)),
            )
            .map((text) => text.data)
            .join(),
        'Waiting on ken · mockup OK? · 12m',
      );
      expect(
        find.descendant(
          of: row,
          matching: find.byKey(const ValueKey('super-task-mark-offline')),
        ),
        findsOneWidget,
      );
      // A line the sidebar cuts short is whole in the row's tooltip.
      expect(
        find.byTooltip('Offline editing\nWaiting on ken · mockup OK? · 12m'),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
      await controller.flush();
      controller.dispose();
    },
  );

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
