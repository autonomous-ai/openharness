import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_team_line.dart';
import 'package:harness_mobile/swarm/team_glance.dart';

import 'swarm_fixture.dart';

/// A team in one line, drawn: every part, or [SwarmTeamLine.only] some of
/// them — the project's line keeps who is down beside what waits on the
/// person.
void main() {
  SwarmTeamGlance team({bool down = true}) => swarmTeamGlance(
    SuperTabSnapshot.fromJson(
      SuperTabParts.firstLoad(
        firstLoad(
          agents: [
            agent('a-work', displayName: 'Ana'),
            agent('a-wait', displayName: 'Bo'),
            {
              ...agent('a-down', displayName: 'Cy'),
              'downSince': ?(down ? '2026-10-27T08:00:00Z' : null),
            },
          ],
          groups: [
            for (final (id, status) in [
              ('a-work', 'working'),
              ('a-wait', 'needs_human'),
            ])
              groupData(
                'work-$id',
                agentIds: [id],
                status: status,
                workerId: id,
              ),
          ],
        ),
      ).state,
    ),
  );

  Future<void> pump(WidgetTester tester, SwarmTeamLine line) =>
      tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: Center(child: line)),
        ),
      );

  /// What the line reads, dots and no-break spaces as plain spaces.
  String read(WidgetTester tester) => tester
      .widget<RichText>(find.byType(RichText))
      .text
      .toPlainText()
      .replaceAll(' ', ' ');

  testWidgets('draws every part without only', (tester) async {
    await pump(tester, SwarmTeamLine(team()));
    expect(read(tester), '● 1 working ● 1 waiting ● 1 down');
    expect(find.bySemanticsLabel('1 working · 1 waiting · 1 down'), findsOne);
  });

  testWidgets('draws only the parts of the states it names', (tester) async {
    await pump(
      tester,
      SwarmTeamLine(team(), only: const {SwarmAgentState.down}),
    );
    expect(read(tester), '● 1 down');
    expect(
      find.bySemanticsLabel('1 down'),
      findsOne,
      reason: 'it says what it shows, not the whole team',
    );
  });

  testWidgets('none of those it names: nothing, not "All idle"', (
    tester,
  ) async {
    await pump(
      tester,
      SwarmTeamLine(team(down: false), only: const {SwarmAgentState.down}),
    );
    expect(find.byType(RichText), findsNothing);
    expect(find.text('All idle'), findsNothing);
  });

  testWidgets('kept, it reads Updating… whatever it is to show', (
    tester,
  ) async {
    await pump(
      tester,
      SwarmTeamLine(
        team(down: false),
        only: const {SwarmAgentState.down},
        kept: true,
      ),
    );
    expect(find.text('Updating…'), findsOneWidget);
  });
}
