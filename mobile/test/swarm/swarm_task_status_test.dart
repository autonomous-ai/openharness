import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_task_status.dart';

import 'swarm_fixture.dart';

/// The line under each task row, as the desktop's (#957, #2125, the mockup
/// Ken approved): whether the task is moving, waiting on purpose and for
/// what, or stuck, and what the PM did about it. The same data reads the
/// same words as `desktop/test/super_tab_task_status_test.dart`.
void main() {
  final now = DateTime.utc(2026, 10, 29, 12);
  int ago(Duration age) => now.subtract(age).millisecondsSinceEpoch;
  const minute = Duration(minutes: 1);

  SuperTabConversation task({
    String? status = 'working',
    Object? result,
    Duration? progress,
    Object? liveness,
    Object? leadAction,
  }) => SuperTabConversation.fromJson({
    ...groupData('g', title: 'Task', number: 931),
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

  /// The line as it reads, its parts in order.
  String? read(SuperTabConversation group, {DateTime? at}) =>
      switch (swarmTaskStatus(group, at ?? now, personName: person)) {
        final status? => swarmTaskStatusText(status),
        null => null,
      };
  SwarmTaskMark? mark(SuperTabConversation group) =>
      swarmTaskStatus(group, now, personName: person)?.mark;

  group('the line reads as the desktop\'s', () {
    test('a working task: how long since its agent last reported', () {
      expect(read(task(progress: minute * 4)), 'Working · 4m ago');
      expect(mark(task(progress: minute * 4)), SwarmTaskMark.working);
      expect(
        read(task(progress: const Duration(seconds: 20))),
        'Working · just now',
      );
      // A planned task is at work too.
      expect(
        read(task(status: 'planned', progress: minute * 2)),
        'Working · 2m ago',
      );
    });

    test('waiting on a person: who, their question and how long', () {
      final asked = task(
        status: 'needs_human',
        result: 'mockup OK?',
        liveness: state('waiting', 'person', minute * 12, personId: 'ken'),
      );
      expect(read(asked), 'Waiting on Ken · mockup OK? · 12m');
      expect(mark(asked), SwarmTaskMark.needsInput);
      // A person who has left, or one this read does not name, is still
      // waited on, unnamed.
      expect(
        read(
          task(
            status: 'needs_human',
            liveness: state('waiting', 'person', minute * 12, personId: 'gone'),
          ),
        ),
        'Waiting on a person · 12m',
      );
      // A blank question asks nothing.
      expect(
        read(
          task(
            status: 'needs_human',
            result: '   ',
            liveness: state('waiting', 'person', minute * 12, personId: 'ken'),
          ),
        ),
        'Waiting on Ken · 12m',
      );
    });

    test('queued for a free machine, with the PM retrying', () {
      final queued = task(
        status: null,
        liveness: state('waiting', 'queued', minute * 25),
        leadAction: {'kind': 'route', 'at': ago(minute * 2)},
      );
      expect(
        read(queued),
        'Queued: no free machine · 25m · PM retrying 2m ago',
      );
      expect(mark(queued), SwarmTaskMark.unknown);
    });

    test('quiet, with what the PM did once it went quiet', () {
      final reassigned = task(
        liveness: state('quiet', 'silent', minute * 34),
        leadAction: {'kind': 'assign', 'at': ago(minute)},
      );
      expect(read(reassigned), 'Quiet 34m · PM reassigned it 1m ago');
      expect(mark(reassigned), SwarmTaskMark.failed);
      // What the PM did before it went quiet is not handling it.
      expect(
        read(
          task(
            liveness: state('quiet', 'silent', minute * 34),
            leadAction: {'kind': 'post', 'at': ago(minute * 40)},
          ),
        ),
        'Quiet 34m',
      );
      expect(
        read(
          task(
            liveness: state('quiet', 'silent', minute * 34),
            leadAction: {'kind': 'post', 'at': ago(minute)},
          ),
        ),
        'Quiet 34m · PM posted 1m ago',
      );
      expect(
        read(
          task(
            liveness: state('quiet', 'silent', minute * 34),
            leadAction: {'kind': 'start', 'at': ago(minute * 3)},
          ),
        ),
        'Quiet 34m · PM retrying 3m ago',
      );
      // An action the desktop does not name says nothing.
      expect(
        read(
          task(
            liveness: state('quiet', 'silent', minute * 34),
            leadAction: {'kind': 'wave', 'at': ago(minute)},
          ),
        ),
        'Quiet 34m',
      );
    });

    test('a reassigned task that is working again shows its agent\'s '
        'progress, not the PM\'s old action', () {
      expect(
        read(
          task(
            progress: minute * 2,
            leadAction: {'kind': 'assign', 'at': ago(minute * 3)},
          ),
        ),
        'Working · 2m ago',
      );
    });

    test('waiting on a review, a new revision, a blocker or a start', () {
      final cases = {
        task(
          status: 'review',
          liveness: state('waiting', 'review', minute * 3),
        ): (
          'Waiting for review · 3m',
          SwarmTaskMark.needsInput,
        ),
        task(liveness: state('waiting', 'revision', minute * 3)): (
          'Waiting for the new revision · 3m',
          SwarmTaskMark.needsInput,
        ),
        task(
          status: 'blocked',
          result: 'Needs a token',
          liveness: state('waiting', 'blocked', minute * 5),
        ): (
          'Blocked · Needs a token · 5m',
          SwarmTaskMark.needsInput,
        ),
        task(status: 'blocked', liveness: state('waiting', 'blocked', minute)):
            ('Blocked · 1m', SwarmTaskMark.needsInput),
        task(status: null, liveness: state('waiting', 'starting', minute * 2)):
            ('Starting its agent · 2m', SwarmTaskMark.starting),
      };
      for (final MapEntry(key: group, value: (text, kind)) in cases.entries) {
        expect(read(group), text);
        expect(mark(group), kind, reason: text);
      }
    });

    test('stuck with nobody on it, and why', () {
      final cases = {
        'removed': 'Stuck: its agent was removed · 5m',
        'lost': 'Stuck: its agent stopped · 5m',
        'start-failed': 'Stuck: its agent could not start · 5m',
        'unstarted': 'Stuck: its agent has not started · 5m',
      };
      for (final MapEntry(key: why, value: text) in cases.entries) {
        final stuck = task(liveness: state('orphaned', why, minute * 5));
        expect(read(stuck), text, reason: why);
        expect(mark(stuck), SwarmTaskMark.failed, reason: why);
      }
    });

    test('ages read in seconds\' place under a minute, then minutes, hours '
        'and days', () {
      final quiet = task(liveness: state('quiet', 'silent', Duration.zero));
      for (final (age, text) in [
        (const Duration(seconds: 30), 'Quiet <1m'),
        (minute * 59, 'Quiet 59m'),
        (const Duration(hours: 2, minutes: 5), 'Quiet 2h'),
        (const Duration(days: 3, hours: 1), 'Quiet 3d'),
      ]) {
        expect(read(quiet, at: now.add(age)), text);
      }
      // A clock behind the server's never reads a negative age.
      expect(read(quiet, at: now.subtract(minute)), 'Quiet <1m');
    });

    test('nothing for finished work, a group without work, a wait an older '
        'backend sent no state for, or a state the phone does not know', () {
      for (final group in [
        task(status: 'done', progress: minute),
        task(status: null),
        task(status: 'needs_human', progress: minute),
        task(liveness: state('waiting', 'teleporting', minute)),
        task(liveness: state('sleeping', 'silent', minute)),
      ]) {
        expect(swarmTaskStatus(group, now), isNull);
      }
    });
  });

  group('a part the server sent wrong draws nothing rather than guessing', () {
    test('a state with no time, or a time that is no number', () {
      for (final liveness in [
        {'state': 'quiet', 'why': 'silent'},
        {'state': 'quiet', 'why': 'silent', 'since': '34 minutes'},
        {'state': 7, 'why': 'silent', 'since': ago(minute)},
      ]) {
        expect(swarmTaskStatus(task(liveness: liveness), now), isNull);
      }
      // A working task's progress that is no number.
      expect(
        swarmTaskStatus(
          SuperTabConversation.fromJson({
            ...groupData('g', title: 'Task'),
            'assignment': {'status': 'working', 'progressAt': 'soon'},
          }),
          now,
        ),
        isNull,
      );
    });

    test(
      'a PM action with no time, a question or a person that is no text',
      () {
        expect(
          read(
            task(
              liveness: state('quiet', 'silent', minute * 34),
              leadAction: {'kind': 'post'},
            ),
          ),
          'Quiet 34m',
        );
        expect(
          read(
            task(
              status: 'needs_human',
              result: ['mockup OK?'],
              liveness: {
                ...state('waiting', 'person', minute * 12),
                'personId': 42,
              },
            ),
          ),
          'Waiting on a person · 12m',
        );
      },
    );
  });

  group('drawn', () {
    Widget app(Widget child, {double scale = 1}) => MaterialApp(
      home: MediaQuery(
        data: MediaQueryData(textScaler: TextScaler.linear(scale)),
        child: Material(child: child),
      ),
    );

    /// The line as it reads on screen: its words, in order, after its dot.
    String line(WidgetTester tester) => tester
        .widgetList<Text>(
          find.descendant(
            of: find.byKey(const ValueKey('swarm-task-line-g')),
            matching: find.byType(Text),
          ),
        )
        .where((text) => text.key != const ValueKey('swarm-task-mark-g'))
        .map((text) => text.data!)
        .join();

    testWidgets('its dot, then its words, the dot unheard', (tester) async {
      await withClock(
        Clock.fixed(now),
        () => tester.pumpWidget(
          app(
            SwarmTaskLine(
              task(
                status: 'needs_human',
                result: 'mockup OK?',
                liveness: state(
                  'waiting',
                  'person',
                  minute * 12,
                  personId: 'ken',
                ),
              ),
              personName: person,
            ),
          ),
        ),
      );
      expect(line(tester), 'Waiting on Ken · mockup OK? · 12m');
      expect(find.byKey(const ValueKey('swarm-task-mark-g')), findsOneWidget);
      final handle = tester.ensureSemantics();
      expect(
        find.bySemanticsLabel(RegExp('●')),
        findsNothing,
        reason: 'the words say what the dot shows',
      );
      handle.dispose();
    });

    testWidgets('a line the row cuts short loses its reason, never its age', (
      tester,
    ) async {
      final group = task(
        status: 'needs_human',
        result:
            'Please approve the production deployment and confirm the '
            'rollback plan',
        liveness: state('waiting', 'person', minute * 12, personId: 'ken'),
        leadAction: {'kind': 'post', 'at': ago(minute * 2)},
      );
      for (final scale in [1.0, 2.0]) {
        await withClock(
          Clock.fixed(now),
          () => tester.pumpWidget(
            app(
              Center(
                child: SizedBox(
                  width: 180 * scale,
                  child: SwarmTaskLine(group, personName: person),
                ),
              ),
              scale: scale,
            ),
          ),
        );
        RenderParagraph part(String text) =>
            tester.renderObject<RenderParagraph>(find.text(text));
        expect(part(' · 12m').didExceedMaxLines, isFalse, reason: '×$scale');
        expect(
          part(
            'Waiting on Ken · Please approve the production deployment and '
            'confirm the rollback plan',
          ).didExceedMaxLines,
          isTrue,
          reason: '×$scale',
        );
        expect(tester.takeException(), isNull);
      }
    });

    // In tests every glyph is a square of the font's size (13 points): these
    // rows fit their whole line, with room to spare, at either text size.
    testWidgets('a short part leaves its room to the other: a line that fits '
        'is never cut', (tester) async {
      // Room for the widest row at twice the text size.
      await tester.binding.setSurfaceSize(const Size(1800, 600));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final cases = {
        // A short reason, a long PM action.
        task(
          liveness: state('quiet', 'silent', minute * 34),
          leadAction: {'kind': 'assign', 'at': ago(minute)},
        ): (
          width: 700.0,
          parts: ['Quiet', ' 34m', ' · PM reassigned it 1m ago'],
        ),
        // A long reason, a short PM action.
        task(
          status: 'blocked',
          result: 'Needs the staging token',
          liveness: state('waiting', 'blocked', minute * 5),
          leadAction: {'kind': 'post', 'at': ago(minute)},
        ): (
          width: 800.0,
          parts: [
            'Blocked · Needs the staging token',
            ' · 5m',
            ' · PM posted 1m ago',
          ],
        ),
      };
      for (final MapEntry(key: group, value: (:width, :parts))
          in cases.entries) {
        for (final scale in [1.0, 2.0]) {
          await withClock(
            Clock.fixed(now),
            () => tester.pumpWidget(
              app(
                Center(
                  child: SizedBox(
                    width: width * scale,
                    child: SwarmTaskLine(group),
                  ),
                ),
                scale: scale,
              ),
            ),
          );
          for (final text in parts) {
            expect(
              tester
                  .renderObject<RenderParagraph>(find.text(text))
                  .didExceedMaxLines,
              isFalse,
              reason: '"$text" ×$scale',
            );
          }
          expect(tester.takeException(), isNull);
        }
      }
    });

    testWidgets('when neither fits, the reason and what the PM did are both '
        'cut, never the age', (tester) async {
      final group = task(
        status: 'blocked',
        result: 'Needs the staging token and the release signing key',
        liveness: state('waiting', 'blocked', minute * 5),
        leadAction: {'kind': 'assign', 'at': ago(minute)},
      );
      await withClock(
        Clock.fixed(now),
        () => tester.pumpWidget(
          app(Center(child: SizedBox(width: 400, child: SwarmTaskLine(group)))),
        ),
      );
      RenderParagraph part(String text) =>
          tester.renderObject<RenderParagraph>(find.text(text));
      expect(part(' · 5m').didExceedMaxLines, isFalse);
      expect(
        part('Blocked · Needs the staging token and the release signing key')
            .didExceedMaxLines,
        isTrue,
      );
      expect(part(' · PM reassigned it 1m ago').didExceedMaxLines, isTrue);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a name before the line, as a project\'s work row leads with '
        'its agent, gives way with the reason', (tester) async {
      await withClock(
        Clock.fixed(now),
        () => tester.pumpWidget(
          app(
            SwarmTaskLine(
              task(liveness: state('waiting', 'review', minute * 3)),
              lead: 'Nova',
            ),
          ),
        ),
      );
      expect(line(tester), 'Nova · Waiting for review · 3m');
    });

    testWidgets('its ages keep moving on their own, the state\'s and the '
        'PM\'s, with no other rebuild; gone with its row, no timer is left', (
      tester,
    ) async {
      var at = now;
      final group = task(
        liveness: state('quiet', 'silent', minute * 34),
        leadAction: {'kind': 'post', 'at': ago(minute)},
      );
      await withClock(Clock(() => at), () async {
        await tester.pumpWidget(app(SwarmTaskLine(group)));
        expect(line(tester), 'Quiet 34m · PM posted 1m ago');
        for (final expected in [
          'Quiet 35m · PM posted 2m ago',
          'Quiet 36m · PM posted 3m ago',
        ]) {
          at = at.add(minute);
          await tester.pump(minute + const Duration(milliseconds: 2));
          expect(line(tester), expected);
        }
        await tester.pumpWidget(const SizedBox());
      });
      // The test binding fails a test that leaves a timer pending.
    });

    testWidgets('a working task\'s age moves too, from "just now"', (
      tester,
    ) async {
      var at = now;
      final group = task(progress: const Duration(seconds: 30));
      await withClock(Clock(() => at), () async {
        await tester.pumpWidget(app(SwarmTaskLine(group)));
        expect(line(tester), 'Working · just now');
        at = at.add(const Duration(seconds: 31));
        await tester.pump(const Duration(seconds: 31));
        expect(line(tester), 'Working · 1m ago');
        await tester.pumpWidget(const SizedBox());
      });
    });

    testWidgets('a task with no status draws nothing and keeps no timer', (
      tester,
    ) async {
      await withClock(
        Clock.fixed(now),
        () => tester.pumpWidget(app(SwarmTaskLine(task(status: 'done')))),
      );
      expect(find.byKey(const ValueKey('swarm-task-line-g')), findsNothing);
      expect(find.byKey(const ValueKey('swarm-task-mark-g')), findsNothing);
    });

    testWidgets('a row whose task changes under it reads the new task at '
        'once', (tester) async {
      Future<void> show(SuperTabConversation group) => withClock(
        Clock.fixed(now),
        () => tester.pumpWidget(app(SwarmTaskLine(group))),
      );
      await show(task(liveness: state('quiet', 'silent', minute * 34)));
      expect(line(tester), 'Quiet 34m');
      await show(task(progress: minute));
      expect(line(tester), 'Working · 1m ago');
      await show(task(status: 'done'));
      expect(find.byKey(const ValueKey('swarm-task-line-g')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });
  });

  // The desktop's words for each wait and stuck state, read from its model:
  // a state added or reworded there fails here until the phone says the same.
  test('every wait and stuck state the desktop\'s model names reads the '
      'same words and mark on the phone', () {
    final source = File('../desktop/lib/super_tabs/task_status.dart');
    if (!source.existsSync()) {
      throw StateError(
        '${source.path} missing — run from mobile/ in the monorepo',
      );
    }
    final cases = RegExp(
      r"\('(\w+)', '([\w-]+)'\) => \(\s*HarnessActivity\.(\w+),\s*'([^']*)',?\s*\)",
    ).allMatches(source.readAsStringSync()).toList();
    // review, revision, queued, starting, and three ways to be stuck: fewer
    // means the desktop's table changed shape and this reads too little.
    expect(cases.length, greaterThanOrEqualTo(7));
    for (final match in cases) {
      final [state!, why!, activity!, words!] = [
        for (final i in [1, 2, 3, 4]) match.group(i),
      ];
      final status = swarmTaskStatus(
        task(liveness: {'state': state, 'why': why, 'since': ago(minute * 5)}),
        now,
      );
      expect(status?.reason, words, reason: '$state/$why');
      expect(status?.mark.name, activity, reason: '$state/$why');
    }
  });
}
