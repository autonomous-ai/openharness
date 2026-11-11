import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/chat/chat_card.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'support/super_tab_fixture.dart';

/// Task #4529 (anh Dee's mockup, 11-07): no walls of text. A card is a label,
/// one title line and one blue action. A long message shows whole, never
/// folded behind More (anh Dee, 2026-11-09).
void main() {
  group('a long message', () {
    final long = [for (var i = 1; i <= 14; i++) 'Line $i of the plan.']
        .join('\n\n');

    testWidgets('from an agent shows whole, never folded behind More', (
      tester,
    ) async {
      final server = ConversationServer.chat()..append(long, agent: true);
      await showView(tester, server);
      expect(find.text('More'), findsNothing);
      expect(find.text('Line 14 of the plan.').hitTestable(), findsOneWidget);
    });

    testWidgets('from a person shows whole too', (tester) async {
      final server = ConversationServer.chat()..append(long);
      await showView(tester, server);
      expect(find.text('More'), findsNothing);
      expect(find.text('Line 14 of the plan.').hitTestable(), findsOneWidget);
    });
  });

  group('by keyboard', () {
    /// Focuses the control drawing [label] and presses Enter on it.
    Future<void> press(WidgetTester tester, String label) async {
      Focus.of(tester.element(find.text(label))).requestFocus();
      await tester.pump();
      expect(
        Focus.of(tester.element(find.text(label))).hasPrimaryFocus,
        isTrue,
        reason: '$label takes focus',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
    }

    testWidgets("a card's action opens with Enter", (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SwarmChatCard(
              icon: Icons.send,
              label: 'PR #4 · deehw',
              title: 'Faces',
              action: 'Read',
              details: const Text('Give every agent a face.'),
            ),
          ),
        ),
      );
      await press(tester, 'Read');
      expect(find.text('Give every agent a face.'), findsOneWidget);
    });
  });
}
