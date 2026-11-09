import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'support/swarm_v4_data.dart';

/// An agent's chat bar and a project's (Swarm v4): the name, and where the agent runs, are cut with an ellipsis, so a long name
/// never pushes the buttons off the bar; a short name keeps what runs it beside it and the buttons at the bar's edge; and a
/// window under 720 keeps the way to the conversations in an agent's chat, as in a project's.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  const longName =
      'Second \u{2728} who owns voice, privacy, the offline queue and every lamp in lampOS, whatever it takes';

  /// The Swarm of lampOS at [size], with [chat] open; [names] are agents' ids and what their person calls them, [project] the
  /// first project's name.
  Future<void> show(
    WidgetTester tester,
    Size size, {
    String chat = 'agent-chat-second',
    Map<String, String> names = const {},
    String? project,
  }) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = swarmV4Server();
    for (final agent
        in (server.state['agents'] as List).cast<Map<String, dynamic>>()) {
      if (names[agent['id']] case final name?) agent['displayName'] = name;
    }
    if (project != null) {
      (server.state['projects'] as List)
              .cast<Map<String, dynamic>>()
              .first['name'] =
          project;
      (server.state['conversations'] as List)
              .cast<Map<String, dynamic>>()
              .firstWhere((g) => g['id'] == 'lead')['title'] =
          project;
    }
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
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
            github: swarmV4GitHub(),
            board: true,
          ),
        ),
      ),
    );
    await settle(tester);
  }

  /// Every one of the bar's [buttons] is on screen, inside the [bar].
  void expectButtons(WidgetTester tester, String bar, List<String> buttons) {
    final header = tester.getRect(key(bar));
    for (final button in buttons) {
      final rect = tester.getRect(key(button));
      expect(rect.left, greaterThanOrEqualTo(header.left), reason: button);
      expect(rect.right, lessThanOrEqualTo(header.right), reason: button);
    }
  }

  const agentButtons = ['swarm-instructions-button', 'swarm-terminal-button'];

  testWidgets(
    'an agent with a very long name, an emoji in it, is cut with an ellipsis, and its bar keeps Instructions and Terminal',
    (tester) async {
      await show(tester, const Size(1080, 700), names: {'second': longName});
      expect(tester.takeException(), isNull);
      expectButtons(tester, 'swarm-agent-header', agentButtons);
      final name = tester.widget<Text>(key('swarm-agent-name'));
      expect(name.maxLines, 1);
      expect(name.overflow, TextOverflow.ellipsis);
      // The name ends before the first button, and so does where the agent runs.
      final first = tester.getRect(key('swarm-instructions-button'));
      expect(
        tester.getRect(key('swarm-agent-name')).right,
        lessThanOrEqualTo(first.left),
      );
      expect(
        tester.getRect(find.text('Mac Studio · Claude Code')).right,
        lessThanOrEqualTo(first.left),
      );
    },
  );

  testWidgets('a project\'s PM too', (tester) async {
    await show(
      tester,
      const Size(1080, 700),
      chat: 'agent-chat-first builder',
      names: {'first builder': longName},
    );
    expect(tester.takeException(), isNull);
    expectButtons(tester, 'swarm-agent-header', agentButtons);
  });

  testWidgets(
    'a project with a very long name keeps its Find, Tasks and options on its bar',
    (tester) async {
      await show(
        tester,
        const Size(1080, 700),
        chat: 'lead',
        project: longName,
      );
      expect(tester.takeException(), isNull);
      for (final button in [
        'super-find-button',
        'swarm-tasks-button',
        'super-project-menu',
      ]) {
        expect(key(button), findsOneWidget, reason: button);
        expect(tester.getRect(key(button)).right, lessThanOrEqualTo(1080));
      }
    },
  );

  testWidgets(
    'a short name keeps where the agent runs beside it, and the buttons end at the same edge as with a long name',
    (tester) async {
      await show(tester, const Size(1440, 900));
      final detail = tester.getRect(find.text('Mac Studio · Claude Code'));
      expect(
        detail.left - tester.getRect(key('swarm-agent-name')).right,
        lessThanOrEqualTo(16),
      );
      double edge() =>
          tester.getRect(key('swarm-agent-header')).right -
          tester.getRect(key('swarm-terminal-button')).right;
      final short = edge();
      await show(tester, const Size(1440, 900), names: {'second': longName});
      expect(edge(), moreOrLessEquals(short, epsilon: .5));
    },
  );

  for (final size in const [
    Size(1080, 700),
    Size(1024, 700),
    Size(700, 800),
    Size(480, 800),
  ]) {
    testWidgets(
      'a long name at ${size.width.toInt()}x${size.height.toInt()} leaves the bar whole, and a window under 720 still reaches the conversations',
      (tester) async {
        await show(tester, size, names: {'second': longName});
        if (size.width < 720) {
          // The list of conversations is behind the bar's button: open it, choose the agent, and the bar has the button again.
          await tester.tap(find.byTooltip('Conversations'));
          await settle(tester);
          await tester.tap(key('super-agent-second'));
          await settle(tester);
          expect(find.byTooltip('Conversations'), findsOneWidget);
          await tester.tap(find.byTooltip('Conversations'));
          await settle(tester);
          expect(key('super-agent-third'), findsOneWidget);
          await tester.tap(key('super-agent-second'));
          await settle(tester);
        }
        expect(tester.takeException(), isNull);
        expectButtons(tester, 'swarm-agent-header', agentButtons);
      },
    );
  }
}

/// Settles, and lets the read mark a chat saves 200 ms after it is read go, so no timer outlives the test.
Future<void> settle(WidgetTester tester) async {
  await tester.pumpAndSettle();
  await tester.pump(const Duration(milliseconds: 300));
}
