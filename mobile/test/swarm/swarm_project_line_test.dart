import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_home_list.dart';
import 'package:harness_mobile/swarm/swarm_home_rows.dart';
import 'package:harness_mobile/swarm/swarm_row.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';
import 'package:harness_mobile/swarm/swarm_unread.dart';
import 'package:harness_mobile/swarm/team_glance.dart';

import 'swarm_fixture.dart';

/// A project's subtitle on Swarm Home: how many humans read it and how many
/// agents are running, leaving out what is none.
void main() {
  final now = DateTime(2026, 10, 27, 9);

  SuperTabSnapshot read({int running = 0, int idle = 0}) {
    final busy = [for (var i = 0; i < running; i++) 'busy-$i'];
    return SuperTabSnapshot.fromJson(
      SuperTabParts.firstLoad(
        firstLoad(
          agents: [
            for (final id in busy) agent(id),
            for (var i = 0; i < idle; i++) agent('idle-$i'),
          ],
          groups: [
            for (final id in busy)
              groupData(
                'work-$id',
                title: 'Task of $id',
                agentIds: [id],
                status: 'working',
                workerId: id,
              ),
          ],
        ),
      ).state,
    );
  }

  SwarmTeamGlance glance({int running = 0, int idle = 0}) =>
      swarmTeamGlance(read(running: running, idle: idle), now: now);

  const line = ValueKey('swarm-project-line');

  Future<void> pump(
    WidgetTester tester, {
    int humans = 0,
    int running = 0,
    String? swarmName,
    double width = 390,
  }) {
    final snapshot = read(running: running);
    return tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          // Scrolled, as Home's rows are: a row takes no more height than it
          // needs.
          body: SingleChildScrollView(
            child: Align(
              alignment: Alignment.topLeft,
              child: SizedBox(
                width: width,
                child: SwarmHomeProjectRow(
                  key: const ValueKey('row'),
                  project: SwarmHomeProject(
                    swarmId: 'tab',
                    project: snapshot.projects.first,
                    active: null,
                    news: swarmNoNews,
                  ),
                  glance: swarmTeamGlance(snapshot, now: now),
                  humans: humans,
                  now: now,
                  swarmName: swarmName,
                  onTap: () {},
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  group('swarmProjectLine', () {
    test('counts humans and the agents running, with a bullet between', () {
      expect(
        swarmProjectLine(humans: 5, glance: glance(running: 8)),
        '5 humans • 8 agents running',
      );
    });

    test('says one human and one agent in the singular', () {
      expect(
        swarmProjectLine(humans: 1, glance: glance(running: 1)),
        '1 human • 1 agent running',
      );
    });

    test('leaves out the agents when none is running, idle or not', () {
      expect(swarmProjectLine(humans: 3, glance: glance()), '3 humans');
      expect(swarmProjectLine(humans: 3, glance: glance(idle: 2)), '3 humans');
    });

    test('leaves out the humans when there are none', () {
      expect(
        swarmProjectLine(humans: 0, glance: glance(running: 2)),
        '2 agents running',
      );
    });

    test('is empty with nothing to say', () {
      expect(swarmProjectLine(humans: 0, glance: glance()), isEmpty);
    });

    test('ends in the Swarm, with or without counts', () {
      expect(
        swarmProjectLine(
          humans: 2,
          glance: glance(running: 3),
          swarmName: 'Acme',
        ),
        '2 humans • 3 agents running • Acme',
      );
      expect(
        swarmProjectLine(humans: 0, glance: glance(), swarmName: 'Acme'),
        'Acme',
      );
    });
  });

  group('the row', () {
    testWidgets('draws the line and no faces', (tester) async {
      await pump(tester, humans: 5, running: 2);

      expect(find.text('5 humans • 2 agents running'), findsOneWidget);
      expect(find.byType(SwarmAvatar), findsNothing);
    });

    testWidgets('with nothing to say draws no line and keeps its height', (
      tester,
    ) async {
      await pump(tester);

      expect(find.byKey(line), findsNothing);
      expect(
        tester.getSize(find.byKey(const ValueKey('row'))).height,
        SwarmRow.height,
      );
    });

    testWidgets('is heard without the bullet', (tester) async {
      final semantics = tester.ensureSemantics();
      await pump(tester, humans: 5, running: 2, swarmName: 'Acme');

      expect(
        find.bySemanticsLabel(RegExp('5 humans, 2 agents running, Acme')),
        findsOneWidget,
      );
      semantics.dispose();
    });

    testWidgets('a long line ellipsizes, the Swarm the first to go', (
      tester,
    ) async {
      await pump(
        tester,
        humans: 12,
        running: 12,
        swarmName: 'A Swarm with a name far too long for one row of a phone',
        width: 240,
      );

      expect(tester.takeException(), isNull);
      final text = tester.widget<Text>(find.byKey(line));
      expect(text.maxLines, 1);
      expect(text.overflow, TextOverflow.ellipsis);
      expect(text.data, startsWith('12 humans • 12 agents running • '));
    });
  });
}
