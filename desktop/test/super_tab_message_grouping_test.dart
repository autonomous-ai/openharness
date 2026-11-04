import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/thread_panel.dart';
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_MESSAGE_GROUPING_SHOTS'];

/// Huy, 2026-11-03 (#2419): like Slack, one sender's messages within five
/// minutes of each other share one header, whatever their length; a gap over
/// five minutes, another sender, a new day or a thread reply shown in the
/// chat starts a new one, and hovering a grouped message shows its time.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

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
    Map<String, Object?>? source,
  }) => SuperTabMessage.fromJson({
    'id': 'm$n',
    'conversationId': 'lead',
    'sequence': n,
    'thread': thread ?? 'm$n',
    'replyTo': ?thread,
    if (alsoInChat) 'alsoInChat': true,
    'text': text,
    'attachments': <dynamic>[],
    'createdAt': at.toUtc().toIso8601String(),
    'author': author,
    'deliveries': <dynamic>[],
    'source': ?source,
  });

  // The rows view.dart draws for themselves, with no header to join (Diego,
  // #2547).
  const routeLine = <String, Object?>{
    'kind': 'route',
    'decisionId': 'decision-1',
    'via': 'order',
    'why': 'Desktop chat grouping fix',
    'pick': {'id': 'c0', 'title': 'New agent · Claude opus high · Mac Studio'},
    'alternatives': <Object?>[],
  };
  const ownRows = <String, Map<String, Object?>>{
    'route': routeLine,
    'terminal input': {'kind': 'terminal-input'},
    'terminal alert': {
      'kind': 'terminal-alert',
      'alert': 'prompt',
      'agentId': 'pm',
    },
    'ship': {'kind': 'ship', 'title': 'Shipped it'},
  };

  group('the rule', () {
    // Its header is the row's mark that it is a task (#2552), and a message
    // after it is not part of that task.
    for (final kind in ['task-line', 'buddy-proposal']) {
      test('a $kind root stands on its own, on either side', () {
        final messages = [
          message(1, start),
          message(
            2,
            start.add(const Duration(minutes: 1)),
            source: {'kind': kind},
          ),
          message(
            3,
            start.add(const Duration(minutes: 2)),
            source: {'kind': kind},
          ),
          message(4, start.add(const Duration(minutes: 3))),
        ];
        expect(SuperTabMessageRow.consecutiveUpdates(messages), isEmpty);
      });
    }

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

    test('a long run shows its name again every twenty rows', () {
      // So the chat can cut its oldest rows at a name (view.dart).
      final messages = [
        for (var i = 0; i < 45; i++)
          message(i, start.add(Duration(seconds: 10 * i))),
      ];
      final joined = SuperTabMessageRow.consecutiveUpdates(messages);
      expect(
        [
          for (final m in messages)
            if (!joined.contains(m.id)) m.id,
        ],
        ['m0', 'm20', 'm40'],
      );
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

    for (final MapEntry(key: line, value: source) in ownRows.entries) {
      group('after a $line line from the same sender', () {
        final person = message(1, start, author: ken);
        final row = message(
          2,
          start.add(const Duration(seconds: 20)),
          source: source,
        );
        final plan = message(3, start.add(const Duration(seconds: 30)));

        test('the next message starts a header', () {
          expect(
            SuperTabMessageRow.consecutiveUpdates([person, row, plan]),
            isNot(contains('m3')),
          );
          expect(SuperTabMessageRow.groupsWith(plan, row), isFalse);
        });

        test('the next reply in a thread starts a header', () {
          expect(
            SuperTabMessageRow.groupsWith(plan, row, inThread: true),
            isFalse,
          );
        });

        test('the line joins nothing above it', () {
          expect(
            SuperTabMessageRow.groupsWith(
              message(
                4,
                start.add(const Duration(seconds: 40)),
                source: source,
              ),
              plan,
            ),
            isFalse,
          );
        });
      });
    }

    test('two plain messages ten seconds apart still group', () {
      expect(
        SuperTabMessageRow.groupsWith(
          message(2, start.add(const Duration(seconds: 10))),
          message(1, start),
        ),
        isTrue,
      );
    });

    test('a plain message that only looks like a line still groups', () {
      // A route source the row cannot read draws as a plain message.
      expect(
        SuperTabMessageRow.groupsWith(
          message(2, start.add(const Duration(seconds: 10))),
          message(
            1,
            start,
            source: const {'kind': 'route', 'decisionId': 'decision-1'},
          ),
        ),
        isTrue,
      );
    });
  });

  group('after a routing line', () {
    /// Diego's case: a person asks, then the PM's routing line and its plan.
    Future<void> show(
      WidgetTester tester, {
      Brightness brightness = Brightness.light,
      Key? picture,
    }) async {
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
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
      void say(
        String text,
        Map<String, Object> author,
        Duration after, {
        Map<String, Object?>? source,
      }) {
        server.append(text);
        server.messages.last
          ..['author'] = author
          ..['createdAt'] = start.add(after).toUtc().toIso8601String();
        if (source != null) server.messages.last['source'] = source;
      }

      say('Please fix the chat header.', ken, Duration.zero);
      say(
        'Routed to New agent · Claude opus high · Mac Studio',
        buddy,
        const Duration(seconds: 20),
        source: routeLine,
      );
      say(
        'The plan: test first, then the fix.',
        buddy,
        const Duration(seconds: 30),
      );
      say('A second line of the plan.', buddy, const Duration(seconds: 40));
      ((server.state['conversations'] as List)[0] as Map)['leadId'] = 'pm';
      final c = server.controller();
      await c.refresh();
      addTearDown(c.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) =>
              RepaintBoundary(key: picture, child: child),
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
    }

    testWidgets("the PM's name is inside its plan's row", (tester) async {
      await show(tester);
      Finder name(String id) => find.descendant(
        of: find.byKey(ValueKey('super-message-$id')),
        matching: find.text('River'),
      );
      expect(name('message-3'), findsOneWidget);
      // The next plain message still joins the plan's header.
      expect(name('message-4'), findsNothing);
    });

    for (final brightness in Brightness.values) {
      testWidgets('screenshot for review (${brightness.name})', (tester) async {
        final picture = GlobalKey();
        await show(tester, brightness: brightness, picture: picture);
        final boundary =
            picture.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        await tester.runAsync(() async {
          final image = await boundary.toImage(pixelRatio: 2);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          image.dispose();
          File('$shots/route-then-plan-${brightness.name}.png')
              .writeAsBytesSync(bytes!.buffer.asUint8List());
        });
      }, skip: shots == null);
    }
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
      // Slack's short time, so every time fits the gutter on one line
      // (Merlin's test: "10:01 AM" lost its AM there); the full time and
      // date are on its tooltip and in the row's label.
      final l10n = MaterialLocalizations.of(context);
      final local = TimeOfDay.fromDateTime(at);
      expect(
        tester.widget<Text>(time).data,
        '${l10n.formatHour(local)}:${l10n.formatMinute(local)}',
      );
      expect(tester.widget<Text>(time).softWrap, isFalse);
      expect(tester.getRect(time).right, lessThan(tester.getRect(body).left));
    });

    testWidgets('a grouped message reads its sender and time, as a header '
        'does', (tester) async {
      final semantics = tester.ensureSemantics();
      final server = await show(tester);
      final at = DateTime.parse(server.messages[2]['createdAt'] as String)
          .toLocal();
      final time = TimeOfDay.fromDateTime(at)
          .format(tester.element(find.text('Shall I merge it?')));
      expect(find.bySemanticsLabel(RegExp('^River, $time')), findsOneWidget);
      semantics.dispose();
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
