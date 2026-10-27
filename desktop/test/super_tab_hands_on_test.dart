import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/decisions.dart';
import 'package:harness/super_tabs/model.dart';

import 'super_tab_decisions_test.dart' show notificationsEntry, showView, swarm;

Finder answer(String id, String kind) =>
    find.byKey(ValueKey('super-hands-on-$id-$kind'));

void main() {
  final panel = find.byKey(const ValueKey('super-pm-decisions'));

  test('the badge counts hands-on requests beside decisions', () {
    final server = swarm()
      ..ask(['Ship how?'])
      ..askHandsOn('Plug in the dial');
    final snapshot = SuperTabSnapshot.fromJson(server.state);
    expect(snapshot.decisionsWaiting, 1);
    expect(snapshot.handsOnWaiting, 1);
  });

  test(
    'an older backend that has no hands-on requests still lists decisions',
    () async {
      final server = swarm()
        ..ask(['Ship how?'])
        ..handsOnMissing = true;
      final controller = server.controller(account: 'peer');
      addTearDown(controller.dispose);
      final decisions = SuperTabDecisions.of(controller);
      await controller.refresh();
      await decisions.load();
      expect(decisions.open.single.question, 'Ship how?');
      expect(decisions.handsOnOpen, isEmpty);
      expect(decisions.error, isNull);
    },
  );

  testWidgets(
    'Chat with PM shows the steps and what happens next; Done answers it',
    (tester) async {
      final server = swarm()
        ..askHandsOn('Plug in the dial', conversationId: 'pm-chat')
        ..ask(['Ship how?'], conversationId: 'pm-chat');
      await showView(tester, server);
      expect(
        find.descendant(of: notificationsEntry(), matching: find.text('2')),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('super-pm-chat-lead')));
      await tester.pumpAndSettle();
      for (final text in [
        'Plug in the dial',
        '1. Plug in the device',
        '2. Press its button',
        'Then: I flash the firmware',
        'Ship how?',
      ]) {
        expect(
          find.descendant(of: panel, matching: find.text(text)),
          findsOneWidget,
        );
      }
      // Hands-on first: a person's hands block the work outright.
      expect(
        tester.getTopLeft(find.text('Plug in the dial')).dy,
        lessThan(tester.getTopLeft(find.text('Ship how?')).dy),
      );

      await tester.tap(answer('request-1', 'done'));
      await tester.pumpAndSettle();
      expect(server.posts.last['command'], {
        'type': 'handsOn.answer',
        'requestId': 'request-1',
        'answer': 'done',
      });
      expect(
        find.descendant(of: panel, matching: find.text('Plug in the dial')),
        findsNothing,
      );
    },
  );

  testWidgets("Can't now takes an optional time and note", (tester) async {
    final server = swarm()..askHandsOn('Plug in the dial');
    await showView(tester, server);
    await tester.tap(notificationsEntry());
    await tester.pumpAndSettle();
    expect(find.text('Hands-on requests'), findsOneWidget);
    await tester.tap(answer('request-1', 'cant'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('In an hour'));
    await tester.enterText(
      find.byKey(const ValueKey('super-hands-on-note')),
      'In a meeting',
    );
    final asked = DateTime.now();
    await tester.tap(find.widgetWithText(TextButton, 'Send'));
    await tester.pumpAndSettle();
    final sent = server.posts.last['command'] as Map;
    expect(sent['answer'], 'cant');
    expect(sent['note'], 'In a meeting');
    final until = DateTime.parse(sent['until'] as String);
    expect(until.isUtc, isTrue);
    expect(until.difference(asked).inMinutes, inInclusiveRange(59, 60));
    expect(find.textContaining("You answered: Can't now"), findsOneWidget);
  });

  testWidgets('a note answer needs the note', (tester) async {
    final server = swarm()..askHandsOn('Sign in to the App Store');
    await showView(tester, server);
    await tester.tap(notificationsEntry());
    await tester.pumpAndSettle();
    await tester.tap(answer('request-1', 'note'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Send'));
    await tester.pumpAndSettle();
    expect(find.text('Write the note.'), findsOneWidget);
    expect(server.posts, isEmpty);
    await tester.enterText(
      find.byKey(const ValueKey('super-hands-on-note')),
      'Use the team account',
    );
    await tester.tap(find.widgetWithText(TextButton, 'Send'));
    await tester.pumpAndSettle();
    expect(server.posts.last['command'], {
      'type': 'handsOn.answer',
      'requestId': 'request-1',
      'answer': 'note',
      'note': 'Use the team account',
    });
  });
}
