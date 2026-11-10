import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/chat/bubble.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/day_pill.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';
import 'support/swarm_v4_data.dart';

/// Swarm v4's chat is a column (anh Dee 2026-11-09, mockups Main and TwoPanes): its rows, its day lines, its New messages
/// line and its composer share one column of at most 720, centred in the chat's pane; a narrower pane keeps the 24 each side
/// that its rows and its composer already inset by; the header and the scrollbar stay at the pane's edges; and two panes
/// share the width half and half, the column centred in its half.
void main() {
  const column = 720.0, gutter = 24.0, window = 1800.0;
  Finder key(String k) => find.byKey(ValueKey(k));

  /// Settles, and lets the read mark the chat saves 200 ms after it is read go, so no timer outlives the test.
  Future<void> settle(WidgetTester tester) async {
    await tester.pumpAndSettle();
    await tester.pump(const Duration(milliseconds: 300));
  }

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    double width = window,
    String chat = 'agent-chat-second',
    Widget? terminal,
  }) async {
    await tester.binding.setSurfaceSize(Size(width, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final c = server.controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': chat},
    );
    addTearDown(c.dispose);
    await tester.runAsync(c.refresh);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
            github: swarmV4GitHub(),
            terminal: terminal,
          ),
        ),
      ),
    );
    await settle(tester);
    return c;
  }

  Rect centre(WidgetTester tester) => tester.getRect(key('super-center-pane'));

  /// Every row the chat draws is [width] wide and centred in [pane].
  void expectRows(WidgetTester tester, Rect pane, double width) {
    final rows = find.descendant(
      of: key('super-center-pane'),
      matching: find.byType(SuperTabMessageRow),
    );
    expect(rows, findsWidgets);
    for (var i = 0; i < rows.evaluate().length; i++) {
      final rect = tester.getRect(rows.at(i));
      expect(rect.width, moreOrLessEquals(width, epsilon: .5), reason: '$i');
      expect(
        rect.center.dx,
        moreOrLessEquals(pane.center.dx, epsilon: .5),
        reason: '$i',
      );
    }
  }

  /// The chat and the pane beside it share the window less the left pane half and half, whatever is beside it, and the
  /// chat's column fills its half or is centred in it.
  void expectHalves(WidgetTester tester, {double width = window}) {
    final left = tester.getRect(key('super-left-pane'));
    final pane = centre(tester);
    final right = tester.getRect(key('super-right-pane'));
    expect(right.width, moreOrLessEquals(pane.width, epsilon: 1));
    expect(
      right.width + pane.width,
      moreOrLessEquals(width - left.width, epsilon: 1),
    );
    expectRows(tester, pane, math.min(column, pane.width));
  }

  testWidgets(
    'in a wide pane the chat is one 720 column, centred: its rows, its day line and its composer, under a full-width header and list',
    (tester) async {
      await show(tester, swarmV4Server());
      final pane = centre(tester);
      expect(pane.width, greaterThan(column + 2 * gutter));
      expectRows(tester, pane, column);
      // The day line's rules run the column less its gutters, and its day is in the middle.
      expect(find.byType(SuperTabDayLabel), findsWidgets);
      expect(
        tester.getCenter(find.byType(SuperTabDayLabel).first).dx,
        moreOrLessEquals(pane.center.dx, epsilon: .5),
      );
      final rules = find.descendant(
        of: find.byType(SuperTabDayMark).first,
        matching: find.byType(Divider),
      );
      expect(
        tester.getRect(rules.first).left,
        moreOrLessEquals(pane.center.dx - column / 2 + gutter, epsilon: .5),
      );
      expect(
        tester.getRect(rules.last).right,
        moreOrLessEquals(pane.center.dx + column / 2 - gutter, epsilon: .5),
      );
      // The composer's pill and its send keep those gutters inside the column.
      final composer = tester.getRect(key('super-message-composer-actions'));
      expect(
        composer.width,
        moreOrLessEquals(column - 2 * gutter, epsilon: .5),
      );
      expect(composer.center.dx, moreOrLessEquals(pane.center.dx, epsilon: .5));
      // The list, whose scrollbar is its own edge, and the header keep the pane's whole width.
      final list = tester.getRect(
        find.byKey(
          const PageStorageKey('super-messages-tab-agent-chat-second'),
        ),
      );
      expect(list.left, moreOrLessEquals(pane.left, epsilon: .5));
      expect(list.right, moreOrLessEquals(pane.right, epsilon: .5));
      final header = tester.getRect(key('swarm-agent-header'));
      expect(header.left, moreOrLessEquals(pane.left, epsilon: .5));
      expect(header.right, moreOrLessEquals(pane.right, epsilon: .5));
    },
  );

  testWidgets('the New messages line is in the column too', (tester) async {
    final server = swarmV4Server();
    final first = server.messages.firstWhere(
      (m) => m['conversationId'] == 'agent-chat-second',
    );
    // What its person wrote is read; the agent's answer after it is new.
    server.markReadElsewhere('agent-chat-second', first['sequence'] as int);
    await show(tester, server);
    expect(key('super-new-messages-line'), findsOneWidget);
    final rect = tester.getRect(key('super-new-messages-line'));
    expect(rect.width, moreOrLessEquals(column, epsilon: .5));
    expect(
      rect.center.dx,
      moreOrLessEquals(centre(tester).center.dx, epsilon: .5),
    );
  });

  testWidgets(
    'a project\'s channel is the same column, and its agents-only line takes the composer\'s place in it',
    (tester) async {
      await show(tester, swarmV4Server(), chat: 'lead');
      expectRows(tester, centre(tester), column);
      final line = tester.getRect(key('super-agents-only'));
      expect(line.width, moreOrLessEquals(column, epsilon: .5));
      expect(
        line.center.dx,
        moreOrLessEquals(centre(tester).center.dx, epsilon: .5),
      );
    },
  );

  testWidgets('in a narrow pane the column fills it, 24 in from each side', (
    tester,
  ) async {
    // 1000 wide: the left pane takes 300 and the chat has the other 700, under what a column holds.
    await show(tester, swarmV4Server(), width: 1000);
    final pane = centre(tester);
    expect(pane.width, lessThan(column));
    expectRows(tester, pane, pane.width);
    final composer = tester.getRect(key('super-message-composer-actions'));
    expect(composer.left, moreOrLessEquals(pane.left + gutter, epsilon: .5));
    expect(composer.right, moreOrLessEquals(pane.right - gutter, epsilon: .5));
  });

  testWidgets(
    'the mention choices under the list are in the column too, and so is a reply being written',
    (tester) async {
      final server = swarmV4Server();
      // A message from before threads keeps its inline reply, which the chat shows as a line above the composer.
      server.threads = false;
      server.append(
        'Did the memory retest finish?',
        conversationId: 'agent-chat-third',
      );
      server.messages.last['author'] = {
        'kind': 'agent',
        'id': 'third',
        'name': 'third',
      };
      await show(tester, server, chat: 'agent-chat-third');
      final inner = column / 2 - gutter;
      final pane = centre(tester);
      // Tagging: the choices list takes the column's width less the gutters.
      await tester.enterText(key('super-message-composer'), '@t');
      await tester.pump();
      final choices = tester.getRect(key('super-composer-completions'));
      expect(choices.left, greaterThanOrEqualTo(pane.center.dx - inner - .5));
      expect(choices.right, lessThanOrEqualTo(pane.center.dx + inner + .5));
      await tester.enterText(key('super-message-composer'), '');
      await tester.pump();
      // Reply: the mouse rests on the message, its toolbar shows, and Reply is clicked.
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      addTearDown(mouse.removePointer);
      await mouse.moveTo(
        tester.getCenter(find.text('Did the memory retest finish?')),
      );
      await tester.pumpAndSettle();
      await mouse.moveTo(tester.getCenter(find.byTooltip('Reply')));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Reply'));
      await settle(tester);
      final preview = tester.getRect(find.byType(SuperTabReplyPreview));
      expect(preview.left, greaterThanOrEqualTo(pane.center.dx - inner - .5));
      expect(preview.right, lessThanOrEqualTo(pane.center.dx + inner + .5));
    },
  );

  group('two panes share the width half and half, and the column is centred in the chat\'s half', () {
    testWidgets('chat and terminal', (tester) async {
      await show(
        tester,
        swarmV4Server(),
        terminal: const Center(child: Text('Terminal fixture')),
      );
      expect(
        find.descendant(
          of: key('super-right-pane'),
          matching: find.text('Terminal fixture'),
        ),
        findsOneWidget,
      );
      expect(centre(tester).width, greaterThan(column));
      expectHalves(tester);
    });

    testWidgets('chat and instructions', (tester) async {
      await show(tester, swarmV4Server());
      await tester.tap(key('swarm-instructions-button'));
      await settle(tester);
      expect(key('swarm-instructions-close'), findsOneWidget);
      expect(centre(tester).width, greaterThan(column));
      expectHalves(tester);
    });

    testWidgets('a project\'s channel and a task\'s thread', (tester) async {
      final server = swarmV4Server();
      final c = await show(tester, server, chat: 'lead');
      c.openThread(
        server.messages.firstWhere(
              (m) => (m['text'] as String).startsWith('#2191'),
            )['id']
            as String,
      );
      await settle(tester);
      expect(key('super-thread-panel'), findsOneWidget);
      expect(centre(tester).width, greaterThan(column));
      expectHalves(tester);
    });

    testWidgets('a project\'s channel, its tasks, and one task', (
      tester,
    ) async {
      await show(tester, swarmV4Server(), chat: 'lead');
      await tester.tap(key('swarm-tasks-button'));
      await settle(tester);
      expect(key('swarm-task-board'), findsOneWidget);
      expect(centre(tester).width, greaterThan(column));
      expectHalves(tester);
      await tester.tap(key('swarm-task-5759'));
      await settle(tester);
      expect(key('swarm-issue-panel'), findsOneWidget);
      expect(centre(tester).width, greaterThan(column));
      expectHalves(tester);
    });
  });

  /// Every bubble in the chat's pane sits inside the column's gutters: nothing a person sends or reads runs past them.
  void expectBubblesInside(WidgetTester tester, Rect pane) {
    final inner = math.min(column, pane.width) / 2 - gutter;
    final bubbles = find.descendant(
      of: key('super-center-pane'),
      matching: find.byType(SwarmBubble),
    );
    expect(bubbles, findsWidgets);
    for (var i = 0; i < bubbles.evaluate().length; i++) {
      final rect = tester.getRect(bubbles.at(i));
      expect(rect.left, greaterThanOrEqualTo(pane.center.dx - inner - .5));
      expect(rect.right, lessThanOrEqualTo(pane.center.dx + inner + .5));
    }
  }

  testWidgets(
    'journey: a person opens an agent with nothing said, writes an emoji and a very long line, opens its instructions and closes them, and the chat is one column all the way',
    (tester) async {
      final server = swarmV4Server();
      await show(tester, server, width: 1440, chat: 'lead');
      // The project's channel first: its agents-only line is where a composer would be.
      expect(key('super-agents-only'), findsOneWidget);
      await tester.tap(key('super-agent-third'));
      await settle(tester);
      // Nothing said yet shows nothing, and the composer is already in the column.
      expect(find.byType(SuperTabMessageRow), findsNothing);
      expect(find.byType(SuperTabDayLabel), findsNothing);
      final composer = tester.getRect(key('super-message-composer-actions'));
      expect(
        composer.width,
        moreOrLessEquals(column - 2 * gutter, epsilon: .5),
      );
      Future<void> send(String text) async {
        await tester.enterText(key('super-message-composer'), text);
        await tester.pump();
        await tester.tap(find.byTooltip('Send message'));
        await settle(tester);
      }

      const hello = 'hello 👀🙏 can you start on the busy room?';
      final long = 'x' * 900;
      await send(hello);
      await send(long);
      expect(tester.takeException(), isNull);
      expect(
        [
          for (final m in server.messages)
            if (m['conversationId'] == 'agent-chat-third') m['text'],
        ],
        [hello, long],
      );
      expectRows(tester, centre(tester), column);
      expectBubblesInside(tester, centre(tester));
      // Its instructions open beside it: half and half, the column filling its half.
      await tester.tap(key('swarm-instructions-button'));
      await settle(tester);
      expect(key('swarm-instructions-close'), findsOneWidget);
      expectHalves(tester, width: 1440);
      expectBubblesInside(tester, centre(tester));
      expect(tester.takeException(), isNull);
      // Closed again, the column takes the pane back.
      await tester.tap(key('swarm-instructions-close'));
      await settle(tester);
      expect(key('swarm-instructions-close'), findsNothing);
      expectRows(tester, centre(tester), column);
      expectBubblesInside(tester, centre(tester));
    },
  );

  group('trying to break it', () {
    testWidgets(
      'clicking Instructions as fast as a person can leaves one pane, half and half, and one click more closes it',
      (tester) async {
        await show(tester, swarmV4Server());
        for (var i = 0; i < 7; i++) {
          await tester.tap(key('swarm-instructions-button'));
          await tester.pump();
        }
        await settle(tester);
        expect(key('swarm-instructions-close'), findsOneWidget);
        expectHalves(tester);
        await tester.tap(key('swarm-instructions-button'));
        await settle(tester);
        expect(key('swarm-instructions-close'), findsNothing);
        expectRows(tester, centre(tester), column);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'switching between chats and channels as fast as a person can leaves the column whole',
      (tester) async {
        await show(tester, swarmV4Server());
        for (final id in [
          'super-agent-third',
          'super-group-lead',
          'super-agent-second',
          'super-agent-first builder',
          'super-group-lead',
          'super-agent-second',
        ]) {
          await tester.tap(key(id));
          await tester.pump();
        }
        await settle(tester);
        expect(tester.takeException(), isNull);
        expectRows(tester, centre(tester), column);
        expectBubblesInside(tester, centre(tester));
        final composer = tester.getRect(key('super-message-composer-actions'));
        expect(
          composer.width,
          moreOrLessEquals(column - 2 * gutter, epsilon: .5),
        );
      },
    );

    testWidgets(
      'a window dragged narrower and wider keeps the column: 1800, 1000, the 880 the app holds at least, 700, and back',
      (tester) async {
        await show(tester, swarmV4Server());
        for (final width in [1800.0, 1000.0, 880.0, 700.0, 1800.0]) {
          await tester.binding.setSurfaceSize(Size(width, 900));
          await settle(tester);
          final pane = centre(tester);
          expect(tester.takeException(), isNull, reason: '$width');
          expectRows(tester, pane, math.min(column, pane.width));
          expectBubblesInside(tester, pane);
          final composer = tester.getRect(
            key('super-message-composer-actions'),
          );
          expect(
            composer.width,
            moreOrLessEquals(
              math.min(column, pane.width) - 2 * gutter,
              epsilon: .5,
            ),
            reason: '$width',
          );
          expect(
            composer.center.dx,
            moreOrLessEquals(pane.center.dx, epsilon: .5),
          );
        }
      },
    );

    testWidgets(
      'two panes in the narrowest window that shows them (1080 wide) are half and half, with nothing overflowing',
      (tester) async {
        await show(tester, swarmV4Server(), width: 1080);
        await tester.tap(key('swarm-instructions-button'));
        await settle(tester);
        expect(key('swarm-instructions-close'), findsOneWidget);
        expectHalves(tester, width: 1080);
        expectBubblesInside(tester, centre(tester));
        expect(tester.takeException(), isNull);
      },
    );
  });
}
