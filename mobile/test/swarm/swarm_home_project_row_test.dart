import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_home_list.dart';
import 'package:harness_mobile/swarm/swarm_home_rows.dart';

import 'swarm_fixture.dart';

/// A project on Swarm Home, one line as Slack's channels (2026-11-03): its
/// #name — bold with something new, a dot at its end; no Swarm on it,
/// as Home heads each Swarm's projects with its name. No dot, no second line, no time.
void main() {
  final now = DateTime(2026, 10, 27, 9);

  SuperTabSnapshot read({int running = 0, String name = 'Mobile'}) {
    final busy = [for (var i = 0; i < running; i++) 'busy-$i'];
    return SuperTabSnapshot.fromJson(
      SuperTabParts.firstLoad(
        firstLoad(
          head: headData(
            projects: [
              {
                'id': project,
                'name': name,
                'ownerId': me,
                'leadConversationId': leadChat,
                'visibility': 'public',
                'members': <Object>[],
                'updateMinutes': 5,
              },
            ],
          ),
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
    String name = 'Mobile',
    bool unread = false,
    DateTime? active,
    double width = 390,
    VoidCallback? onTap,
    VoidCallback? onLongPress,
  }) {
    final snapshot = read(running: running, name: name);
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
                    unread: unread,
                  ),
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

  testWidgets("no dot for how its team is, working or idle: the name starts "
      "at the row's inset", (tester) async {
    for (final running in [0, 1]) {
      await pump(tester, running: running);

      expect(dots(), findsNothing, reason: '$running running');
      expect(find.byKey(const ValueKey('swarm-project-dot')), findsNothing);
      expect(tester.getTopLeft(name).dx, AppSpace.l);
    }
  });

  testWidgets('quiet, the name in the second ink, not bold', (tester) async {
    await pump(tester);

    final style = nameText(tester).style!;
    expect(style.color, AppPalette.textSecondary);
    expect(style.fontWeight, isNot(FontWeight.w600));
    expect(find.byKey(const ValueKey('swarm-project-unread')), findsNothing);
  });

  testWidgets('something new: bold in the main ink, heard as unread, with a '
      "dot at its end (anh Dee's mockup, 2026-11-04)", (tester) async {
    final semantics = tester.ensureSemantics();
    await pump(tester, unread: true);

    final style = nameText(tester).style!;
    expect(style.color, AppPalette.textPrimary);
    expect(style.fontWeight, FontWeight.w600);
    expect(find.bySemanticsLabel(RegExp('Unread messages')), findsOneWidget);
    final unread = find.byKey(const ValueKey('swarm-project-unread'));
    expect(unread, findsOneWidget);
    final rowBox = tester.getRect(find.byKey(row));
    expect(
      tester.getRect(unread).right,
      greaterThan(rowBox.right - 40),
      reason: "at the row's end",
    );
    semantics.dispose();
  });

  testWidgets('has no Swarm on it: one heading per Swarm says it (anh Dee, '
      '2026-11-04)', (tester) async {
    final semantics = tester.ensureSemantics();
    await pump(tester);

    final text = nameText(tester);
    expect(text.textSpan!.toPlainText(), '#Mobile');
    expect(text.semanticsLabel, '#Mobile');
    semantics.dispose();
  });

  testWidgets('a long name ellipsizes on its one line', (tester) async {
    await pump(
      tester,
      name: 'a project with a name far too long for one row of a phone',
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
