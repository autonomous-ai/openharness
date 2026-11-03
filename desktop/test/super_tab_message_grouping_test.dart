import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/thread_panel.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// Huy, 2026-11-03 (#2419): like Slack, one sender's messages within five
/// minutes of each other share one header, whatever their length; a gap over
/// five minutes, another sender, a new day or a thread reply shown in the
/// chat starts a new one, and hovering a grouped message shows its time.
void main() {
  const buddy = {
    'kind': 'agent',
    'id': 'pm',
    'name': 'Lead',
    'displayName': 'River',
  };
  const ken = {'kind': 'person', 'id': 'ken', 'name': 'ken@example.com'};
  final start = DateTime(2026, 11, 3, 14, 0);

  SuperTabMessage message(
    int n,
    DateTime at, {
    Map<String, Object> author = buddy,
    String text = 'An update.',
    String? thread,
    bool alsoInChat = false,
  }) => SuperTabMessage.fromJson({
    'id': 'm$n',
    'conversationId': 'lead',
    'sequence': n,
    'thread': thread ?? 'm$n',
    if (thread != null) 'replyTo': thread,
    if (alsoInChat) 'alsoInChat': true,
    'text': text,
    'attachments': <dynamic>[],
    'createdAt': at.toUtc().toIso8601String(),
    'author': author,
    'deliveries': <dynamic>[],
  });

  group('the rule', () {
    test('one sender within five minutes groups at any length', () {
      final long = List.filled(40, 'A long report line.').join(' ');
      final messages = [
        message(1, start),
        message(2, start.add(const Duration(minutes: 1)), text: long),
        message(
          3,
          start.add(const Duration(minutes: 2)),
          text: 'Findings:\n- one\n- two',
        ),
        message(4, start.add(const Duration(minutes: 3)), text: 'Merge it?'),
        message(5, start.add(const Duration(minutes: 4))),
        message(6, start.add(const Duration(minutes: 9))),
      ];
      expect(SuperTabMessageRow.consecutiveUpdates(messages), {
        'm2',
        'm3',
        'm4',
        'm5',
        'm6',
      });
    });

    test('a gap over five minutes starts a header', () {
      final first = message(1, start);
      expect(
        SuperTabMessageRow.groupsWith(
          message(2, start.add(const Duration(minutes: 5))),
          first,
        ),
        isTrue,
      );
      expect(
        SuperTabMessageRow.groupsWith(
          message(2, start.add(const Duration(minutes: 5, seconds: 1))),
          first,
        ),
        isFalse,
      );
    });

    test('another sender between starts a header', () {
      final messages = [
        message(1, start),
        message(2, start.add(const Duration(minutes: 1)), author: ken),
        message(3, start.add(const Duration(minutes: 2))),
      ];
      expect(SuperTabMessageRow.consecutiveUpdates(messages), isEmpty);
    });

    test('a new day starts a header', () {
      final late = DateTime(2026, 11, 3, 23, 58);
      expect(
        SuperTabMessageRow.groupsWith(
          message(2, late.add(const Duration(minutes: 3))),
          message(1, late),
        ),
        isFalse,
      );
    });

    test('a thread reply shown in the chat starts a header', () {
      final root = message(1, start);
      final reply = message(
        2,
        start.add(const Duration(minutes: 1)),
        thread: 'm1',
        alsoInChat: true,
      );
      expect(SuperTabMessageRow.groupsWith(reply, root), isFalse);
      expect(
        SuperTabMessageRow.groupsWith(
          message(3, start.add(const Duration(minutes: 2))),
          reply,
        ),
        isFalse,
      );
    });
  });

  group('on screen', () {
    /// Huy's case: three Buddy messages in two minutes, a report and a
    /// question among them, then a reply thread on the first.
    Future<ConversationServer> show(WidgetTester tester) async {
      await tester.binding.setSurfaceSize(const Size(1400, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = ConversationServer()..threads = true;
      (server.state['agents'] as List).add({
        'id': 'pm',
        'projectId': 'lead',
        'name': 'Lead',
        'displayName': 'River',
        'machineId': 'studio',
        'harnessId': 'h-pm',
        'contributorId': 'owner',
        'configuration': {'engine': 'claude', 'model': 'opus'},
      });
      (server.state['people'] as List).add({
        'id': 'ken',
        'email': 'ken@example.com',
        'role': 'collaborator',
      });
      final now = DateTime.now().toUtc();
      void say(
        String text,
        Map<String, Object> author,
        Duration ago, {
        String? thread,
      }) {
        server.append(text);
        server.messages.last
          ..['author'] = author
          ..['createdAt'] = now.subtract(ago).toIso8601String();
        if (thread != null) {
          server.messages.last
            ..['thread'] = thread
            ..['replyTo'] = thread;
        }
      }

      say('Taken. Building it now.', buddy, const Duration(minutes: 30));
      say(
        'Report:\n- tests pass\n- screenshots attached',
        buddy,
        const Duration(minutes: 29),
      );
      say('Shall I merge it?', buddy, const Duration(minutes: 28));
      say('First', ken, const Duration(minutes: 27), thread: 'message-1');
      say('Second', ken, const Duration(minutes: 26), thread: 'message-1');
      say('Later', ken, const Duration(minutes: 10), thread: 'message-1');
      ((server.state['conversations'] as List)[0] as Map)['leadId'] = 'pm';
      final c = server.controller();
      await c.refresh();
      addTearDown(c.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return server;
    }

    testWidgets('three Buddy messages in two minutes share one header', (
      tester,
    ) async {
      await show(tester);
      expect(find.text('River'), findsOneWidget);
      expect(find.text('Shall I merge it?'), findsOneWidget);
    });

    testWidgets('hovering a grouped message shows its time at the left', (
      tester,
    ) async {
      final server = await show(tester);
      final time = find.byKey(const ValueKey('super-row-time-message-3'));
      expect(time, findsNothing);
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      addTearDown(mouse.removePointer);
      final body = find.text('Shall I merge it?');
      await mouse.moveTo(tester.getCenter(body));
      await tester.pumpAndSettle();
      expect(time, findsOneWidget);
      final at = DateTime.parse(server.messages[2]['createdAt'] as String)
          .toLocal();
      final context = tester.element(body);
      expect(
        tester.widget<Text>(time).data,
        TimeOfDay.fromDateTime(at).format(context),
      );
      expect(tester.getRect(time).right, lessThan(tester.getRect(body).left));
    });

    testWidgets('the thread view groups replies by the same rule', (
      tester,
    ) async {
      await show(tester);
      await tester.tap(
        find.byKey(const ValueKey('super-thread-line-message-1')),
      );
      await tester.pumpAndSettle();
      final panel = find.byType(SuperTabThreadPanel);
      // Two replies a minute apart share a header; one 16 minutes later
      // starts its own.
      expect(
        find.descendant(of: panel, matching: find.text('ken')),
        findsNWidgets(2),
      );
    });
  });
}
