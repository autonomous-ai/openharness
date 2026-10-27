import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/notify/system_notifications.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/decisions.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/notifications.dart';

import 'super_tab_decisions_test.dart' show notificationsEntry, showView, swarm;
import 'super_tab_mentions_test.dart' show ShownNotices;
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore;

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

  testWidgets(
    'with a request and a decision open, both cards fit in a laptop window',
    (tester) async {
      final server = swarm()
        ..askHandsOn(
          'Put the dial in flashing mode',
          steps: [
            'Plug the dial into the Mac Studio with USB-C',
            'Hold the button while it powers on',
            'Let go when the ring turns blue',
          ],
          conversationId: 'pm-chat',
        )
        ..ask([
          'Keep the old firmware as a fallback?',
        ], conversationId: 'pm-chat');
      tester.view
        ..physicalSize = const Size(1280, 860)
        ..devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await showView(tester, server);
      await tester.tap(find.byKey(const ValueKey('super-pm-chat-lead')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('super-decision-decision-1-0')).hitTestable(),
        findsOneWidget,
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

  group('reminders', () {
    /// The backend's reminder of [request] at [at] ms (decisions.ts escalation).
    void remind(
      Map<String, dynamic> request,
      int at,
      ConversationServer server,
    ) {
      request['remindedAt'] = DateTime.fromMillisecondsSinceEpoch(
        at,
        isUtc: true,
      ).toIso8601String();
      server.state['requestRemindedAt'] = at;
      server.revision++;
    }

    test('a reminder that moves raises one notice naming the request; one already there when the Swarm opens does not', () async {
      final server = swarm()
        ..askHandsOn('Plug in the dial')
        ..ask(['Ship how?']);
      remind(server.handsOn.single, 1000, server);
      final reminded = <String>[];
      final client = SuperTabClient(
        storage: MemoryStore(),
        transport: (method, path, {body}) =>
            server.request(method, path, body: body),
        discoveryInterval: Duration.zero,
        onReminder: (r) =>
            reminded.add('${r.askerName}: ${r.text} · ${r.projectName}'),
      );
      addTearDown(client.dispose);
      client.bind('peer');
      final c = await client.open('tab');
      await c.refresh();
      await pumpEventQueue();
      expect(reminded, isEmpty);

      remind(server.decisions.single, 2000, server);
      await c.refresh();
      await pumpEventQueue();
      expect(reminded, ['Wren: Ship how? · web-project']);
      await c.refresh();
      await pumpEventQueue();
      expect(reminded, hasLength(1));

      remind(server.handsOn.single, 3000, server);
      await c.refresh();
      await pumpEventQueue();
      expect(reminded.last, 'Wren: Plug in the dial · web-project');
    });

    test('only Desktop hands a reminder to the operating system', () async {
      final notices = ShownNotices();
      final store = DesktopNotificationStore(storage: MemoryStore());
      await store.set(true);
      final system = SystemNotifications(store: store, notifier: notices);
      expect(superTabReminderNotice(system, web: true), isNull);
      superTabReminderNotice(system, web: false)!((
        id: 'request-1',
        at: 3000,
        askerName: 'Wren',
        projectName: 'web-project',
        conversationTitle: 'Lead',
        text: 'Plug in the dial',
      ));
      await pumpEventQueue();
      expect(notices.shown, [
        (
          title: 'Wren is still waiting on you',
          body: 'web-project · Lead: Plug in the dial',
        ),
      ]);
    });
  });
}
