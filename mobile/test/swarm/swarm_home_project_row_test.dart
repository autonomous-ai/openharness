import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_home_list.dart';
import 'package:harness_mobile/swarm/swarm_home_rows.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';
import 'package:harness_mobile/swarm/swarm_unread.dart';
import 'package:harness_mobile/swarm/team_glance.dart';

import 'swarm_fixture.dart';

/// A project on Swarm Home, one line as Slack's channels (2026-11-03): its
/// dot, its #name — bold with something new — its Swarm where Home shows
/// several, and its tags at the end. No second line, no time, no unread dot.
void main() {
  final now = DateTime(2026, 10, 27, 9);

  SuperTabSnapshot read({int running = 0}) {
    final busy = [for (var i = 0; i < running; i++) 'busy-$i'];
    return SuperTabSnapshot.fromJson(
      SuperTabParts.firstLoad(
        firstLoad(
          agents: [for (final id in busy) agent(id)],
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

  const row = ValueKey('row');
  final name = find.byKey(const ValueKey('swarm-project-name'));

  Future<void> pump(
    WidgetTester tester, {
    int running = 0,
    String? swarmName,
    SwarmProjectNews news = swarmNoProjectNews,
    bool tagsLoading = false,
    DateTime? active,
    double width = 390,
    VoidCallback? onTap,
    VoidCallback? onLongPress,
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
                  key: row,
                  project: SwarmHomeProject(
                    swarmId: 'tab',
                    project: snapshot.projects.first,
                    active: active,
                    news: news,
                  ),
                  glance: swarmTeamGlance(snapshot, now: now),
                  swarmName: swarmName,
                  tagsLoading: tagsLoading,
                  onTap: onTap ?? () {},
                  onLongPress: onLongPress,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Text nameText(WidgetTester tester) => tester.widget<Text>(name);

  testWidgets('is one line, a thumb tall: no humans line and no time', (
    tester,
  ) async {
    await pump(tester, running: 2, active: now);

    expect(tester.getSize(find.byKey(row)).height, minTouchTarget);
    expect(SwarmHomeProjectRow.height, minTouchTarget);
    expect(find.textContaining('human'), findsNothing);
    expect(find.textContaining('running'), findsNothing);
    expect(find.text('now'), findsNothing, reason: 'no time on the row');
    expect(nameText(tester).maxLines, 1);
    expect(find.byKey(const ValueKey('swarm-project-dot')), findsOneWidget);
  });

  /// The round marks in the row.
  Finder dots() => find.descendant(
    of: find.byKey(row),
    matching: find.byWidgetPredicate(
      (w) =>
          w is Container &&
          w.decoration is BoxDecoration &&
          (w.decoration! as BoxDecoration).shape == BoxShape.circle,
    ),
  );

  Color? dotColor(WidgetTester tester) =>
      (tester.widget<Container>(dots()).decoration! as BoxDecoration).color;

  testWidgets('its team idle: no dot, its place kept so the names stay in '
      'line', (tester) async {
    await pump(tester, running: 1);
    expect(dots(), findsOneWidget);
    final dotted = tester.getTopLeft(name).dx;

    await pump(tester);

    expect(
      dots(),
      findsNothing,
      reason: 'a faint dot on every row said nothing',
    );
    expect(
      tester.getSize(find.byKey(const ValueKey('swarm-project-dot'))).width,
      16,
    );
    expect(tester.getTopLeft(name).dx, dotted);
  });

  testWidgets('its dot: green while its team works, yellow with a tag waiting '
      'on the person though the team is idle', (tester) async {
    await pump(tester, running: 1);
    expect(dotColor(tester), swarmStateColor(SwarmAgentState.working));

    await pump(tester, news: (bold: false, tags: 1, hasWaitingTag: false));
    expect(dotColor(tester), swarmStateColor(SwarmAgentState.waiting));
  });

  testWidgets('quiet, the name in the second ink, not bold', (tester) async {
    await pump(tester);

    final style = nameText(tester).style!;
    expect(style.color, AppPalette.textSecondary);
    expect(style.fontWeight, isNot(FontWeight.w600));
    expect(find.byType(SwarmTags), findsNothing);
  });

  testWidgets('something new: bold in the main ink, heard as unread, with no '
      'dot at its end', (tester) async {
    final semantics = tester.ensureSemantics();
    await pump(
      tester,
      running: 1,
      news: (bold: true, tags: 0, hasWaitingTag: false),
    );

    final style = nameText(tester).style!;
    expect(style.color, AppPalette.textPrimary);
    expect(style.fontWeight, FontWeight.w600);
    expect(find.bySemanticsLabel(RegExp('Unread messages')), findsOneWidget);
    // Only the team's dot at its start: the unread dot is gone.
    final dots = find.descendant(
      of: find.byKey(row),
      matching: find.byWidgetPredicate(
        (w) =>
            w is Container &&
            w.decoration is BoxDecoration &&
            (w.decoration! as BoxDecoration).shape == BoxShape.circle,
      ),
    );
    expect(dots, findsOneWidget);
    semantics.dispose();
  });

  testWidgets('tags waiting: @N filled at its end, the name bright', (
    tester,
  ) async {
    await pump(tester, news: (bold: false, tags: 2, hasWaitingTag: true));

    final tags = tester.widget<SwarmTags>(find.byType(SwarmTags));
    expect(tags.filled, isTrue);
    expect(nameText(tester).style!.color, AppPalette.textPrimary);
    final rowBox = tester.getRect(find.byKey(row));
    expect(
      tester.getRect(find.byType(SwarmTags)).right,
      greaterThan(rowBox.right - 40),
      reason: 'at the row\'s end',
    );
  });

  testWidgets('tags on their way: a skeleton in their place', (tester) async {
    await pump(tester, tagsLoading: true);

    expect(
      find.byKey(const ValueKey('swarm-project-tags-loading')),
      findsOneWidget,
    );
    expect(find.byType(Skeleton), findsOneWidget);
  });

  testWidgets('with several Swarms, its Swarm follows the name, faint, and '
      'is heard after it', (tester) async {
    final semantics = tester.ensureSemantics();
    await pump(tester, swarmName: 'Acme');

    final text = nameText(tester);
    final swarm = text.textSpan!.toPlainText();
    expect(swarm, endsWith('  Acme'));
    expect(text.semanticsLabel, endsWith(', Acme'));
    semantics.dispose();
  });

  testWidgets('a long name ellipsizes on its one line, the Swarm the first to '
      'go', (tester) async {
    await pump(
      tester,
      swarmName: 'A Swarm with a name far too long for one row of a phone',
      width: 240,
    );

    expect(tester.takeException(), isNull);
    final text = nameText(tester);
    expect(text.maxLines, 1);
    expect(text.overflow, TextOverflow.ellipsis);
    expect(text.textSpan!.toPlainText(), startsWith('#'));
    expect(tester.getSize(find.byKey(row)).height, minTouchTarget);
  });

  testWidgets('a tap opens it, a long press offers its pin', (tester) async {
    var taps = 0, presses = 0;
    await pump(tester, onTap: () => taps++, onLongPress: () => presses++);

    await tester.tap(find.byKey(row));
    await tester.longPress(find.byKey(row));

    expect(taps, 1);
    expect(presses, 1);
  });
}
