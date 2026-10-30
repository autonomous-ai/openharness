import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' show AppGlass;
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_home_rows.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';
import 'package:harness_mobile/swarm/team_glance.dart';

import 'swarm_fixture.dart';

/// A project's subtitle on Swarm Home: up to five faces, each over the one
/// before it, then how many agents are running.
void main() {
  final now = DateTime(2026, 10, 27, 9);

  SwarmTeamGlance glance({int running = 0, int idle = 0}) {
    final busy = [for (var i = 0; i < running; i++) 'busy-$i'];
    return swarmTeamGlance(
      SuperTabSnapshot.fromJson(
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
      ),
      now: now,
    );
  }

  List<SuperTabPerson> people(int count) => [
    for (var i = 0; i < count; i++)
      SuperTabPerson.fromJson({...person('p$i'), 'username': 'name$i'}),
  ];

  Finder face(int i) => find.byKey(ValueKey('swarm-team-face-p$i'));

  Future<void> pump(
    WidgetTester tester,
    SwarmTeamFaces faces, {
    double width = 300,
  }) => tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Align(
          alignment: Alignment.topLeft,
          child: SizedBox(width: width, child: faces),
        ),
      ),
    ),
  );

  testWidgets('draws five faces at most, the first five', (tester) async {
    await pump(tester, SwarmTeamFaces(glance(), people: people(7)));

    for (var i = 0; i < 5; i++) {
      expect(face(i), findsOneWidget, reason: 'face $i');
    }
    expect(face(5), findsNothing);
    expect(face(6), findsNothing);
  });

  testWidgets('each face overlaps the one before it and is drawn over it', (
    tester,
  ) async {
    await pump(tester, SwarmTeamFaces(glance(), people: people(5)));

    for (var i = 1; i < 5; i++) {
      final step =
          tester.getTopLeft(face(i)).dx - tester.getTopLeft(face(i - 1)).dx;
      expect(step, greaterThan(0), reason: 'to the right of the one before');
      expect(
        step,
        lessThan(tester.getSize(face(i - 1)).width),
        reason: 'overlapping the one before',
      );
    }
    final painted = [
      for (final child
          in tester
              .widget<Stack>(
                find.descendant(
                  of: find.byKey(const ValueKey('swarm-team-faces')),
                  matching: find.byType(Stack),
                ),
              )
              .children)
        ((child as Positioned).child.key! as ValueKey<String>).value,
    ];
    expect(painted, [
      for (var i = 0; i < 5; i++) 'swarm-team-face-p$i',
    ], reason: 'a Stack paints its last child on top');
    expect(
      tester.widget<SwarmAvatar>(face(1)).ring,
      AppGlass.rowFill,
      reason: "the row's colour cuts each face into the one under it",
    );
  });

  testWidgets('the faces are as wide as they are many, the count after them', (
    tester,
  ) async {
    await pump(tester, SwarmTeamFaces(glance(running: 2), people: people(2)));

    final faces = find.byKey(const ValueKey('swarm-team-faces'));
    expect(
      tester.getTopRight(faces).dx,
      tester.getTopRight(face(1)).dx,
      reason: 'no gap kept for faces that are not there',
    );
    expect(
      tester.getTopLeft(find.text('2 agents running')).dx,
      greaterThan(tester.getTopRight(faces).dx),
    );
  });

  testWidgets('a face wears the person: their picture and their initial', (
    tester,
  ) async {
    final wearing = SuperTabPerson.fromJson({
      ...person('p0'),
      'username': 'river',
      'avatar': {'kind': 'preset', 'key': 'fox'},
    });
    await pump(tester, SwarmTeamFaces(glance(), people: [wearing]));

    final avatar = tester.widget<SwarmAvatar>(face(0));
    expect(avatar.id, 'p0');
    expect(avatar.name, 'river');
    expect((avatar.picture! as SuperTabPresetAvatar).key, 'fox');
    expect(avatar.status, isNull, reason: 'no status at this size');
  });

  testWidgets('no people: only the count, with no gap before it', (
    tester,
  ) async {
    await pump(tester, SwarmTeamFaces(glance(running: 1), people: const []));

    expect(find.byKey(const ValueKey('swarm-team-faces')), findsNothing);
    expect(tester.getTopLeft(find.text('1 agent running')).dx, 0);
  });

  testWidgets(
    'with several Swarms, the Swarm comes after the count, the first to go',
    (tester) async {
      await pump(
        tester,
        SwarmTeamFaces(
          glance(running: 3),
          people: people(1),
          swarmName: 'Acme',
        ),
      );

      expect(find.text('3 agents running · Acme'), findsOneWidget);
    },
  );

  testWidgets('heard as the names and the count, never the faces one by one', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await pump(
      tester,
      SwarmTeamFaces(glance(running: 2), people: people(7), swarmName: 'Acme'),
    );

    expect(
      find.bySemanticsLabel(
        'name0, name1, name2, name3, name4, 2 agents running · Acme',
      ),
      findsOneWidget,
    );
    semantics.dispose();
  });

  testWidgets('a long line ellipsizes rather than pushing the faces out', (
    tester,
  ) async {
    await pump(
      tester,
      SwarmTeamFaces(
        glance(running: 12),
        people: people(5),
        swarmName: 'A Swarm with a name far too long for one row of a phone',
      ),
      width: 180,
    );

    expect(tester.takeException(), isNull);
    expect(
      tester.getTopRight(face(4)).dx,
      lessThan(180),
      reason: 'the faces keep their room',
    );
    final line = tester.widget<Text>(find.textContaining('12 agents running'));
    expect(line.overflow, TextOverflow.ellipsis);
    expect(
      line.data,
      startsWith('12 agents running'),
      reason: 'what is cut is the Swarm, never the count',
    );
  });
}
