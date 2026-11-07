import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_link.dart';
import 'package:harness/super_tabs/message_row.dart' show SuperTabReplyPreview;
import 'package:harness/super_tabs/pane_layout.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/capture.dart';
import 'support/memory_key_value_store.dart';
import 'support/super_tab_fixture.dart';

/// Task #3787 (anh Dee, 11-06): the left rail, the project's Board in the middle and the person's Buddy on the right.
/// Opening a project shows its Board; a card's chat opens on the right, flat, with a way back to the Buddy; the
/// left rail has no Buddy entry and no Threads. Task #3863 keeps both side panes visible.

Future<void> _settle(WidgetTester tester) async {
  await tester.pumpAndSettle();
}

Finder _key(String k) => find.byKey(ValueKey(k));

void main() {
  final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];
  setUpAll(() => loadCaptureFonts(shots));

  Future<(SuperTabController, ConversationServer)> show(
    WidgetTester tester, {
    LocalKeyValueStore? store,
    Brightness brightness = Brightness.light,
    double width = 1500,
    bool projects = true,
    String selected = 'lead',
    double textScale = 1,
  }) async {
    await tester.binding.setSurfaceSize(Size(width, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final previous = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = previous);
    final server = swarm();
    if (!projects) server.state['projects'] = <dynamic>[];
    server.append('The project chat line nobody should see');
    final conversations = (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>();
    conversations.add({
      ...conversationFixture('buddy-owner-lead', 'Buddy'),
      'kind': 'buddy',
      'projectId': 'lead',
      'buddyOwnerId': 'owner',
      'agentIds': <String>[],
    });
    conversations.firstWhere((g) => g['id'] == 'offline')
      ..['number'] = 42
      ..['assignment'] = {
        'id': 'a1',
        'agentId': 'kestrel',
        'status': 'working',
      };
    server.append('Working on the fix.', conversationId: 'offline');
    server.append('What shall we work on?', conversationId: 'buddy-owner-lead');
    final c = server.controller(
      account: 'owner',
      initial: {
        'tabId': 'tab',
        'projectsGroupOpen': true,
        'accountId': 'owner',
        'selectedId': selected,
      },
    );
    await tester.runAsync(c.refresh);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
            paneStore: store ?? MemoryKeyValueStore(),
            board: true,
          ),
        ),
      ),
    );
    await _settle(tester);
    return (c, server);
  }

  Future<void> end(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    c.dispose();
    await tester.pump(const Duration(seconds: 5));
  }

  testWidgets('opening a project shows its Board, and the right pane is the '
      "person's Buddy, not the project chat", (tester) async {
    final (c, _) = await show(tester);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    expect(_key('super-tasks-lead'), findsOneWidget);
    expect(c.selectedId, 'buddy-owner-lead');
    expect(find.text('The project chat line nobody should see'), findsNothing);
    expect(_key('super-board-chat'), findsOneWidget);
    await end(tester, c);
  });

  testWidgets("a card's chat opens on the right beside the Board, and its "
      'header goes back to the Buddy', (tester) async {
    final (c, _) = await show(tester);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    // The wider chat leaves the Board narrower: it scrolls sideways to the card.
    await tester.ensureVisible(_key('super-task-card-offline'));
    await tester.tap(_key('super-task-card-offline'));
    await _settle(tester);
    expect(c.selectedId, 'offline');
    expect(_key('super-tasks-lead'), findsOneWidget, reason: 'the Board stays');
    expect(find.text('Working on the fix.'), findsOneWidget);
    await tester.tap(_key('super-board-chat-buddy'));
    await _settle(tester);
    expect(c.selectedId, 'buddy-owner-lead');
    expect(_key('super-tasks-lead'), findsOneWidget);
    await end(tester, c);
  });

  testWidgets("a card's chat is flat: its thread replies show inline, in time "
      'order, with no thread line', (tester) async {
    final (c, server) = await show(tester);
    final root =
        server.messages.lastWhere((m) => m['conversationId'] == 'offline')['id']
            as String;
    server.append('A reply in its thread.', conversationId: 'offline');
    server.messages.last['thread'] = root;
    await tester.runAsync(c.refresh);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    // The wider chat leaves the Board narrower: it scrolls sideways to the card.
    await tester.ensureVisible(_key('super-task-card-offline'));
    await tester.tap(_key('super-task-card-offline'));
    await _settle(tester);
    // The root, and its quote on the reply below.
    expect(find.text('Working on the fix.'), findsWidgets);
    expect(find.text('A reply in its thread.'), findsOneWidget);
    expect(find.textContaining('1 reply'), findsNothing);
    // Each reply says what it answers, as on the phone (Ken's review of the spec).
    expect(
      find.descendant(
        of: find.byType(SuperTabReplyPreview),
        matching: find.textContaining('Working on the fix.'),
      ),
      findsOneWidget,
    );
    await end(tester, c);
  });

  testWidgets('the project Chat tab opens its chat in the middle, with its '
      'header, and the Board tab brings back the three panes', (tester) async {
    final (c, _) = await show(tester);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    expect(_key('super-tasks-lead'), findsOneWidget);
    await tester.tap(_key('super-board-tab-chat'));
    await _settle(tester);
    expect(c.selectedId, 'lead');
    expect(
      find.text('The project chat line nobody should see'),
      findsOneWidget,
    );
    // The Chat view keeps its header and Project options; the Board tab is its one way back (audit finding 18 of #4436).
    expect(_key('super-tasks-lead'), findsNothing);
    expect(_key('super-project-menu'), findsOneWidget);
    expect(_key('super-tasks'), findsNothing);
    expect(_key('super-left-pane'), findsOneWidget);
    await tester.tap(_key('super-board-tab-board'));
    await _settle(tester);
    expect(_key('super-tasks-lead'), findsOneWidget);
    expect(c.selectedId, 'buddy-owner-lead');
    expect(_key('super-right-pane'), findsOneWidget);
    await end(tester, c);
  });

  testWidgets('the left rail has no Buddy entry and no Threads', (
    tester,
  ) async {
    final (c, _) = await show(tester);
    expect(_key('super-threads'), findsNothing);
    expect(_key('super-swarm-buddy'), findsNothing);
    expect(_key('super-group-buddy-owner-lead'), findsNothing);
    expect(find.text('Buddies'), findsNothing);
    await end(tester, c);
  });

  void expectFixedPanes(WidgetTester tester) {
    expect(_key('super-left-pane'), findsOneWidget);
    expect(_key('super-right-pane'), findsOneWidget);
    expect(tester.getSize(_key('super-left-pane')).width, greaterThan(0));
    expect(tester.getSize(_key('super-right-pane')).width, greaterThan(0));
    for (final tooltip in [
      'Show sidebar',
      'Hide sidebar',
      'Show your Buddy',
      'Hide your Buddy',
    ]) {
      expect(find.byTooltip(tooltip), findsNothing);
    }
  }

  void expectBlankMiddle() {
    expect(
      find.descendant(
        of: _key('super-center-pane'),
        matching: find.byWidgetPredicate(
          (w) =>
              w is Text ||
              w is TextField ||
              w is Icon ||
              w is ButtonStyleButton,
        ),
      ),
      findsNothing,
      reason: 'no conversation, header, controls or placeholder in the middle',
    );
  }

  for (final brightness in Brightness.values) {
    for (final width in [1280.0, 1920.0, 2560.0]) {
      testWidgets(
        'the right pane is a fixed 340 at $width wide (${brightness.name})',
        (tester) async {
          final (c, _) = await show(
            tester,
            width: width,
            brightness: brightness,
          );
          await tester.tap(_key('super-group-lead'));
          await _settle(tester);
          expect(tester.getSize(_key('super-right-pane')).width, 340);
          expectFixedPanes(tester);
          expect(_key('super-tasks-lead'), findsOneWidget);
          expect(tester.takeException(), isNull);
          await captureWindow(
            tester,
            shots,
            'fixed-board-${width.toInt()}-${brightness.name}',
          );
          await end(tester, c);
        },
      );
    }

    testWidgets('both panes return from saved hidden state and stay visible '
        'after remount (${brightness.name})', (tester) async {
      final store = MemoryKeyValueStore()
        ..values['swarm_left_pane_hidden'] = '1'
        ..values['swarm_right_pane_hidden'] = '1';
      for (var mount = 0; mount < 2; mount++) {
        final (c, _) = await show(tester, store: store, brightness: brightness);
        await tester.tap(_key('super-group-lead'));
        await _settle(tester);
        expectFixedPanes(tester);
        expect(_key('super-group-lead'), findsOneWidget);
        expect(_key('super-tasks-lead'), findsOneWidget);
        expect(find.text('What shall we work on?'), findsOneWidget);
        if (mount == 0) {
          await captureWindow(tester, shots, 'fixed-board-${brightness.name}');
        }
        expect(tester.takeException(), isNull);
        await end(tester, c);
      }
    });

    testWidgets('no project selected leaves a blank middle and Buddy on the '
        'right (${brightness.name})', (tester) async {
      final (c, _) = await show(
        tester,
        selected: 'buddy-owner-lead',
        brightness: brightness,
      );
      expectBlankMiddle();
      expectFixedPanes(tester);
      expect(
        find.descendant(
          of: _key('super-right-pane'),
          matching: find.text('What shall we work on?'),
        ),
        findsOneWidget,
      );
      await captureWindow(tester, shots, 'fixed-empty-${brightness.name}');
      await tester.tap(_key('super-group-lead'));
      await _settle(tester);
      expect(
        find.descendant(
          of: _key('super-center-pane'),
          matching: _key('super-tasks-lead'),
        ),
        findsOneWidget,
      );
      expectFixedPanes(tester);
      expect(tester.takeException(), isNull);
      await end(tester, c);
    });
  }

  testWidgets(
    'a Swarm with no projects has a blank middle and both side panes',
    (tester) async {
      final (c, _) = await show(
        tester,
        projects: false,
        selected: 'buddy-owner-lead',
      );
      expectBlankMiddle();
      expectFixedPanes(tester);
      expect(tester.takeException(), isNull);
      await end(tester, c);
    },
  );

  testWidgets('removing the open project clears only the middle', (
    tester,
  ) async {
    final (c, server) = await show(tester);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    server.state['projects'] = <dynamic>[];
    await tester.runAsync(c.refresh);
    await _settle(tester);
    expectBlankMiddle();
    expectFixedPanes(tester);
    expect(tester.takeException(), isNull);
    await end(tester, c);
  });

  /// Under 1000 the Board folds projects into their drawer, a menu button away (audit finding 12, #4445).
  void expectFoldedLeft(WidgetTester tester) {
    expect(_key('super-left-pane'), findsNothing);
    expect(find.byTooltip('Conversations'), findsOneWidget);
    expect(tester.getSize(_key('super-right-pane')).width, greaterThan(0));
  }

  testWidgets('the minimum Desktop window keeps the Board and chat, projects in their '
      'drawer', (tester) async {
    final (c, _) = await show(tester, width: 880);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    expectFoldedLeft(tester);
    expect(_key('super-tasks-lead'), findsOneWidget);
    // The Tasks pane gives back only what keeps the Board two columns (#4211).
    expect(
      tester.getSize(_key('super-right-pane')).width,
      880 - SuperTabPaneLayout.boardCenterWidth,
    );
    expect(tester.takeException(), isNull);
    await end(tester, c);
  });

  testWidgets(
    'the right pane keeps its width whatever width was saved, and has no '
    'divider',
    (tester) async {
      final store = MemoryKeyValueStore()
        ..values[SuperTabPaneLayout.storageKey] =
            '{"left":300,"right":280,"rightChosen":true}';
      final (c, _) = await show(tester, store: store);
      await tester.tap(_key('super-group-lead'));
      await _settle(tester);
      expect(tester.getSize(_key('super-right-pane')).width, 340);
      expect(_key('super-resize-right'), findsNothing);
      await tester.binding.setSurfaceSize(const Size(880, 900));
      await _settle(tester);
      // At the window minimum the Tasks pane gives back only what keeps the Board two columns (#4211).
      expect(
        tester.getSize(_key('super-right-pane')).width,
        880 - SuperTabPaneLayout.boardCenterWidth,
      );
      expectFoldedLeft(tester);
      expect(tester.takeException(), isNull);
      await end(tester, c);
    },
  );

  // Every way into the Board shows the same three panes (Scholes, task #3863).
  testWidgets('the Board tab of a project chat opens the Board with projects, '
      'the wide Buddy chat and the project kept', (tester) async {
    final (c, _) = await show(tester, width: 1500);
    // A person lands in the project's own chat, no Board open: that Chat
    // view's header has the Board tab, in place of a Tasks icon (#4444).
    expect(c.selectedId, 'lead');
    expect(_key('super-tasks-lead'), findsNothing);
    await tester.tap(_key('super-board-tab-board'));
    await _settle(tester);
    expect(_key('super-tasks-lead'), findsOneWidget);
    expect(c.selectedId, 'buddy-owner-lead');
    expect(_key('super-board-chat'), findsOneWidget);
    expect(find.text('Your Buddy'), findsOneWidget);
    expectFixedPanes(tester);
    expect(tester.getSize(_key('super-right-pane')).width, 340);
    expect(tester.takeException(), isNull);
    await end(tester, c);
  });

  testWidgets('a task chat opened from a notice shows its project Board '
      'beside it', (tester) async {
    final (c, server) = await show(tester, width: 1500);
    final message =
        server.messages.lastWhere((m) => m['conversationId'] == 'offline')['id']
            as String;
    c.openMessageLink(
      SwarmMessageLink(
        tabId: 'tab',
        conversationId: 'offline',
        messageId: message,
      ),
    );
    await _settle(tester);
    expect(c.selectedId, 'offline');
    expect(_key('super-tasks-lead'), findsOneWidget);
    expectFixedPanes(tester);
    expect(tester.takeException(), isNull);
    await end(tester, c);
  });

  // At enlarged text the side panes widen only while the Board keeps room:
  // the chat's scaled minimum shrinks back to 420 first, then projects to
  // their own minimum (reviews of #3399). The Board never goes blank.
  for (final (width, scale) in [
    (880.0, 1.25),
    (1024.0, 1.5),
    (880.0, 1.6),
    (1280.0, 2.0),
    (1500.0, 1.0),
  ]) {
    testWidgets('the Board keeps room at $width wide, text ${scale * 100}%', (
      tester,
    ) async {
      // From the Buddy: the fixed layout's own start, never the Chat view.
      final (c, _) = await show(
        tester,
        width: width,
        textScale: scale,
        selected: 'buddy-owner-lead',
      );
      await tester.tap(_key('super-group-lead'));
      await _settle(tester);
      // Under 1000 scaled, projects fold into their drawer.
      final folded = width < 1000 * scale;
      final left = folded ? 0.0 : tester.getSize(_key('super-left-pane')).width;
      final right = tester.getSize(_key('super-right-pane')).width;
      final center = tester.getSize(_key('super-center-pane')).width;
      if (!folded) expect(left, greaterThanOrEqualTo(180));
      expect(right, greaterThanOrEqualTo(SuperTabPaneLayout.rightWidth));
      expect(center, greaterThanOrEqualTo(280));
      expect(left + center + right, closeTo(width, 0.01));
      // The Board itself is drawn, not an empty centre.
      expect(_key('super-tasks-lead'), findsOneWidget);
      folded ? expectFoldedLeft(tester) : expectFixedPanes(tester);
      expect(tester.takeException(), isNull);
      await end(tester, c);
    });
  }

  if (Platform.environment['HARNESS_LAYOUT_BENCH'] == '1') {
    testWidgets('Board divider drag benchmark', (tester) async {
      final (c, _) = await show(tester);
      await tester.tap(_key('super-group-lead'));
      await _settle(tester);
      final drag = await tester.startGesture(
        tester.getCenter(_key('super-resize-right')),
      );
      await drag.moveBy(const Offset(-40, 0));
      await tester.pump();
      final samples = <int>[];
      for (var i = 0; i < 1100; i++) {
        final watch = Stopwatch()..start();
        await drag.moveBy(Offset(i.isEven ? -8 : 8, 0));
        await tester.pump();
        if (i >= 100) samples.add(watch.elapsedMicroseconds);
      }
      samples.sort();
      // ignore: avoid_print
      print(
        jsonEncode({
          'benchmark': 'board-divider-drag',
          'samples': samples.length,
          'p50_us': samples[500],
          'p95_us': samples[950],
        }),
      );
      await drag.up();
      await end(tester, c);
    });
  }
}
