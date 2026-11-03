import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/section_heading.dart';

/// The chat header's Members button: the right column opens only from it
/// (Quiet Swarm, Dee, 2026-11-02).
final superTabMembersButton = find.byKey(
  const ValueKey('super-members-button'),
);

/// Opens the Members column of the Swarm view on screen, and with [unfold]
/// the agents folded under Idle (N). [settle] false pumps a few frames
/// instead, for a test that holds a read open.
Future<void> openSuperTabMembers(
  WidgetTester tester, {
  bool settle = true,
  bool unfold = true,
}) async {
  Future<void> wait() async {
    if (settle) {
      await tester.pumpAndSettle();
    } else {
      for (var i = 0; i < 5; i++) {
        await tester.pump();
      }
    }
  }

  await tester.tap(superTabMembersButton);
  await wait();
  if (unfold) await unfoldSuperTabIdle(tester, settle: settle);
}

/// Opens the agents folded under Idle (N), when a fold is there and shut.
Future<void> unfoldSuperTabIdle(
  WidgetTester tester, {
  bool settle = true,
}) async {
  final idle = find.byKey(const ValueKey('super-members-idle'));
  if (idle.evaluate().isEmpty ||
      tester.widget<SuperTabSectionHeading>(idle).collapsed != true) {
    return;
  }
  await tester.tap(
    find.descendant(of: idle, matching: find.textContaining('Idle (')),
  );
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    for (var i = 0; i < 5; i++) {
      await tester.pump();
    }
  }
}
