import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

/// The chat header's Members button: the right column opens only from it
/// (Quiet Swarm, Dee, 2026-11-02).
final superTabMembersButton = find.byKey(
  const ValueKey('super-members-button'),
);

/// Opens the Members column of the Swarm view on screen. [settle] false pumps
/// a few frames instead, for a test that holds a read open.
Future<void> openSuperTabMembers(
  WidgetTester tester, {
  bool settle = true,
}) async {
  await tester.tap(superTabMembersButton);
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    for (var i = 0; i < 5; i++) {
      await tester.pump();
    }
  }
}
