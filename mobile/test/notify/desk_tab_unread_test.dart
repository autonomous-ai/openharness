import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/notify/agent_notice.dart';
import 'package:harness_mobile/notify/agent_unread.dart';
import 'package:harness_mobile/notify/unread_marks.dart';
import 'package:harness_mobile/phone/desk_groups.dart';
import 'package:harness_mobile/phone/desk_tab_strip.dart';

/// A tab says what its agents are carrying, so the person can tell WHICH tab
/// an agent finished in without opening every one of them.
void main() {
  const a = (machineId: 'm', agentId: 'a');
  const b = (machineId: 'm', agentId: 'b');
  const c = (machineId: 'm', agentId: 'c');

  group('mostUrgentOf', () {
    test('a question outranks a finished turn, wherever it sits', () {
      final unread = AgentUnread()
        ..mark(a, NoticeKind.done)
        ..mark(b, NoticeKind.question);
      addTearDown(unread.dispose);
      expect(unread.mostUrgentOf([a, b]), NoticeKind.question);
      expect(unread.mostUrgentOf([a, c]), NoticeKind.done);
      expect(unread.mostUrgentOf([c]), isNull);
      expect(unread.mostUrgentOf(const []), isNull);
    });
  });

  testWidgets('each pill carries its own tab\'s mark, in its kind\'s colour', (
    tester,
  ) async {
    const kinds = {'desk': NoticeKind.done, 'docker': NoticeKind.question};
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: DeskTabStrip(
            groups: const [
              DeskGroup(id: 'desk', name: 'Desktop', entries: []),
              DeskGroup(id: 'docker', name: 'Docker', entries: []),
              DeskGroup(id: 'other', name: 'Other', entries: []),
            ],
            selectedId: 'desk',
            onPick: (_) {},
            unreadFor: (tab) => kinds[tab.id],
          ),
        ),
      ),
    );

    UnreadDot? dotIn(String name) {
      final dot = find.descendant(
        // The pill's own row — the nearest one — not the strip's around it.
        of: find
            .ancestor(of: find.text(name), matching: find.byType(Row))
            .first,
        matching: find.byType(UnreadDot),
      );
      return dot.evaluate().isEmpty
          ? null
          : tester.widget<UnreadDot>(dot.first);
    }

    expect(dotIn('Desktop')?.kind, NoticeKind.done);
    expect(dotIn('Docker')?.kind, NoticeKind.question);
    expect(dotIn('Other'), isNull);
  });
}
