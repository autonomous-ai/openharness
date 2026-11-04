import 'package:clock/clock.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/reminders.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

const _question = 'Should a reminder clear when it is opened?';

/// Three messages in the Lead conversation, the last an agent's question,
/// read to the end.
ConversationServer _chat() {
  final server = ConversationServer();
  server.append('Planning the reminders');
  server.append('Draft PR is up');
  server.append(_question);
  server.messages.last['author'] = {
    'kind': 'agent',
    'id': 'lead-agent',
    'name': 'Avocet',
  };
  return server..markReadElsewhere('lead', 3);
}

void main() {
  late SuperTabController c;
  late List<String> arrived;

  Future<void> show(WidgetTester tester, ConversationServer server) async {
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    c = server.controller();
    arrived = [];
    SuperTabReminders.of(c).onArrived = (r) => arrived.add(r.id);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Team Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    addTearDown(c.dispose);
  }

  Finder row(String id) => find.byKey(ValueKey('super-message-$id'));

  /// Past every reminder set: the timer waiting for the next one ends.
  Future<void> passReminders(WidgetTester tester) async {
    await tester.pump(const Duration(days: 2));
    await tester.pumpAndSettle();
  }

  Future<void> remind(WidgetTester tester, String id, String choice) async {
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(row(id)));
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: row(id),
        matching: find.byKey(ValueKey('super-message-more-$id')),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Remind me'));
    await tester.pumpAndSettle();
    await tester.tap(find.text(choice));
    await tester.pumpAndSettle();
    await mouse.removePointer();
    await tester.pumpAndSettle();
  }

  Future<void> openActivity(WidgetTester tester) async {
    await tester.tap(find.text('Activity').first);
    await tester.pumpAndSettle();
  }

  Finder reminderRow(String messageId) =>
      find.byKey(ValueKey('super-activity-row-reminder:reminder-$messageId'));

  group('Remind me', () {
    testWidgets('In 20 minutes asks for the time 20 minutes on', (
      tester,
    ) async {
      final server = _chat();
      await show(tester, server);
      final asked = clock.now();
      await remind(tester, 'message-3', 'In 20 minutes');
      expect(server.reminderWrites, hasLength(1));
      final write = server.reminderWrites.single;
      expect(write['method'], 'PUT');
      expect(write['conversationId'], 'lead');
      expect(write['messageId'], 'message-3');
      final at = DateTime.parse(write['at'] as String);
      expect(
        at.difference(asked).inSeconds,
        inInclusiveRange(20 * 60, 20 * 60 + 5),
      );
      // The menu closes after a choice.
      expect(find.text('In 20 minutes'), findsNothing);
      await passReminders(tester);
    });

    testWidgets('In 1 hour and Tomorrow at 09:00 are in the reader\'s time', (
      tester,
    ) async {
      final server = _chat();
      await show(tester, server);
      final asked = clock.now();
      await remind(tester, 'message-2', 'In 1 hour');
      await remind(tester, 'message-3', 'Tomorrow at 09:00');
      final [hour, tomorrow] = [
        for (final w in server.reminderWrites)
          DateTime.parse(w['at'] as String),
      ];
      expect(hour.difference(asked).inSeconds, inInclusiveRange(3600, 3605));
      expect(
        tomorrow.toLocal(),
        DateTime(asked.year, asked.month, asked.day + 1, 9),
      );
      await passReminders(tester);
    });
  });

  testWidgets('a due reminder shows once under Reminders in Activity, with one '
      'notice, and opening it clears it', (tester) async {
    final server = _chat();
    server.remindElsewhere(
      'message-3',
      clock.now().add(const Duration(minutes: 20)),
    );
    await show(tester, server);
    await openActivity(tester);
    expect(find.text('Reminders'), findsNothing);
    expect(reminderRow('message-3'), findsNothing);

    // Nothing polls: the list is read again when the reminder is due.
    final reads = server.reminderReads.length;
    await tester.pump(const Duration(minutes: 19));
    expect(server.reminderReads, hasLength(reads));
    await tester.pump(const Duration(minutes: 1, seconds: 1));
    await tester.pumpAndSettle();
    expect(server.reminderReads, hasLength(reads + 1));

    expect(find.text('Reminders'), findsOneWidget);
    expect(reminderRow('message-3'), findsOneWidget);
    expect(
      find.descendant(
        of: reminderRow('message-3'),
        matching: find.text('Avocet: $_question'),
      ),
      findsOneWidget,
    );
    expect(arrived, ['reminder-message-3']);

    // Read again, it is still one row and no second notice.
    await SuperTabReminders.of(c).load();
    await c.refresh();
    await tester.pumpAndSettle();
    expect(reminderRow('message-3'), findsOneWidget);
    expect(arrived, ['reminder-message-3']);

    await tester.tap(reminderRow('message-3'));
    await tester.pumpAndSettle();
    expect(server.reminderWrites.last, {
      'method': 'DELETE',
      'conversationId': 'lead',
      'messageId': 'message-3',
    });
    expect(server.reminders, isEmpty);
    expect(c.selectedId, 'lead');
    expect(find.text(_question), findsOneWidget);
    await openActivity(tester);
    expect(reminderRow('message-3'), findsNothing);
    expect(find.text('Reminders'), findsNothing);
  });

  testWidgets('a reminder set again on the same message notifies again', (
    tester,
  ) async {
    final server = _chat();
    await show(tester, server);
    final reminders = SuperTabReminders.of(c);
    server.remindElsewhere(
      'message-3',
      clock.now().add(const Duration(minutes: 1)),
    );
    await c.refresh();
    await tester.pump(const Duration(minutes: 1, seconds: 2));
    await tester.pumpAndSettle();
    expect(arrived, ['reminder-message-3']);
    await reminders.open(reminders.due.single);
    await tester.pumpAndSettle();

    // Snoozed again, with no time in between: one more notice when due.
    server.remindElsewhere(
      'message-3',
      clock.now().add(const Duration(minutes: 1)),
    );
    await c.refresh();
    await tester.pump(const Duration(minutes: 1, seconds: 2));
    await tester.pumpAndSettle();
    expect(arrived, ['reminder-message-3', 'reminder-message-3']);
  });

  testWidgets('a reminder due while the timer was held (the Mac asleep) is '
      'read at the next Swarm read', (tester) async {
    final server = _chat();
    await show(tester, server);
    server.remindElsewhere(
      'message-2',
      clock.now().add(const Duration(minutes: 5)),
    );
    await c.refresh();
    await tester.pumpAndSettle();
    final reads = server.reminderReads.length;
    // The clock passes the time without the timer firing, as after sleep.
    await withClock(
      Clock.fixed(clock.now().add(const Duration(minutes: 6))),
      () async {
        await c.refresh();
        await tester.pumpAndSettle();
      },
    );
    expect(server.reminderReads.length, greaterThan(reads));
    expect(SuperTabReminders.of(c).due.map((r) => r.id), [
      'reminder-message-2',
    ]);
    await tester.pump(const Duration(minutes: 6));
    await tester.pumpAndSettle();
  });

  testWidgets('a reminder set on another device wakes this one at its time', (
    tester,
  ) async {
    final server = _chat();
    await show(tester, server);
    server.remindElsewhere(
      'message-2',
      clock.now().add(const Duration(hours: 1)),
    );
    await c.refresh();
    await tester.pumpAndSettle();
    expect(SuperTabReminders.of(c).due, isEmpty);
    await tester.pump(const Duration(hours: 1, seconds: 1));
    await tester.pumpAndSettle();
    expect(SuperTabReminders.of(c).due.map((r) => r.id), [
      'reminder-message-2',
    ]);
    expect(arrived, ['reminder-message-2']);
  });
}
