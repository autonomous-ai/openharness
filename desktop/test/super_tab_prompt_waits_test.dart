import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/activity.dart';
import 'package:harness/super_tabs/decisions_page.dart';

import 'super_tab_activity_lists_test.dart' show load, swarm;
import 'support/super_tab_fixture.dart';

// Task #3029 (Gray, 11-05): an agent in a task waiting at a prompt in its
// terminal reaches the task's person under Decisions, with its last lines and
// a button to its terminal, and leaves once it moves on.

final _now = DateTime(2026, 11, 5, 10, 30);

const _screen =
    'Pairing the iPhone with the board.\n'
    'Open Settings > Glinks on the iPhone, check the password,\n'
    'press Connect, then tell me "connect rồi".\n'
    '\n'
    '> \n';

/// Wren, at a prompt in its task "Flash the board", as the backend lists it
/// for the reader (backend superTabs/promptWaits.ts).
void wrenAtPrompt(ConversationServer server, {bool screen = true}) {
  server.state['agents'] = [
    ...(server.state['agents'] as List),
    {
      'id': 'wren',
      'projectId': 'lead',
      'name': 'Builder',
      'displayName': 'Wren',
      'machineId': 'host',
      'harnessId': 'wren',
      'contributorId': 'owner',
      'configuration': {'engine': 'claude'},
      'alerting': ['prompt'],
    },
  ];
  (server.state['conversations'] as List).add(<String, dynamic>{
    ...conversationFixture('flash', 'Flash the board'),
    'projectId': 'lead',
    'agentIds': ['wren'],
    'requesterId': 'owner',
    'assignment': {'id': 'a1', 'agentId': 'wren', 'status': 'working'},
  });
  server.state['promptsWaiting'] = [
    {
      'agentId': 'wren',
      'agentName': 'Wren',
      'conversationId': 'flash',
      'conversationTitle': 'Flash the board',
      'projectId': 'lead',
      'projectName': 'web-project',
    },
  ];
  if (screen) server.screens['wren'] = _screen;
}

Future<SuperTabActivity> _loaded(
  WidgetTester tester,
  ConversationServer server,
) async => (await tester.runAsync(() => load(server)))!;

Future<List<String>> _show(
  WidgetTester tester,
  SuperTabActivity activity, {
  Brightness brightness = Brightness.dark,
  String? highlight,
}) async {
  await tester.binding.setSurfaceSize(const Size(900, 700));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final opened = <String>[];
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: SuperTabDecisionsPage(
          activity: activity,
          onOpenConversation: opened.add,
          highlight: highlight,
          now: () => _now,
        ),
      ),
    ),
  );
  // The last lines come from a screen read: let it answer.
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 80)),
  );
  await tester.pumpAndSettle();
  return opened;
}

Finder _key(String key) => find.byKey(ValueKey(key));

void main() {
  testWidgets('an agent at a prompt in the reader\'s task is a Decisions row '
      'with its task and last lines, counted, that opens its terminal', (
    tester,
  ) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      wrenAtPrompt(server);
      final activity = await _loaded(tester, server);
      expect(activity.needsCount, 1);
      final opened = await _show(tester, activity);
      final row = _key('super-activity-row-prompt:wren');
      expect(row, findsOneWidget);
      expect(
        find.descendant(
          of: row,
          matching: find.text('Wren is waiting at a prompt in its terminal'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(of: row, matching: find.text('Flash the board')),
        findsOneWidget,
      );
      // Its last lines, as its terminal shows them, blank ones trimmed.
      final lines = _key('super-prompt-lines:wren');
      expect(
        tester
            .widget<Text>(
              find.descendant(of: lines, matching: find.byType(Text)),
            )
            .data,
        'Pairing the iPhone with the board.\n'
        'Open Settings > Glinks on the iPhone, check the password,\n'
        'press Connect, then tell me "connect rồi".\n'
        '>',
      );
      await tester.tap(_key('super-prompt-open:wren'));
      await tester.pumpAndSettle();
      expect(opened, ['flash']);
      expect(activity.controller.agentTerminalRequest, (
        agentId: 'wren',
        conversationId: 'flash',
      ));
    });
  });

  testWidgets('the row leaves Decisions, and its count, once the agent moves '
      'on', (tester) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      wrenAtPrompt(server);
      final activity = await _loaded(tester, server);
      await _show(tester, activity);
      expect(_key('super-activity-row-prompt:wren'), findsOneWidget);
      server.state['promptsWaiting'] = <dynamic>[];
      await tester.runAsync(activity.controller.refresh);
      await tester.pumpAndSettle();
      expect(_key('super-activity-row-prompt:wren'), findsNothing);
      expect(activity.needsCount, 0);
      expect(find.text('Nothing needs you'), findsOneWidget);
    });
  });

  testWidgets('a terminal the reader may not read keeps the row and says so', (
    tester,
  ) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()
        ..followedThreads = null
        ..refuseScreens = true;
      wrenAtPrompt(server);
      await _show(tester, await _loaded(tester, server));
      expect(_key('super-activity-row-prompt:wren'), findsOneWidget);
      expect(
        find.text(
          'Its terminal isn\'t shown to you. Open the task to answer it.',
        ),
        findsOneWidget,
      );
      expect(_key('super-prompt-lines:wren'), findsNothing);
    });
    // Its machine did not answer: the row says that instead.
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      wrenAtPrompt(server, screen: false);
      await _show(tester, await _loaded(tester, server));
      expect(find.text('Its last lines could not be read.'), findsOneWidget);
    });
  });

  testWidgets('opening Decisions for one need lights its row for a moment', (
    tester,
  ) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      server.ask(['Ship it behind a flag?', 'Keep the old route?']);
      final activity = await _loaded(tester, server);
      await _show(tester, activity, highlight: 'decision:decision-2');
      expect(_key('super-activity-lit:decision:decision-2'), findsOneWidget);
      expect(_key('super-activity-lit:decision:decision-1'), findsNothing);
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(_key('super-activity-lit:decision:decision-2'), findsNothing);
    });
  });
}
